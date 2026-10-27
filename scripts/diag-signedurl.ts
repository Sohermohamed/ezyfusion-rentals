/**
 * scripts/diag-signedurl.ts  
 * Diagnose Supabase Storage signed URL format and behavior.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

async function main() {
  const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  const JWT_SVC = process.env.SUPABASE_SERVICE_ROLE_JWT!

  // Login as NW manager to get a token for upload
  const lr = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: JSON.stringify({ email: 'manager@northwind.test', password: 'Seed1234!' }),
  })
  const { access_token } = await lr.json() as { access_token: string }

  // Get org ID
  const orgsR = await fetch(`${URL_BASE}/rest/v1/organizations?select=id,name`, {
    headers: { apikey: JWT_SVC, Authorization: `Bearer ${JWT_SVC}` },
  })
  const orgs = await orgsR.json() as { id: string; name: string }[]
  const nwOrgId = orgs.find(o => o.name === 'Northwind Properties')?.id ?? ''
  console.log('NW org:', nwOrgId)

  const testPath = `${nwOrgId}/diag-signed-url-test.jpg`

  // Upload
  const up = await fetch(`${URL_BASE}/storage/v1/object/payment-slips/${testPath}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${access_token}`, 'Content-Type': 'image/jpeg' },
    body: 'diag-content-xyz',
  })
  console.log('Upload:', up.status, await up.text())

  // Create signed URL using JWT service role
  const signRes = await fetch(`${URL_BASE}/storage/v1/object/sign/payment-slips/${testPath}`, {
    method: 'POST',
    headers: { apikey: JWT_SVC, Authorization: `Bearer ${JWT_SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  })
  const signText = await signRes.text()
  console.log('Sign response status:', signRes.status)
  console.log('Sign response raw:', signText)

  if (signRes.ok) {
    const parsed = JSON.parse(signText) as { signedURL?: string; signedUrl?: string; data?: unknown }
    const rel = parsed.signedURL ?? parsed.signedUrl ?? ''
    console.log('Relative signed URL:', rel)
    const fullUrl = rel.startsWith('http') ? rel : `${URL_BASE}${rel}`
    console.log('Full signed URL:', fullUrl)

    // Try to download
    const dl = await fetch(fullUrl)
    console.log('Download status:', dl.status)
    const dlText = await dl.text()
    console.log('Download body:', dlText.slice(0, 100))

    // Also try without the base URL prefix (in case URL is already full)
    if (!rel.startsWith('http')) {
      const dl2 = await fetch(rel)
      console.log('Download (relative only) status:', dl2.status)
    }
  }

  // Alternative: try the /storage/v1/object/authenticated/ endpoint  
  const authDl = await fetch(`${URL_BASE}/storage/v1/object/authenticated/payment-slips/${testPath}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${access_token}` },
  })
  console.log('\nAuthenticated download status:', authDl.status)

  // Cleanup
  const del = await fetch(`${URL_BASE}/storage/v1/object/payment-slips/${testPath}`, {
    method: 'DELETE', headers: { apikey: JWT_SVC, Authorization: `Bearer ${JWT_SVC}` },
  })
  console.log('Cleanup delete:', del.status)
}

main().catch(e => { console.error(e); process.exit(1) })
