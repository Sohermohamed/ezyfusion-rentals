/**
 * scripts/check-webhook-idempotency.ts
 * Verifies webhook signature validation, idempotency, and concurrent callbacks.
 * Run: npx tsx scripts/check-webhook-idempotency.ts
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

import { createHmac } from 'crypto'

const BASE = process.env.WEBHOOK_TEST_BASE_URL ?? 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const GATEWAY_KEY = process.env.GATEWAY_X_SIGNATURE_KEY
const PASSWORD = 'Seed1234!'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
    failed++
    failures.push(name)
  }
}

function sign(fields: Record<string, string>): string {
  const source = Object.keys(fields)
    .filter((key) => key !== 'x_signature')
    .sort()
    .map((key) => `${key}${fields[key]}`)
    .join('|')
  return createHmac('sha256', GATEWAY_KEY!).update(source).digest('hex')
}

function signedFields(billId: string, paid: boolean, amountSen?: number): Record<string, string> {
  const fields: Record<string, string> = {
    id: billId,
    paid: String(paid),
    paid_at: '2026-10-27 08:00:00 +0800',
  }
  if (amountSen !== undefined) fields.paid_amount = String(amountSen)
  fields.x_signature = sign(fields)
  return fields
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY! },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`Login failed with HTTP ${response.status}`)
  return ((await response.json()) as { access_token: string }).access_token
}

async function postJson(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function postWebhook(fields: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}/api/webhooks/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

async function main() {
  const missingEnv = [
    ['NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL],
    ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', KEY],
    ['GATEWAY_X_SIGNATURE_KEY', GATEWAY_KEY],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missingEnv.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missingEnv.join(', ')}`)
    process.exitCode = 1
    return
  }

  const { getPrisma } = await import('../lib/prisma.js')
  const prisma = getPrisma()
  let leaseId: string | undefined
  let testPeriod: { start: string; end: string; startDate: Date; endDate: Date } | undefined

  console.log('\n=== Gateway Webhook Idempotency and Concurrency Tests ===\n')

  try {
    const probeToken = await login('probe@northwind.test')

    const tenant = await prisma.tenant.findFirst({
      where: { email: 'probe@northwind.test' },
      select: { id: true, orgId: true },
    })
    if (!tenant) throw new Error('Probe tenant fixture not found')

    const unit = await prisma.unit.findFirst({
      where: { orgId: tenant.orgId, name: 'D-03-2' },
      select: { id: true },
    })
    if (!unit) throw new Error('Dedicated webhook test unit D-03-2 not found')

    const now = new Date()
    for (let year = 2025; year <= now.getUTCFullYear() && !testPeriod; year++) {
      for (let month = 1; month <= 12 && !testPeriod; month++) {
        const start = `${year}-${String(month).padStart(2, '0')}-01`
        const end = `${year}-${String(month).padStart(2, '0')}-28`
        const startDate = new Date(`${start}T00:00:00.000Z`)
        const endDate = new Date(`${end}T00:00:00.000Z`)
        if (endDate >= now) continue
        const overlap = await prisma.lease.findFirst({
          where: {
            unitId: unit.id,
            startDate: { lte: endDate },
            endDate: { gte: startDate },
          },
          select: { id: true },
        })
        if (!overlap) testPeriod = { start, end, startDate, endDate }
      }
    }
    const period = testPeriod
    if (!period) throw new Error('No unoccupied past period found on the dedicated test unit')

    // Create fixtures directly so the test does not write an immutable audit-log entry.
    const testLease = await prisma.$transaction(async (tx) => {
      const lease = await tx.lease.create({
        data: {
          orgId: tenant.orgId,
          unitId: unit.id,
          tenantId: tenant.id,
          startDate: period.startDate,
          endDate: period.endDate,
          monthlyRentSen: 10000n,
          depositSen: 0n,
        },
      })
      await tx.invoice.create({
        data: {
          orgId: tenant.orgId,
          leaseId: lease.id,
          kind: 'rent',
          periodIndex: 1,
          periodStart: period.startDate,
          periodEnd: period.endDate,
          dueDate: period.startDate,
          amountSen: 10000n,
        },
      })
      return lease
    })
    leaseId = testLease.id
    const testInvoices = await prisma.invoice.findMany({
      where: { leaseId },
      select: { kind: true, amountSen: true },
    })
    assert('Unique test lease and due invoice created',
      testInvoices.length === 1 && testInvoices[0].kind === 'rent' && testInvoices[0].amountSen === 10000n,
      `invoices=${testInvoices.length}`)

    const billResponse = await postJson(`/api/leases/${leaseId}/gateway-bills`, probeToken, {})
    if (billResponse.status !== 201) {
      throw new Error(`Test gateway bill creation failed with HTTP ${billResponse.status}`)
    }
    const { billId, amountSen } = await billResponse.json() as { billId?: string; amountSen?: number }
    if (!billId || !amountSen || amountSen <= 1) throw new Error('Gateway bill response was invalid')
    console.log(`Created an isolated test bill for ${amountSen} sen.`)

    const initialBill = await prisma.gatewayBill.findUnique({ where: { id: billId }, select: { status: true } })
    const initialPaymentCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    assert('New bill is pending with no payment', initialBill?.status === 'pending' && initialPaymentCount === 0,
      `status=${initialBill?.status}, payments=${initialPaymentCount}`)

    const invalidSignature = { ...signedFields(billId, true, amountSen), x_signature: 'invalid-signature' }
    const invalidResponse = await postWebhook(invalidSignature)
    const afterInvalidCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    const afterInvalidBill = await prisma.gatewayBill.findUnique({ where: { id: billId }, select: { status: true } })
    assert('Invalid HMAC returns 401', invalidResponse.status === 401, `got ${invalidResponse.status}`)
    assert('Invalid HMAC creates no payment and leaves bill pending',
      afterInvalidCount === 0 && afterInvalidBill?.status === 'pending',
      `payments=${afterInvalidCount}, status=${afterInvalidBill?.status}`)

    const mismatchResponse = await postWebhook(signedFields(billId, true, 1))
    const afterMismatchCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    const afterMismatchBill = await prisma.gatewayBill.findUnique({ where: { id: billId }, select: { status: true } })
    assert('Validly signed amount mismatch returns 422', mismatchResponse.status === 422,
      `got ${mismatchResponse.status}`)
    assert('Amount mismatch creates no payment and leaves bill pending',
      afterMismatchCount === 0 && afterMismatchBill?.status === 'pending',
      `payments=${afterMismatchCount}, status=${afterMismatchBill?.status}`)

    console.log('\n--- Two simultaneous valid callbacks for the same bill ---')
    const validFields = signedFields(billId, true, amountSen)
    const concurrentResponses = await Promise.all([
      postWebhook(validFields),
      postWebhook(validFields),
    ])
    const concurrentDetails = await Promise.all(concurrentResponses.map(async (response) => {
      if (response.status !== 500) return String(response.status)
      try {
        const body = await response.json() as { error?: unknown }
        return body.error === 'Internal server error' ? '500: Internal server error' : '500'
      } catch {
        return '500'
      }
    }))
    assert('Both simultaneous valid callbacks return 200',
      concurrentResponses.every((response) => response.status === 200),
      `responses=${concurrentDetails.join(',')}`)

    const concurrentPaymentCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    const concurrentBill = await prisma.gatewayBill.findUnique({ where: { id: billId }, select: { status: true } })
    assert('Simultaneous callbacks record exactly one payment', concurrentPaymentCount === 1,
      `payments=${concurrentPaymentCount}`)
    assert('Simultaneous callbacks leave bill paid', concurrentBill?.status === 'paid',
      `status=${concurrentBill?.status}`)

    const repeatedResponse = await postWebhook(signedFields(billId, true, amountSen))
    const repeatedPaymentCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    assert('Sequential repeated callback returns 200 without another payment',
      repeatedResponse.status === 200 && repeatedPaymentCount === 1,
      `status=${repeatedResponse.status}, payments=${repeatedPaymentCount}`)

    const lateFailureResponse = await postWebhook(signedFields(billId, false))
    const finalBill = await prisma.gatewayBill.findUnique({ where: { id: billId }, select: { status: true } })
    const finalPaymentCount = await prisma.payment.count({ where: { gatewayBillId: billId } })
    assert('Out-of-order paid=false callback returns 200',
      lateFailureResponse.status === 200, `got ${lateFailureResponse.status}`)
    assert('Late paid=false does not revert paid bill or duplicate payment',
      finalBill?.status === 'paid' && finalPaymentCount === 1,
      `status=${finalBill?.status}, payments=${finalPaymentCount}`)
  } catch {
    failed++
    failures.push('Test setup or execution')
    console.error('FATAL: Test setup or execution failed; details suppressed.')
  } finally {
    try {
      const billIds = leaseId
        ? (await prisma.gatewayBill.findMany({
          where: { leaseId },
          select: { id: true },
        })).map((bill) => bill.id)
        : []
      const invoiceIds = leaseId
        ? (await prisma.invoice.findMany({ where: { leaseId }, select: { id: true } })).map((invoice) => invoice.id)
        : []

      await prisma.$transaction(async (tx) => {
        if (leaseId) {
          if (billIds.length > 0) {
            await tx.paymentAllocation.deleteMany({
              where: { payment: { gatewayBillId: { in: billIds } } },
            })
            await tx.payment.deleteMany({ where: { gatewayBillId: { in: billIds } } })
            await tx.gatewayBill.deleteMany({ where: { id: { in: billIds } } })
          }
          await tx.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
          await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
          await tx.lease.deleteMany({ where: { id: leaseId } })
        }
      })

      const remainingPayments = billIds.length > 0
        ? await prisma.payment.count({ where: { gatewayBillId: { in: billIds } } })
        : 0
      const remainingBills = billIds.length > 0
        ? await prisma.gatewayBill.count({ where: { id: { in: billIds } } })
        : 0
      const remainingLeases = leaseId
        ? await prisma.lease.count({ where: { id: leaseId } })
        : 0
      const remainingInvoices = leaseId
        ? await prisma.invoice.count({ where: { leaseId } })
        : 0
      const remainingAllocations = invoiceIds.length > 0
        ? await prisma.paymentAllocation.count({ where: { invoiceId: { in: invoiceIds } } })
        : 0
      const remaining = remainingPayments + remainingBills + remainingLeases + remainingInvoices +
        remainingAllocations
      assert('Test-created payments, bills, lease, invoices, and allocations cleaned up',
        remaining === 0, `remaining=${remaining}`)
    } catch (error) {
      failed++
      failures.push('Test data cleanup')
      const code = typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string' ? error.code : 'unknown'
      console.error(`✗ FAIL: Test data cleanup failed (error code: ${code}).`)
    }
    await prisma.$disconnect()
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailed tests:')
    failures.forEach((failure) => console.log(`  - ${failure}`))
  }
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch(() => {
  console.error('FATAL: Could not initialize webhook tests.')
  process.exitCode = 1
})
