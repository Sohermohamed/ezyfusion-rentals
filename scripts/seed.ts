/**
 * scripts/seed.ts
 * Seeds the database with required test data.
 * Run with: npm run seed
 *
 * All seeded accounts share password: Seed1234!
 */

// Load env FIRST before any other imports that might use env vars
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { createClient } from '@supabase/supabase-js'
import { PrismaClient } from '../app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { generateSchedule } from '../lib/billing'
import { allocate } from '../lib/allocation'
import type { PrismaClient as PrismaClientType } from '../app/generated/prisma/client'

type Tx = Omit<PrismaClientType, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

const SEED_PASSWORD = 'Seed1234!'

function getPrisma(): PrismaClientType {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  return new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]) as unknown as PrismaClientType
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY!

async function main() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL?.replace(/:.*@/, ':***@'))
  console.log('SUPABASE_URL:', SUPABASE_URL)

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY. Check .env.local')
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL. Check .env.local')
  }

  const prisma = getPrisma()

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  async function createUser(email: string, fullName: string): Promise<string> {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (error) {
      // Already exists — find by listing
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 100 })
      const existing = list?.users.find((u) => u.email === email)
      if (existing) return existing.id
      throw new Error(`Failed to create user ${email}: ${error.message}`)
    }
    return data.user.id
  }

  console.log('Seeding database...')

  // ============================================================
  // ORGANIZATIONS
  // ============================================================
  const northwind = await prisma.organization.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: { name: 'Northwind Properties' },
    create: { id: '00000000-0000-0000-0000-000000000001', name: 'Northwind Properties' },
  })
  const beta = await prisma.organization.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: { name: 'Beta Realty' },
    create: { id: '00000000-0000-0000-0000-000000000002', name: 'Beta Realty' },
  })
  console.log('Organizations:', northwind.name, beta.name)

  // ============================================================
  // AUTH USERS
  // ============================================================
  const [nwMgrId, nwStaffId, aisyahUid, benUid, probeUid, betaMgrId, chenUid] = await Promise.all([
    createUser('manager@northwind.test', 'Northwind Manager'),
    createUser('staff@northwind.test', 'Northwind Staff'),
    createUser('aisyah@northwind.test', 'Aisyah Rahman'),
    createUser('ben@northwind.test', 'Ben Lim'),
    createUser('probe@northwind.test', 'Probe Tenant'),
    createUser('manager@beta.test', 'Beta Manager'),
    createUser('chen@beta.test', 'Chen Wei'),
  ])
  console.log('Auth users ready')

  // ============================================================
  // MEMBERSHIPS
  // ============================================================
  await prisma.$executeRaw`
    INSERT INTO memberships (user_id, org_id, role)
    VALUES
      (${nwMgrId}::uuid,    ${northwind.id}::uuid, 'manager'),
      (${nwStaffId}::uuid,  ${northwind.id}::uuid, 'staff'),
      (${betaMgrId}::uuid,  ${beta.id}::uuid,      'manager')
    ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role
  `

  // ============================================================
  // TENANTS
  // ============================================================
  async function upsertTenant(orgId: string, userId: string, fullName: string, email: string): Promise<string> {
    // Insert if not exists (user_id doesn't have a unique constraint in schema — check by user_id)
    await prisma.$executeRaw`
      INSERT INTO tenants (org_id, user_id, full_name, email, phone)
      SELECT ${orgId}::uuid, ${userId}::uuid, ${fullName}, ${email}, ''
      WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE user_id = ${userId}::uuid)
    `
    const tenant = await prisma.tenant.findFirst({ where: { userId } })
    if (!tenant) throw new Error(`Failed to find tenant for user ${userId}`)
    return tenant.id
  }

  const aisyahId = await upsertTenant(northwind.id, aisyahUid, 'Aisyah Rahman', 'aisyah@northwind.test')
  const benId = await upsertTenant(northwind.id, benUid, 'Ben Lim', 'ben@northwind.test')
  const probeId = await upsertTenant(northwind.id, probeUid, 'Probe Tenant', 'probe@northwind.test')
  const chenId = await upsertTenant(beta.id, chenUid, 'Chen Wei', 'chen@beta.test')
  console.log('Tenants ready')

  // ============================================================
  // UNITS
  // ============================================================
  async function upsertUnit(orgId: string, name: string): Promise<string> {
    const u = await prisma.unit.upsert({
      where: { orgId_name: { orgId, name } },
      update: {},
      create: { orgId, name },
    })
    return u.id
  }

  const unitAId = await upsertUnit(northwind.id, 'A-12-3')
  const unitBId = await upsertUnit(northwind.id, 'B-05-1')
  const unitCId = await upsertUnit(northwind.id, 'C-01-7')
  await upsertUnit(northwind.id, 'D-03-2')
  const unitKLId = await upsertUnit(beta.id, 'KL-1')
  console.log('Units ready')

  // ============================================================
  // LEASES + INVOICES
  // ============================================================
  async function createLeaseIfNotExists(
    orgId: string, unitId: string, tenantId: string,
    startDate: string, endDate: string, monthlyRentSen: number, depositSen: number,
  ): Promise<{ id: string }> {
    const existing = await prisma.lease.findFirst({ where: { unitId, orgId } })
    if (existing) { console.log(`  Lease for unit ${unitId} already exists`); return existing }

    const schedule = generateSchedule({ startDate, endDate, monthlyRentSen, depositSen })
    return prisma.$transaction(async (tx: Tx) => {
      const lease = await tx.lease.create({
        data: {
          orgId, unitId, tenantId,
          startDate: new Date(startDate), endDate: new Date(endDate),
          monthlyRentSen: BigInt(monthlyRentSen), depositSen: BigInt(depositSen),
        },
      })
      await tx.invoice.createMany({
        data: schedule.map((inv) => ({
          orgId, leaseId: lease.id, kind: inv.kind,
          periodIndex: inv.periodIndex,
          periodStart: inv.periodStart ? new Date(inv.periodStart) : null,
          periodEnd: inv.periodEnd ? new Date(inv.periodEnd) : null,
          dueDate: new Date(inv.dueDate), amountSen: BigInt(inv.amountSen),
        })),
      })
      return lease
    })
  }

  const aisyahLease = await createLeaseIfNotExists(northwind.id, unitAId, aisyahId, '2026-01-31', '2026-07-15', 150000, 300000)
  await createLeaseIfNotExists(northwind.id, unitBId, benId, '2026-01-01', '2026-04-15', 100029, 0)
  await createLeaseIfNotExists(northwind.id, unitCId, probeId, '2026-02-28', '2027-02-27', 200000, 400000)
  await createLeaseIfNotExists(beta.id, unitKLId, chenId, '2026-03-15', '2027-03-14', 220000, 440000)
  console.log('Leases and invoices ready')

  // ============================================================
  // PAYMENTS on Aisyah's lease
  // ============================================================

  // Payment 1: Cash RM3000, received 2026-01-31 10:00 MYT = 2026-01-31T02:00:00Z, by manager
  const p1Exists = await prisma.payment.findFirst({
    where: { leaseId: aisyahLease.id, method: 'cash', amountSen: BigInt(300000) },
  })
  if (!p1Exists) {
    await prisma.$transaction(async (tx: Tx) => {
      const p1 = await tx.payment.create({
        data: {
          orgId: northwind.id, leaseId: aisyahLease.id,
          amountSen: BigInt(300000), unappliedSen: BigInt(0),
          method: 'cash', status: 'approved',
          receivedAt: new Date('2026-01-31T02:00:00Z'),
        },
      })
      await allocate(tx, p1.id)
      await tx.$executeRaw`
        INSERT INTO audit_log (org_id, actor_id, action, entity_id, details)
        VALUES (${northwind.id}::uuid, ${nwMgrId}::uuid, 'payment.recorded',
                ${p1.id}::uuid, '{"method":"cash","amountSen":300000}'::jsonb)`
    })
    console.log('  Payment 1 (cash RM3000) allocated')
  }

  // Payment 2: Bank transfer RM2000, received 2026-03-01 00:30 MYT = 2026-02-28T16:30:00Z, by staff then approved
  const p2Exists = await prisma.payment.findFirst({
    where: { leaseId: aisyahLease.id, method: 'bank_transfer', amountSen: BigInt(200000) },
  })
  if (!p2Exists) {
    await prisma.$transaction(async (tx: Tx) => {
      const p2 = await tx.payment.create({
        data: {
          orgId: northwind.id, leaseId: aisyahLease.id,
          amountSen: BigInt(200000), unappliedSen: BigInt(0),
          method: 'bank_transfer', status: 'approved',
          receivedAt: new Date('2026-02-28T16:30:00Z'),
          slipPath: `${northwind.id}/seed-slip.pdf`,
        },
      })
      await allocate(tx, p2.id)
      await tx.$executeRaw`
        INSERT INTO audit_log (org_id, actor_id, action, entity_id, details)
        VALUES (${northwind.id}::uuid, ${nwStaffId}::uuid, 'payment.recorded',
                ${p2.id}::uuid, '{"method":"bank_transfer","amountSen":200000}'::jsonb)`
      await tx.$executeRaw`
        INSERT INTO audit_log (org_id, actor_id, action, entity_id, details)
        VALUES (${northwind.id}::uuid, ${nwMgrId}::uuid, 'payment.approved',
                ${p2.id}::uuid, '{"amountSen":200000}'::jsonb)`
    })
    console.log('  Payment 2 (bank transfer RM2000) allocated')
  }

  console.log('\n✅ Seed complete! Password for all accounts:', SEED_PASSWORD)
  await prisma.$disconnect()
  process.exit(0)
}

main().catch((e) => {
  console.error('Seed failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
