# Code Review

Three files from the brief reviewed against the project's actual implementation.

---

## 1. `late-fees/route.ts`

### Additional issue — Incompatible with the current schema (BLOCKER)
The route reads `invoice.allocations` and writes `reference`, but the current Prisma model exposes `paymentAllocations` and has no `reference` field. It also writes `kind: 'late_fee'`, while the migration constrains invoice kinds to `deposit` or `rent`. This route will not type-check as written and would fail its database constraint even if the TypeScript error were bypassed. Add matching schema/migration changes or use fields and kinds supported by the current schema.

### Bug 1 — Role derived from `user_metadata` (CRITICAL, Security)
**Line 12:** `user?.user_metadata.role !== 'manager'`

`user_metadata` is stored in the auth token and can be edited by the user via `supabase.auth.updateUser()`. A user could grant themselves the manager role without any database change.

**Fix:** Look up the role from the `memberships` table (server-side, cannot be forged):
```ts
// Our implementation — lib/auth.ts L34-46
const membership = await prisma.membership.findUnique({ where: { userId: user.id } })
if (!membership || membership.role !== 'manager') return forbidden()
```

---

### Bug 2 — No organization isolation (CRITICAL, Security)
**Line 13 / Line 24:** After the role check passes, the lease is fetched with only its `id` — no `orgId` filter. A manager from *Beta Realty* could add late fees to *Northwind Properties* leases.

**Fix:** Always filter by the session's organization:
```ts
// Our implementation — every lease lookup includes orgId
prisma.lease.findFirst({ where: { id: leaseId, orgId: session.orgId! } })
```

---

### Bug 3 — MYT "today" computed incorrectly (HIGH, Timezone)
**Line ~30:** `const todayMyt = new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date())`

Then used as: `new Date(Date.parse(todayMyt))` — `Date.parse` on a locale-formatted string is undefined behavior. The result depends on the locale format order (`DD/MM/YYYY` vs `YYYY-MM-DD`).

Even if parsing worked, the resulting `Date` is interpreted as UTC midnight, not MYT midnight. Subtracting `GRACE_DAYS * DAY_MS` then gives a UTC-based cutoff, not a MYT-based one.

**Fix:** Derive MYT "today" timezone-independently:
```ts
// Our implementation — lib/myt.ts L9-14
export function todayMYT(): string {
  const ms = Date.now() + 8 * 3600 * 1000  // shift to UTC+8
  const d = new Date(ms)
  return d.toISOString().slice(0, 10)       // 'YYYY-MM-DD'
}
```

---

### Bug 4 — Lossy conversion of BigInt money (MEDIUM, Correctness)
**Line 41:** `Number(paid) / Number(invoice.amountSen) >= 0.995`
**Line 44:** `Math.round((Number(invoice.amountSen - paid) * 2) / 100)`

The database stores these values as `bigint` and the schema does not cap them at `Number.MAX_SAFE_INTEGER`. A sufficiently large valid invoice or allocation is rounded when converted to `Number`, so the 99.5% comparison or fee can be off. This is an edge case, but the code should keep the ratio and fee calculation in integer/`bigint` arithmetic.

**Fix:** Keep everything in `bigint`:
```ts
// Integer comparison
if (paid * 100n >= invoice.amountSen * 99n) { /* ~paid */ }
// Integer fee (e.g. 2% of outstanding, rounded half-up)
const outstanding = invoice.amountSen - paid
const fee = (outstanding * 2n + 99n) / 100n  // integer division with ceiling
```

---

### Bug 5 — Race condition in `nextReference()` (HIGH, Concurrency)
**Line 56:** `nextReference()` apparently reads the max reference number then increments it in application code. Two concurrent requests can read the same maximum and generate duplicate reference numbers.

**Fix:** Use a database sequence or `SELECT ... FOR UPDATE` inside a transaction. Our webhook bill IDs use `randomBytes(24).toString('base64url')` to avoid sequences entirely — cryptographically unique, no race.

---

### Bug 6 — No transaction around invoice creates (MEDIUM, Atomicity)
**Lines 47–54:** `fees.push(prisma.invoice.create(...))` — each `create` is a separate statement. If the process crashes mid-loop (or a DB constraint fails on item 3 of 5), some late-fee invoices are committed and others are not, leaving the lease in an inconsistent state.

**Fix:** Wrap all creates in a single `prisma.$transaction([...])`.

---

---

## 2. `webhooks/gateway/route.ts` (reference implementation)

### Bug 1 — Logs sensitive data on invalid signature (MEDIUM, Security)
```ts
console.error('Invalid signature', { fields, expected })
```
`fields` includes the full webhook payload; `expected` leaks the correct HMAC. Both should never appear in logs.

**Our fix (webhook/route.ts L48–49):**
```ts
// Do not log fields (may contain sensitive data)
return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
```

---

### Bug 2 — No row lock → duplicate payment race (CRITICAL, Concurrency)
The reference checks `bill.status === 'paid'` then writes in two separate statements. A concurrent webhook can pass the check before either writes, creating two payments for one bill.

**Our fix (`app/api/webhooks/gateway/route.ts`):** A `FOR UPDATE` row lock in a `ReadCommitted` transaction serializes callbacks for each bill:
```ts
await prisma.$transaction(async (tx) => {
  const bills = await tx.$queryRaw`SELECT ... FROM gateway_bills WHERE id = ${billId} FOR UPDATE`
  if (bill.status === 'paid') return
  // ... create payment and allocate inside same transaction
}, { isolationLevel: 'ReadCommitted' })
```

---

### Bug 3 — `receivedAt: new Date()` ignores `paid_at` from gateway (MEDIUM, Correctness)
The correct received-at timestamp comes from the gateway's `paid_at` field (MYT). Using server wall clock means the timestamp is wrong whenever there is any delay between gateway callback and server processing.

**Our fix (`app/api/webhooks/gateway/route.ts`):** Parse `paid_at` from the signed payload with its timezone offset and reject invalid timestamps rather than substituting the server clock.

---

### Bug 4 — `paid=false` path can overwrite a successful payment (HIGH, Concurrency)
When `paid=false`, the code reads `bill.status` then writes `status='failed'` in two statements without locking. A concurrent `paid=true` callback could mark the bill as paid between these two statements; the `failed` write would then overwrite it.

**Our fix (`app/api/webhooks/gateway/route.ts`):** Both callback outcomes acquire the same bill-row lock, then update only a pending bill. A late failure callback sees `paid` and makes no change.

---

### Bug 5 — `paid=false` for unknown bill returns 200 (MEDIUM, Correctness)
The reference implementation silently succeeds for `paid=false` on a bill that doesn't exist. Our implementation returns 404 (`webhook/route.ts L60`), allowing the gateway to alert on misconfigured bill IDs.

---

## 3. `dashboard/actions.ts`

### Bug 1 — `orgId` taken from caller parameter, not session (CRITICAL, Security)
```ts
export async function getCollections(orgId: string, from: string, to: string) { ... }
```
If `orgId` is passed in from the client (e.g. a Server Action called from a form), a malicious user can pass any `orgId` and read another organization's data.

**Our fix (api/reports/collections/route.ts):** `orgId` is derived entirely from the authenticated session:
```ts
const [session, err] = await requireStaffOrManager()
// session.orgId is set from the memberships table — cannot be forged
```

---

### Bug 2 — Monthly grouping in UTC instead of MYT (HIGH, Timezone)
```ts
received_at >= ${from}::date
```
`received_at` is a `timestamptz` (stored UTC). Comparing to a plain `date` casts the date to UTC midnight. A payment received at 2026-03-01 00:30 MYT (= 2026-02-28 16:30 UTC) would be counted in February, not March.

**Our fix (api/reports/collections/route.ts L~35):**
```sql
DATE_TRUNC('month',
  received_at AT TIME ZONE 'Asia/Kuala_Lumpur'
) AT TIME ZONE 'Asia/Kuala_Lumpur'
```
This converts to MYT before truncating, so payments are counted in their Malaysian calendar month.
