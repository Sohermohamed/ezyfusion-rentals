/**
 * scripts/audit-security.ts
 * Focused security and payment audit tests against the live local stack.
 * Run: npx tsx scripts/audit-security.ts
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

import { createHmac } from 'crypto'

const BASE = 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const GATEWAY_KEY = process.env.GATEWAY_X_SIGNATURE_KEY!
const PASSWORD = 'Seed1234!'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`)
    failed++
    failures.push(name)
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': PUBLISHABLE_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status} ${await res.text()}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}

function webhookSign(fields: Record<string, string>, key: string): string {
  const source = Object.keys(fields)
    .filter(k => k !== 'x_signature')
    .sort()
    .map(k => `${k}${fields[k]}`)
    .join('|')
  return createHmac('sha256', key).update(source).digest('hex')
}

async function webhookPost(fields: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}/api/webhooks/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

async function apiGet(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${BASE}${path}`, { headers })
}

async function apiPost(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function supabaseQuery(table: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'apikey': PUBLISHABLE_KEY }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`)
  url.searchParams.set('select', '*')
  url.searchParams.set('limit', '5')
  return fetch(url, { headers })
}

async function main() {
  console.log('\n=== EzyFusion Security Audit Tests ===\n')

  // ── Login all test accounts ──────────────────────────────────────
  let northwindManager: string, northwindStaff: string, aisyah: string,
    betaManager: string, probeToken: string
  try {
    ;[northwindManager, northwindStaff, aisyah, betaManager, probeToken] = await Promise.all([
      login('manager@northwind.test'),
      login('staff@northwind.test'),
      login('aisyah@northwind.test'),
      login('manager@beta.test'),
      login('probe@northwind.test'),
    ])
    console.log('Tokens acquired for all test accounts.\n')
  } catch (e) {
    console.error('FATAL: Could not login:', e)
    process.exit(1)
  }

  // ── Get a lease ID via Supabase Data API (manager token) ──────────
  let aisyahLeaseId = ''
  let probLeaseId = ''
  {
    const r = await supabaseQuery('leases', northwindManager)
    if (r.ok) {
      const leases = await r.json() as { id: string; tenant_id: string }[]
      // Seed order: Aisyah=0, Ben=1, Probe=2
      aisyahLeaseId = leases[0]?.id ?? ''
      probLeaseId = leases[2]?.id ?? ''
    }
    console.log(`Lease IDs — Aisyah: ${aisyahLeaseId || 'NOT FOUND'}, Probe: ${probLeaseId || 'NOT FOUND'}`)
  }

  // ── 1. Unauthenticated → 401 ──────────────────────────────────────
  console.log('\n--- 1. Unauthenticated access → 401 ---')
  {
    const r1 = await apiGet('/api/leases/00000000-0000-0000-0000-000000000000')
    assert('No auth → GET /api/leases/:id returns 401', r1.status === 401, `got ${r1.status}`)

    const r2 = await apiPost('/api/leases', {})
    assert('No auth → POST /api/leases returns 401', r2.status === 401, `got ${r2.status}`)

    const r3 = await apiGet('/api/reports/collections?from=2026-01&to=2026-03')
    assert('No auth → GET /api/reports/collections returns 401', r3.status === 401, `got ${r3.status}`)

    const r4 = await apiPost('/api/payments/00000000-0000-0000-0000-000000000000/approve', {})
    assert('No auth → POST /api/payments/:id/approve returns 401', r4.status === 401, `got ${r4.status}`)

    const r5 = await apiPost('/api/payments/00000000-0000-0000-0000-000000000000/void', {})
    assert('No auth → POST /api/payments/:id/void returns 401', r5.status === 401, `got ${r5.status}`)
  }

  // ── 2. Cross-org isolation ───────────────────────────────────────
  console.log('\n--- 2. Cross-org isolation ---')
  if (aisyahLeaseId) {
    const r1 = await apiGet(`/api/leases/${aisyahLeaseId}`, betaManager)
    assert('Beta manager cannot read Northwind lease → 404', r1.status === 404, `got ${r1.status}`)

    const r2 = await apiPost(`/api/leases/${aisyahLeaseId}/payments`,
      { amountSen: 10000, method: 'cash', receivedAt: new Date().toISOString() }, betaManager)
    assert('Beta manager cannot record payment on Northwind lease → 404', r2.status === 404, `got ${r2.status}`)
  } else {
    console.log('  SKIP: no Aisyah lease ID')
  }

  // ── 3. Role enforcement ──────────────────────────────────────────
  console.log('\n--- 3. Role enforcement ---')
  {
    // Tenant cannot record a cash payment
    if (aisyahLeaseId) {
      const r = await apiPost(`/api/leases/${aisyahLeaseId}/payments`,
        { amountSen: 10000, method: 'cash', receivedAt: new Date().toISOString() }, aisyah)
      assert('Tenant cannot record payment → 403', r.status === 403, `got ${r.status}`)
    }

    // Staff cannot approve/reject/void (manager-only)
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r2 = await apiPost(`/api/payments/${fakeId}/approve`, {}, northwindStaff)
    assert('Staff cannot approve payment → 403', r2.status === 403, `got ${r2.status}`)

    const r3 = await apiPost(`/api/payments/${fakeId}/reject`, { reason: 'test reason' }, northwindStaff)
    assert('Staff cannot reject payment → 403', r3.status === 403, `got ${r3.status}`)

    const r4 = await apiPost(`/api/payments/${fakeId}/void`, { reason: 'test reason' }, northwindStaff)
    assert('Staff cannot void payment → 403', r4.status === 403, `got ${r4.status}`)

    // Staff cannot create gateway bill (tenant-only)
    if (aisyahLeaseId) {
      const r5 = await apiPost(`/api/leases/${aisyahLeaseId}/gateway-bills`, {}, northwindStaff)
      assert('Staff cannot create gateway bill → 403', r5.status === 403, `got ${r5.status}`)
    }

    // Manager cannot create gateway bill (tenant-only)
    if (aisyahLeaseId) {
      const r6 = await apiPost(`/api/leases/${aisyahLeaseId}/gateway-bills`, {}, northwindManager)
      assert('Manager cannot create gateway bill → 403', r6.status === 403, `got ${r6.status}`)
    }

    // Probe tenant cannot access Aisyah's lease via API
    if (aisyahLeaseId) {
      const r7 = await apiGet(`/api/leases/${aisyahLeaseId}`, probeToken)
      assert("Probe tenant cannot read Aisyah's lease → 404", r7.status === 404, `got ${r7.status}`)
    }

    // Probe tenant cannot create bill on Aisyah's lease
    if (aisyahLeaseId) {
      const r8 = await apiPost(`/api/leases/${aisyahLeaseId}/gateway-bills`, {}, probeToken)
      assert("Probe tenant cannot create bill on Aisyah's lease → 404", r8.status === 404, `got ${r8.status}`)
    }
  }

  // ── 4. Webhook security ──────────────────────────────────────────
  console.log('\n--- 4. Webhook security ---')
  {
    // Forged signature
    const r1 = await webhookPost({
      id: 'bill_nonexistent', paid: 'true', paid_amount: '100000',
      paid_at: '2026-01-01 00:00:00 +0800', x_signature: 'forged_signature_here'
    })
    assert('Forged HMAC → 401', r1.status === 401, `got ${r1.status}`)

    // Valid sig but unknown bill ID
    const f2: Record<string, string> = { id: 'bill_does_not_exist', paid: 'true', paid_amount: '100000', paid_at: '2026-01-01 00:00:00 +0800' }
    f2.x_signature = webhookSign(f2, GATEWAY_KEY)
    const r2 = await webhookPost(f2)
    assert('Valid sig, unknown bill, paid=true → 404', r2.status === 404, `got ${r2.status}`)

    // paid=false for unknown bill → 404
    const f3: Record<string, string> = { id: 'bill_unknown_false', paid: 'false', paid_at: '2026-01-01 00:00:00 +0800' }
    f3.x_signature = webhookSign(f3, GATEWAY_KEY)
    const r3 = await webhookPost(f3)
    assert('Valid sig, unknown bill, paid=false → 404', r3.status === 404, `got ${r3.status}`)

    // Missing x_signature field entirely
    const r4 = await fetch(`${BASE}/api/webhooks/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'id=bill_x&paid=true',
    })
    assert('Missing x_signature → 401', r4.status === 401, `got ${r4.status}`)
  }

  // ── 5. Validation errors ─────────────────────────────────────────
  console.log('\n--- 5. Validation ---')
  {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r1 = await apiPost(`/api/payments/${fakeId}/void`, { reason: 'bad' }, northwindManager)
    assert('Void: reason < 5 chars → 400', r1.status === 400, `got ${r1.status}`)

    const r2 = await apiPost(`/api/payments/${fakeId}/reject`, { reason: 'no' }, northwindManager)
    assert('Reject: reason < 5 chars → 400', r2.status === 400, `got ${r2.status}`)

    const r3 = await apiPost(`/api/payments/${fakeId}/void`, { reason: '' }, northwindManager)
    assert('Void: empty reason → 400', r3.status === 400, `got ${r3.status}`)

    if (aisyahLeaseId) {
      const r4 = await apiPost(`/api/leases/${aisyahLeaseId}/payments`, {
        amountSen: -100, method: 'cash', receivedAt: new Date().toISOString()
      }, northwindManager)
      assert('Negative amountSen → 400', r4.status === 400, `got ${r4.status}`)

      const r5 = await apiPost(`/api/leases/${aisyahLeaseId}/payments`, {
        amountSen: 100, method: 'wire', receivedAt: new Date().toISOString()
      }, northwindManager)
      assert('Invalid method → 400', r5.status === 400, `got ${r5.status}`)
    }
  }

  // ── 6. Supabase Data API RLS ─────────────────────────────────────
  console.log('\n--- 6. Supabase Data API RLS ---')
  {
    // Anon cannot read any table
    for (const table of ['organizations', 'leases', 'payments', 'payment_allocations', 'audit_log']) {
      const r = await supabaseQuery(table)
      const body = r.ok ? await r.json() as unknown[] : []
      assert(`Anon cannot read ${table}`, !r.ok || body.length === 0, `status=${r.status} rows=${body.length}`)
    }

    // Tenant (Aisyah) can read her own lease via Data API
    const r1 = await supabaseQuery('leases', aisyah)
    const aisyahLeases = r1.ok ? await r1.json() as { id: string }[] : []
    assert('Aisyah can read her lease via Data API', r1.ok && aisyahLeases.length > 0, `status=${r1.status} count=${aisyahLeases.length}`)

    // Tenant cannot INSERT into payments via Data API
    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
      method: 'POST',
      headers: {
        'apikey': PUBLISHABLE_KEY, 'Authorization': `Bearer ${aisyah}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
      body: JSON.stringify({ org_id: '00000000-0000-0000-0000-000000000000', amount_sen: 100, method: 'cash' }),
    })
    assert('Tenant cannot INSERT payments via Data API', r2.status !== 201, `got ${r2.status}`)

    // Tenant cannot UPDATE invoices via Data API
    const r3 = await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: {
        'apikey': PUBLISHABLE_KEY, 'Authorization': `Bearer ${aisyah}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_sen: 1 }),
    })
    assert('Tenant cannot PATCH invoices via Data API', r3.status !== 200 && r3.status !== 204, `got ${r3.status}`)

    // Aisyah should not see Beta's data
    const r4 = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=name`, {
      headers: { 'apikey': PUBLISHABLE_KEY, 'Authorization': `Bearer ${aisyah}` },
    })
    const orgs = r4.ok ? await r4.json() as { name: string }[] : []
    const hasBeta = orgs.some(o => o.name === 'Beta Realty')
    assert("Aisyah cannot see Beta Realty org", !hasBeta, `orgs=${JSON.stringify(orgs)}`)
  }

  // ── 7. Collections MYT timezone ──────────────────────────────────
  console.log('\n--- 7. Collections MYT timezone ---')
  {
    // Aisyah payment 1: RM3000 cash at 2026-01-31 10:00 MYT → Jan
    // Aisyah payment 2: RM2000 bank at 2026-03-01 00:30 MYT = 2026-02-28 16:30 UTC → Mar (not Feb)
    const r = await apiGet('/api/reports/collections?from=2026-01&to=2026-03', northwindManager)
    if (r.ok) {
      const data = await r.json() as { month: string; collectedSen: number }[]
      const jan = data.find(d => d.month === '2026-01')
      const feb = data.find(d => d.month === '2026-02')
      const mar = data.find(d => d.month === '2026-03')
      assert('Jan collections = 300000 sen (RM3000)', jan?.collectedSen === 300000, `got ${jan?.collectedSen}`)
      assert('Feb collections = 0 (payment was 00:30 MYT = UTC prev day)', feb?.collectedSen === 0, `got ${feb?.collectedSen}`)
      assert('Mar collections = 200000 sen (RM2000 at 00:30 MYT)', mar?.collectedSen === 200000, `got ${mar?.collectedSen}`)
    } else {
      assert('Collections API reachable', false, `got ${r.status}`)
    }
  }

  // ── 8. Lease GET response shape ───────────────────────────────────
  console.log('\n--- 8. API response shapes ---')
  if (aisyahLeaseId) {
    const r = await apiGet(`/api/leases/${aisyahLeaseId}`, northwindManager)
    assert('GET /api/leases/:id returns 200', r.status === 200, `got ${r.status}`)
    if (r.ok) {
      const body = await r.json() as {
        lease: { id: string; startDate: string; monthlyRentSen: number }
        invoices: { kind: string; dueDate: string; amountSen: number; status: string }[]
        payments: { id: string; status: string }[]
      }
      assert('Response has lease object', !!body.lease, '')
      assert('Response has invoices array', Array.isArray(body.invoices), '')
      assert('Response has payments array', Array.isArray(body.payments), '')
      assert('startDate is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(body.lease.startDate), `got "${body.lease.startDate}"`)
      assert('First invoice has status field', typeof body.invoices[0]?.status === 'string', '')
      // Aisyah's deposit invoice
      const deposit = body.invoices.find(i => i.kind === 'deposit')
      assert('Aisyah has deposit invoice', !!deposit, '')
      assert('Deposit amount = 300000 sen', deposit?.amountSen === 300000, `got ${deposit?.amountSen}`)
      // Invoices count: 1 deposit + 6 rent = 7
      assert('Aisyah has 7 invoices (1 deposit + 6 rent)', body.invoices.length === 7, `got ${body.invoices.length}`)
    }
  }

  // ── 9. Webhook duplicate/idempotency (using probe's lease) ────────
  console.log('\n--- 9. Webhook idempotency (create bill then fire webhook twice) ---')
  if (probLeaseId) {
    // Create a gateway bill as probe tenant
    const billRes = await apiPost(`/api/leases/${probLeaseId}/gateway-bills`, {}, probeToken)
    if (billRes.status === 201) {
      const { billId, amountSen } = await billRes.json() as { billId: string; amountSen: number }
      assert('Gateway bill created', !!billId, `got status ${billRes.status}`)

      // First webhook call — should succeed
      const paidAt = '2026-03-01 08:00:00 +0800'
      const f1: Record<string, string> = { id: billId, paid: 'true', paid_amount: String(amountSen), paid_at: paidAt }
      f1.x_signature = webhookSign(f1, GATEWAY_KEY)
      const w1 = await webhookPost(f1)
      assert('First webhook call → 200', w1.status === 200, `got ${w1.status}`)

      // Second webhook call (duplicate) — must return 200 without creating another payment
      const f2: Record<string, string> = { id: billId, paid: 'true', paid_amount: String(amountSen), paid_at: paidAt }
      f2.x_signature = webhookSign(f2, GATEWAY_KEY)
      const w2 = await webhookPost(f2)
      assert('Duplicate webhook call → 200 (idempotent)', w2.status === 200, `got ${w2.status}`)

      // Verify only one payment was created (via Data API as manager)
      const pr = await supabaseQuery(`payments?gateway_bill_id=eq.${billId}`, northwindManager)
      const pmts = pr.ok ? await pr.json() as unknown[] : []
      assert('Duplicate webhook did NOT create second payment', pmts.length === 1, `found ${pmts.length} payments`)

      // paid=false AFTER paid=true — must not reset to failed
      const f3: Record<string, string> = { id: billId, paid: 'false', paid_at: paidAt }
      f3.x_signature = webhookSign(f3, GATEWAY_KEY)
      const w3 = await webhookPost(f3)
      assert('Out-of-order paid=false after paid=true → 200 (no revert)', w3.status === 200, `got ${w3.status}`)

      // Bill should still be paid
      const br = await supabaseQuery(`gateway_bills?id=eq.${billId}`, northwindManager)
      const bills = br.ok ? await br.json() as { status: string }[] : []
      assert('Bill status remains paid after out-of-order paid=false', bills[0]?.status === 'paid', `got ${bills[0]?.status}`)

      // Amount mismatch
      const f4: Record<string, string> = { id: billId, paid: 'true', paid_amount: '1', paid_at: paidAt }
      f4.x_signature = webhookSign(f4, GATEWAY_KEY)
      const w4 = await webhookPost(f4)
      // Bill is already paid so it returns ALREADY_PAID → 200 (idempotent wins over amount check)
      assert('Webhook on already-paid bill → 200 regardless of amount', w4.status === 200, `got ${w4.status}`)
    } else {
      const body = await billRes.text()
      console.log(`  SKIP idempotency test: gateway bill creation failed: ${billRes.status} ${body}`)
    }
  } else {
    console.log('  SKIP idempotency test: no probe lease ID')
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailed tests:')
    failures.forEach(f => console.log(`  - ${f}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
