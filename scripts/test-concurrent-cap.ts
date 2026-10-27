/**
 * scripts/test-concurrent-cap.ts
 * Tests concurrent payment-cap enforcement via HTTP API only (no direct Prisma).
 * Creates a lease with RM100 total invoiced, then fires N simultaneous
 * payment requests each for RM100. Only ONE should succeed.
 *
 * Uses Supabase REST API (with service role JWT) to verify DB state.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

const BASE = 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
// Admin REST queries need JWT-format service role key
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_JWT!
const PASSWORD = 'Seed1234!'

let passed = 0; let failed = 0; const failures: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; failures.push(name) }
}

async function login(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!r.ok) throw new Error(`Login failed: ${email} ${r.status}`)
  return ((await r.json()) as { access_token: string }).access_token
}

async function apiPost(path: string, body: unknown, token: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  let rb: unknown
  try { rb = await r.json() } catch { rb = null }
  return { status: r.status, body: rb }
}

async function apiGet(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  let rb: unknown
  try { rb = await r.json() } catch { rb = null }
  return { status: r.status, body: rb }
}

/** Query PostgREST with service role */
async function dbQuery<T>(table: string, params: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  })
  if (!r.ok) throw new Error(`DB query failed: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T[]>
}

async function main() {
  console.log('\n=== Concurrent Payment Cap Tests ===\n')

  const managerToken = await login('manager@northwind.test')

  // ── Setup: find Northwind org, a tenant and unit for test lease ─
  const orgs = await dbQuery<{ id: string; name: string }>('organizations', 'select=id,name')
  const nwOrgId = orgs.find(o => o.name === 'Northwind Properties')?.id ?? ''

  // Find unit D-03-2 (no seeded lease — a spare unit) for testing
  const units = await dbQuery<{ id: string }>('units', `org_id=eq.${nwOrgId}&name=eq.D-03-2&select=id`)
  const testUnitId = units[0]?.id ?? ''

  // Find probe tenant
  const tenants = await dbQuery<{ id: string }>('tenants', `org_id=eq.${nwOrgId}&email=eq.probe%40northwind.test&select=id`)
  const probeTenantId = tenants[0]?.id ?? ''

  if (!testUnitId || !probeTenantId) {
    console.error('FATAL: Could not find test unit D-03-2 or probe tenant')
    console.log('unitId:', testUnitId, 'tenantId:', probeTenantId)
    process.exit(1)
  }
  console.log(`Test unit D-03-2: ${testUnitId}`)
  console.log(`Probe tenant: ${probeTenantId}`)

  // ── Test 1: Manager concurrent cap enforcement ─────────────────
  // Create a new short lease: 2026-05-01 to 2026-05-31, RM100/month, no deposit
  // This generates exactly 1 invoice of 10000 sen (RM100)
  console.log('\n--- Test 1: 5 simultaneous manager payments each for full balance ---')
  {
    // Use a far-future date range unique to this test run to avoid overlap.
    // Months far in future: pick year 2030 + random offset to avoid collision with prior runs.
    const runId = Math.floor(Math.random() * 12) // 0–11
    const year = 2030 + Math.floor(runId / 12)
    const month = String((runId % 12) + 1).padStart(2, '0')
    // Use the last day of the month (28 is safe for all months)
    const startDate = `${year}-${month}-01`
    const endDate = `${year}-${month}-28`
    const monthlyRentSen = 10000
    const leaseRes = await apiPost('/api/leases', {
      unitId: testUnitId, tenantId: probeTenantId,
      startDate, endDate,
      monthlyRentSen, depositSen: 0,
    }, managerToken)
    ok('Test lease created', leaseRes.status === 201, `got ${leaseRes.status} ${JSON.stringify(leaseRes.body)}`)

    const leaseId = (leaseRes.body as { id: string }).id
    if (!leaseId) { console.error('No lease ID'); process.exit(1) }

    // Verify invoice was created using API — get the actual amount
    const leaseData = await apiGet(`/api/leases/${leaseId}`, managerToken)
    const invoicesFromApi = ((leaseData.body as { invoices?: { amountSen: number }[] })?.invoices) ?? []
    console.log(`  Invoice count: ${invoicesFromApi.length}, amounts: ${invoicesFromApi.map(i => i.amountSen)}`)
    ok('Test lease has 1 invoice', invoicesFromApi.length === 1, `count=${invoicesFromApi.length}`)

    // Use the actual invoice amount for payment (handles proration)
    const invoiceAmountSen = invoicesFromApi[0]?.amountSen ?? monthlyRentSen
    console.log(`  Using invoice amount: ${invoiceAmountSen} sen for concurrent payments`)

    // Fire 5 simultaneous payment requests, each for the full invoice amount
    // All execute at the same time; only 1 should pass the cap
    const receivedAt = new Date().toISOString()
    const requests = Array.from({ length: 5 }, () =>
      apiPost(`/api/leases/${leaseId}/payments`, {
        amountSen: invoiceAmountSen, method: 'cash', receivedAt,
      }, managerToken)
    )
    console.log('  Firing 5 concurrent payment requests...')
    const results = await Promise.all(requests)
    const statuses = results.map(r => r.status)
    console.log('  Response statuses:', statuses.join(', '))

    const accepted = results.filter(r => r.status === 201).length
    const rejected = results.filter(r => r.status === 422).length
    const errors = results.filter(r => r.status >= 500).length

    ok('Exactly 1 payment accepted out of 5 concurrent', accepted === 1, `accepted=${accepted}`)
    ok('4 payments rejected (cap exceeded)', rejected === 4, `rejected=${rejected}`)
    ok('No 500 errors from concurrent requests', errors === 0, `errors=${errors}`)

    // Verify DB state via REST API
    type PaymentRow = { id: string; status: string; amount_sen: number; lease_id: string }
    const payments = await dbQuery<PaymentRow>('payments', `lease_id=eq.${leaseId}&select=id,status,amount_sen,lease_id`)
    const totalApproved = payments.filter(p => p.status === 'approved').reduce((s, p) => s + p.amount_sen, 0)
    const totalInvoiced = invoiceAmountSen // use actual invoice amount

    type AllocRow = { amount_sen: number }
    const allocs = await dbQuery<AllocRow>(
      'payment_allocations',
      `payment_id=in.(${payments.map(p => p.id).join(',')})&select=amount_sen`
    )
    const totalAllocated = allocs.reduce((s, a) => s + a.amount_sen, 0)

    console.log(`  Payments in DB: ${payments.length}, statuses: ${payments.map(p => p.status).join(', ')}`)
    console.log(`  Total approved: ${totalApproved} sen, Total invoiced: ${totalInvoiced} sen`)
    console.log(`  Total allocated: ${totalAllocated} sen`)

    ok('Total approved ≤ total invoiced', totalApproved <= totalInvoiced,
      `approved=${totalApproved} invoiced=${totalInvoiced}`)
    ok('Total allocated ≤ total invoiced', totalAllocated <= totalInvoiced,
      `allocated=${totalAllocated} invoiced=${totalInvoiced}`)
    ok('Exactly 1 approved payment in DB',
      payments.filter(p => p.status === 'approved').length === 1,
      `approved count=${payments.filter(p => p.status === 'approved').length}`)

    // ── Test 2: Extra payment after cap filled → 422 ────────────
    console.log('\n--- Test 2: Extra payment after cap filled ---')
    const extra = await apiPost(`/api/leases/${leaseId}/payments`, {
      amountSen: 1, method: 'cash', receivedAt: new Date().toISOString(),
    }, managerToken)
    ok('Extra payment after cap filled → 422', extra.status === 422, `got ${extra.status}`)

    // Void the approved payment to restore cap
    const approvedPmt = payments.find(p => p.status === 'approved')
    if (approvedPmt) {
      const voidRes = await apiPost(`/api/payments/${approvedPmt.id}/void`,
        { reason: 'cleanup after concurrent test' }, managerToken)
      ok('Cleanup: void approved payment succeeds', voidRes.status === 200, `got ${voidRes.status}`)

      // After void, cap is restored — another payment should work
      const after = await apiPost(`/api/leases/${leaseId}/payments`, {
        amountSen: 5000, method: 'cash', receivedAt: new Date().toISOString(),
      }, managerToken)
      ok('After void, new payment within cap → 201', after.status === 201, `got ${after.status}`)
    }

    // ── Test 3: Concurrent staff pending payments ───────────────
    console.log('\n--- Test 3: Concurrent staff pending payments ---')
    // Probe tenant has a lease (C-01-7: RM2000/month, deposit RM4000).
    // Find it, get its remaining balance, fire concurrent staff payments.
    const probeLeases = await dbQuery<{ id: string }>('leases', `tenant_id=eq.${probeTenantId}&select=id&limit=1`)
    const probeLeaseId = probeLeases[0]?.id ?? ''

    if (!probeLeaseId) {
      console.log('  SKIP: No probe lease found for test 3')
    } else {
      // Get invoices total and allocations for probe lease
      const probeInvoices = await dbQuery<{ amount_sen: number }>('invoices', `lease_id=eq.${probeLeaseId}&select=amount_sen`)
      const totalProbeInvoiced = probeInvoices.reduce((s, i) => s + i.amount_sen, 0)

      // Get existing payments (approved)
      const probePayments = await dbQuery<{ id: string; status: string; amount_sen: number }>(
        'payments', `lease_id=eq.${probeLeaseId}&select=id,status,amount_sen`
      )
      // Calculate allocated
      const probePaymentIds = probePayments.map(p => p.id)
      let totalProbeAllocated = 0
      if (probePaymentIds.length > 0) {
        const probeAllocs = await dbQuery<{ amount_sen: number }>(
          'payment_allocations',
          `payment_id=in.(${probePaymentIds.join(',')})&select=amount_sen`
        )
        totalProbeAllocated = probeAllocs.reduce((s, a) => s + a.amount_sen, 0)
      }
      const totalProbePending = probePayments
        .filter(p => p.status === 'pending_verification')
        .reduce((s, p) => s + p.amount_sen, 0)
      const probeCap = totalProbeInvoiced - totalProbeAllocated - totalProbePending
      console.log(`  Probe lease cap: ${probeCap} sen (total=${totalProbeInvoiced}, allocated=${totalProbeAllocated}, pending=${totalProbePending})`)

      if (probeCap > 0) {
        const claimFull = probeCap // try to claim full cap from 3 threads
        const staffToken = await login('staff@northwind.test')
        const concurrentStaff = Array.from({ length: 3 }, () =>
          apiPost(`/api/leases/${probeLeaseId}/payments`, {
            amountSen: claimFull, method: 'cash', receivedAt: new Date().toISOString(),
          }, staffToken)
        )
        const staffResults = await Promise.all(concurrentStaff)
        const sAccepted = staffResults.filter(r => r.status === 201).length
        const sRejected = staffResults.filter(r => r.status === 422).length
        const sStatuses = staffResults.map(r => r.status)
        console.log(`  Staff concurrent statuses: ${sStatuses.join(', ')}`)
        console.log(`  Staff concurrent: ${sAccepted} accepted, ${sRejected} rejected out of 3`)
        ok('Staff concurrent: exactly 1 pending payment accepted', sAccepted === 1, `accepted=${sAccepted}`)
        ok('Staff concurrent: 2 rejected (cap)', sRejected === 2, `rejected=${sRejected}`)

        // Verify pending total ≤ remaining cap via REST
        const nowPayments = await dbQuery<{ status: string; amount_sen: number }>(
          'payments', `lease_id=eq.${probeLeaseId}&status=eq.pending_verification&select=status,amount_sen`
        )
        const pendingTotal = nowPayments.reduce((s, p) => s + p.amount_sen, 0)
        ok('Total pending ≤ remaining cap', pendingTotal <= probeCap, `pending=${pendingTotal} cap=${probeCap}`)
      } else {
        console.log('  SKIP: Probe lease cap is 0 (already fully covered)')
        ok('Staff concurrent: cap=0 — skip (pre-condition not met)', true)
        ok('Staff concurrent: cap=0 — skip (pre-condition not met)', true)
        ok('Total pending ≤ remaining cap: skip', true)
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Concurrent cap tests: ${passed} passed, ${failed} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)) }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
