# Design Decisions

Answers to the six required questions, with file and line references.

---

## 1. How are concurrent duplicate webhook callbacks handled?

**Answer:** All callbacks for a bill use a `FOR UPDATE` row lock inside a `ReadCommitted` transaction.

**Flow:**
1. Two concurrent `paid=true` callbacks for the same `bill_id` both enter the handler.
2. Both start a `ReadCommitted` transaction and execute:
   ```sql
   SELECT id, status, amount_sen, org_id, lease_id
   FROM gateway_bills WHERE id = $1 FOR UPDATE
   ```
3. PostgreSQL grants the lock to one; the other **blocks** until the first commits.
4. The first transaction sees `status = 'pending'`, proceeds to create a payment and set `status = 'paid'`, then commits.
5. The second transaction unblocks, reads `status = 'paid'`, and exits without creating another payment.
6. Both handlers return `HTTP 200 { ok: true }` — the second is an idempotent response.

**Relevant code:** [`app/api/webhooks/gateway/route.ts`](./app/api/webhooks/gateway/route.ts)

The same locked transaction handles `paid=false`. If the bill is already paid, it returns without changing its status; a late failure callback cannot un-settle a paid bill.

---

## 2. How are concurrent payment-cap violations prevented?

**Answer:** We lock the lease row with `SELECT ... FOR UPDATE` before reading or computing the cap. Cap-sensitive actions use `ReadCommitted`, so a request waiting on the lock sees the latest committed payment and allocation state.

**Flow for `POST /api/leases/:leaseId/payments`:**
1. Transaction starts (`ReadCommitted`).
2. `SELECT id FROM leases WHERE id = $1 FOR UPDATE` — acquires an exclusive row lock.
3. Compute cap = total invoiced − total allocated − sum of other pending payments.
4. If `amountSen > cap`, throw `CAP_EXCEEDED` and return `HTTP 422`.
5. Otherwise, create the payment (and allocate if manager).
6. Transaction commits; lock released.

Two concurrent payment-record requests for the same lease will **serialize**: the second one's cap calculation sees the first payment already counted, so it correctly fails if it would exceed the cap.

Approval, rejection, and void also lock the payment and its lease, then re-check the payment state inside the transaction. Approval excludes the payment being approved from "other pending" so its own amount is not double-counted.

**Relevant code:**
- Record payment: [`app/api/leases/[leaseId]/payments/route.ts`](./app/api/leases/[leaseId]/payments/route.ts).
- Approve: [`app/api/payments/[paymentId]/approve/route.ts`](./app/api/payments/[paymentId]/approve/route.ts).
- Reject and void: [`app/api/payments/[paymentId]/reject/route.ts`](./app/api/payments/[paymentId]/reject/route.ts), [`app/api/payments/[paymentId]/void/route.ts`](./app/api/payments/[paymentId]/void/route.ts).

---

## 3. Where is "today" / the current time obtained, and how is Malaysia time ensured?

We never call `new Date()` for business-date decisions in a way that depends on the server's local timezone (`TZ` env var). Every MYT date is derived by adding the UTC+8 offset in milliseconds:

| Location | How MYT is derived | Code reference |
|---|---|---|
| `invoiceStatus()` in `lib/billing.ts` | `now.getTime() + 8*3600*1000` then `.toISOString()` | [`lib/billing.ts`](file:///c:/ezyfusion-rentals/lib/billing.ts#L155-L175) |
| `todayMYT()` in `lib/myt.ts` | `Date.now() + 8*3600*1000` then `.toISOString().slice(0,10)` | [`lib/myt.ts`](file:///c:/ezyfusion-rentals/lib/myt.ts#L9-L17) |
| `formatMYT()` / `formatDateMYT()` in `lib/myt.ts` | `d.getTime() + 8*3600*1000` | [`lib/myt.ts`](file:///c:/ezyfusion-rentals/lib/myt.ts#L41-L57) |
| Collections SQL in `api/reports/collections` | `received_at AT TIME ZONE 'Asia/Kuala_Lumpur'` before `date_trunc` | [`app/api/reports/collections/route.ts`](file:///c:/ezyfusion-rentals/app/api/reports/collections/route.ts#L37-L40) |
| Gateway bill `dueDate` | `todayMYT()` called at request time | [`app/api/leases/[leaseId]/gateway-bills/route.ts`](file:///c:/ezyfusion-rentals/app/api/leases/[leaseId]/gateway-bills/route.ts) |
| UI date display | `formatMYT()` / `formatDateMYT()` from `lib/myt.ts` | Server components pass pre-formatted strings |
| Dashboard, lease pages, tenant portal | Request-time `new Date()` after `connection()`, then `todayMYT()` / `invoiceStatus()` shifts to MYT | [`app/(staff)/dashboard/page.tsx`](./app/(staff)/dashboard/page.tsx), [`app/(staff)/leases/page.tsx`](./app/(staff)/leases/page.tsx), [`app/(staff)/leases/[leaseId]/page.tsx`](./app/(staff)/leases/[leaseId]/page.tsx), [`app/(tenant)/portal/page.tsx`](./app/(tenant)/portal/page.tsx) |
| Manual payment input | `datetime-local` value gets an explicit `+08:00` before conversion to ISO; API requires and parses an ISO timestamp with offset | [`app/(staff)/leases/[leaseId]/record-payment-form.tsx`](./app/(staff)/leases/[leaseId]/record-payment-form.tsx), [`app/api/leases/[leaseId]/payments/route.ts`](./app/api/leases/[leaseId]/payments/route.ts) |
| Gateway payment timestamp | Signed `paid_at` includes an offset and is parsed as an instant; invalid values are rejected | [`app/api/webhooks/gateway/route.ts`](./app/api/webhooks/gateway/route.ts) |
| Lease and invoice calendar dates | `YYYY-MM-DD` strings are converted to UTC-midnight `Date` values for PostgreSQL `date` columns; schedule-day arithmetic uses `Date.UTC` only | [`app/api/leases/route.ts`](./app/api/leases/route.ts), [`lib/billing.ts`](./lib/billing.ts), [`lib/myt.ts`](./lib/myt.ts) |

No code path uses `.getHours()`, `.getDate()`, `.getMonth()` etc. on an unshifted `Date` object for calendar decisions, so the result is the same under `TZ=UTC`, `TZ=Asia/Kuala_Lumpur`, and `TZ=America/New_York`.

---

## 4. Which queries bypass RLS and how is authorization enforced for them?

**Prisma uses the `DATABASE_URL` connection** (PostgreSQL role `postgres`, the superuser). Postgres superusers bypass RLS entirely. This means every Prisma query executes without RLS filtering.

**How org isolation is enforced instead:**

Every API handler:
1. Calls `getSession()` → derives `orgId` from the `memberships` table (not user_metadata). [`lib/auth.ts`](file:///c:/ezyfusion-rentals/lib/auth.ts#L34-L46)
2. Includes `orgId: session.orgId!` in every `where` clause:
   - Lease lookup: `prisma.lease.findFirst({ where: { id: leaseId, orgId: session.orgId! } })` — [`app/api/leases/[leaseId]/route.ts`](file:///c:/ezyfusion-rentals/app/api/leases/[leaseId]/route.ts)
   - Payment lookup: `prisma.payment.findFirst({ where: { id: paymentId, orgId: session.orgId! } })` — [`app/api/payments/[paymentId]/approve/route.ts`](file:///c:/ezyfusion-rentals/app/api/payments/[paymentId]/approve/route.ts#L25)
   - All payment inserts include `orgId: session.orgId!`
3. Returns `notFound()` (HTTP 404) for cross-org queries, leaking no information about other organizations' data.

**Supabase Data API (PostgREST) uses RLS** via the authenticated JWT. RLS policies are defined in the migration for all tables and allow access only within the user's organization. The `anon` role has no grants. See [`supabase/migrations/20260101000000_init.sql`](file:///c:/ezyfusion-rentals/supabase/migrations/20260101000000_init.sql).

---

## 5. What happens to allocations when a payment is voided, and why is that safe?

**What happens:**
1. `deallocate(tx, paymentId)` deletes all `payment_allocations` rows for the voided payment.
2. The payment's `unapplied_sen` is reset to `0`.
3. The payment's `status` is set to `'voided'`.
4. No other payments' allocations are changed.

**Why this is safe:**

Invoices can now show more outstanding balance, which is correct — the payment is gone. The cap for future payments is recalculated live (total invoiced − total allocated by approved payments), so after voiding, new payments can be recorded up to the freed amount.

**Online payments (gateway):** Any existing `unapplied_sen` remains on that payment and is not included in invoice allocations. The reopened invoice remains due until the unapplied amount is reconciled or refunded; the app does not silently reallocate another payment.

**No redistribution:** We deliberately do not re-allocate other payments after voiding because the brief says other payments' allocations do not change, and redistributing could change which invoices are considered paid retroactively. Any existing `unapplied_sen` remains visible and must be reconciled or refunded; it does not automatically reduce the newly reopened invoice balance.

**Relevant code:** [`app/api/payments/[paymentId]/void/route.ts`](file:///c:/ezyfusion-rentals/app/api/payments/[paymentId]/void/route.ts#L42-L45) and [`lib/allocation.ts`](file:///c:/ezyfusion-rentals/lib/allocation.ts#L66-L69)

---

## 6. What mistakes did the AI assistant make, and what did you correct?

Two representative examples are summarized in [`ai-logs/README.md`](./ai-logs/README.md):

### Mistake 1 — Wrong Prisma client import path

The AI initially suggested importing from `@/app/generated/prisma` (the directory), expecting an `index.ts` barrel file. Prisma 7 generates the client at `@/app/generated/prisma/client` (the `client.ts` file directly), with no `index.ts`. This caused a TypeScript error: `Module has no exported member 'PrismaClient'`.

**Corrected to:**
```ts
// lib/prisma.ts, lib/allocation.ts, all route files
import type { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaClient as PC } from '@/app/generated/prisma/client'
```

### Mistake 2 — Wrong allocation order for `kind` field

The AI initially suggested `orderBy: { kind: 'desc' }` reasoning that 'deposit' comes after 'rent' alphabetically. In fact, `'deposit' < 'rent'` in ASCII/Unicode order, so `'asc'` correctly places deposit before rent.

**Corrected to (in `lib/allocation.ts` L26-28):**
```ts
orderBy: [
  { dueDate: 'asc' },
  { kind: 'asc' },   // 'deposit' < 'rent' alphabetically → deposit first ✓
  { periodIndex: 'asc' },
],
```

This is verified by the seed data: Aisyah's RM 3,000 cash payment on 2026-01-31 should allocate to the RM 3,000 deposit first, then RM 1,500 rent period 0, and leave the remaining RM 1,500 unapplied (all three allocations visible in `payment_allocations`).

**Submission note:** The AI log folder currently contains only the summary, not exported session transcripts. Add the actual transcript export(s) before submission so these corrections can be verified.
