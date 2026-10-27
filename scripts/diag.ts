/**
 * Diagnose the lease creation 500 + fix signed URL check
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

import { getPrisma } from '../lib/prisma.js'

async function main() {
  const prisma = getPrisma()
  const SK = process.env.SUPABASE_SECRET_KEY!
  const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

  // Check existing leases
  const leases = await prisma.lease.findMany({
    include: { unit: true, tenant: true },
  })
  for (const l of leases) {
    console.log(`Unit ${l.unit.name} | Tenant ${l.tenant.fullName} | ${l.startDate.toISOString().slice(0,10)} → ${l.endDate.toISOString().slice(0,10)}`)
  }

  // Check what probe tenant ID maps to in DB
  const probe = await prisma.tenant.findFirst({ where: { email: 'probe@northwind.test' } })
  console.log('\nProbe tenant:', probe?.id, probe?.fullName)

  // The issue: probe tenant already has a lease on C-01-7 (2026-02-28 to 2027-02-27)
  // The lease creation for D-03-2 with probe tenant should work since D-03-2 is free
  // But the error was 500, not 409. Let's check if it's a UUID cast issue.

  // Check D-03-2 unit
  const d032 = await prisma.unit.findFirst({ where: { name: 'D-03-2' } })
  console.log('\nD-03-2 unit:', d032?.id, 'orgId:', d032?.orgId)

  // Try creating directly via Prisma to see actual error
  try {
    await prisma.lease.create({
      data: {
        orgId: d032!.orgId,
        unitId: d032!.id,
        tenantId: probe!.id,
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-05-31'),
        monthlyRentSen: 10000n,
        depositSen: 0n,
      }
    })
    console.log('Prisma direct create: SUCCEEDED')
  } catch(e) {
    console.log('Prisma direct create error:', e instanceof Error ? e.message : String(e))
  }

  // Check signed URL format
  const testPath = `${d032!.orgId}/diag-test.jpg`
  // First upload something
  const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  const managerLoginRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: JSON.stringify({ email: 'manager@northwind.test', password: 'Seed1234!' }),
  })
  const { access_token } = await managerLoginRes.json() as { access_token: string }

  const uploadRes = await fetch(`${URL}/storage/v1/object/payment-slips/${testPath}`, {
    method: 'POST',
    headers: { 'apikey': KEY, 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'image/jpeg' },
    body: 'diag-content',
  })
  console.log('\nUpload status:', uploadRes.status)

  const signRes = await fetch(`${URL}/storage/v1/object/sign/payment-slips/${testPath}`, {
    method: 'POST',
    headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  })
  console.log('Sign API status:', signRes.status)
  const signBody = await signRes.text()
  console.log('Sign API body:', signBody)

  // Parse and try to use the signed URL
  try {
    const parsed = JSON.parse(signBody) as { signedURL?: string; signedUrl?: string; data?: { signedUrl?: string } }
    const signedUrl = parsed.signedURL ?? parsed.signedUrl ?? parsed.data?.signedUrl ?? ''
    console.log('Signed URL:', signedUrl.slice(0, 100))
    if (signedUrl) {
      const fullUrl = signedUrl.startsWith('http') ? signedUrl : `${URL}${signedUrl}`
      console.log('Full URL:', fullUrl.slice(0, 100))
      const dlRes = await fetch(fullUrl)
      console.log('Download with signed URL:', dlRes.status)
    }
  } catch {}

  // Cleanup
  await fetch(`${URL}/storage/v1/object/payment-slips/${testPath}`, {
    method: 'DELETE', headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}` },
  })

  await prisma.$disconnect?.()
}

main().catch(e => { console.error(e); process.exit(1) })
