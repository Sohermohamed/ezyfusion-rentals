# EzyFusion Rentals — Rent Collection Module

Technical assessment submission. Stack: **Next.js 16 (App Router) · TypeScript · Supabase (local) · Prisma 7 · shadcn/ui · Tailwind CSS v4**.

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker (for local Supabase)
- Supabase CLI (`npm install -g supabase`)

### 1. Start the local Supabase stack

```bash
npx supabase start
```

Take note of the output values — you'll need them in step 3.

### 2. Reset the database

```bash
npx supabase db reset
```

This runs all migrations from `supabase/migrations/`.

### 3. Install dependencies and configure environment

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and replace the placeholder values with the actual values
from `npx supabase status`. Key variables:

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `API URL` from `supabase status` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `Publishable key` from `supabase status` |
| `SUPABASE_SECRET_KEY` | `Secret key` from `supabase status` |
| `DATABASE_URL` | `DB URL` from `supabase status` |
| `GATEWAY_X_SIGNATURE_KEY` | Any string (shared secret with gateway) |

### 4. Seed the database

```bash
npm run seed
```

This creates all organizations, users, leases, invoices, and sample payments
via the same code paths the app uses at runtime.

### 5. Build and start

```bash
npm run build && npm start
```

Open [http://localhost:3000](http://localhost:3000).

---

## Test Accounts

All seeded accounts share the password: **`Seed1234!`**

| Email | Role | Organization |
|---|---|---|
| `manager@northwind.test` | manager | Northwind Properties |
| `staff@northwind.test` | staff | Northwind Properties |
| `aisyah@northwind.test` | tenant | Northwind Properties |
| `ben@northwind.test` | tenant | Northwind Properties |
| `probe@northwind.test` | tenant | Northwind Properties |
| `manager@beta.test` | manager | Beta Realty |
| `chen@beta.test` | tenant | Beta Realty |

---

## Running Billing Tests

```bash
npx tsx lib/billing.test.ts
```

All 61 tests should pass.

---

## Gateway Simulator

To simulate a payment gateway callback (webhook) locally:

```bash
# Simulate a successful payment
GATEWAY_X_SIGNATURE_KEY=<your key> node gateway-sim.mjs <bill_id> true <amount_in_sen>

# Simulate a failed payment
GATEWAY_X_SIGNATURE_KEY=<your key> node gateway-sim.mjs <bill_id> false 0

# Use a custom webhook URL (default: http://localhost:3000/api/webhooks/gateway)
GATEWAY_X_SIGNATURE_KEY=<your key> WEBHOOK_URL=http://localhost:3000/api/webhooks/gateway \
  node gateway-sim.mjs bill_xyz123 true 150000
```

The bill ID comes from `POST /api/leases/:leaseId/gateway-bills` (accessible from the tenant portal "Pay Now" button).

---

## Project Structure

```
lib/
  billing.ts          Pure billing functions (generateSchedule, invoiceStatus, parseRinggitToSen)
  billing.test.ts     61 unit tests for billing functions
  auth.ts             Server-side auth (role from DB, never user_metadata)
  allocation.ts       Invoice allocation and deallocation logic
  myt.ts              Malaysia Time utilities (timezone-independent)
  audit.ts            Audit log writer (bypasses RLS via raw SQL)
  prisma.ts           Singleton Prisma client
  supabase/
    server.ts         Server Supabase client (cookies + Bearer header)
    client.ts         Browser Supabase client (publishable key only)

app/
  api/
    leases/           CRUD + invoice status
    leases/[leaseId]/payments/   Record payments (cap-checked, locked)
    leases/[leaseId]/gateway-bills/  Create online payment bills
    payments/[paymentId]/approve/    Approve pending payment
    payments/[paymentId]/reject/     Reject pending payment
    payments/[paymentId]/void/       Void approved payment
    reports/collections/             Monthly collections report (MYT)
    webhooks/gateway/                HMAC-verified, idempotent, locked
  (staff)/            Manager/staff UI (dashboard, lease list, detail)
  (tenant)/portal/    Tenant portal (invoices, payments, Pay Now)
  payments/return/    Gateway return page (read-only status display)

scripts/
  seed.ts             Database seeder

supabase/
  migrations/         SQL migrations (schema + RLS + storage)

gateway-sim.mjs       Local gateway callback simulator
REVIEW.md             Code review of reference implementation
DECISIONS.md          Design decisions (6 questions)
```

---

## What Was Implemented

### ✅ Billing functions (`lib/billing.ts`)
- `generateSchedule`: Month-anchor algorithm, leap-year aware, proration with round-half-up
- `invoiceStatus`: MYT-based status (paid / partially_paid / unpaid / overdue)
- `parseRinggitToSen`: Strict validation (no sign, no scientific notation, correct comma grouping)
- 61 unit tests — all pass

### ✅ Database schema and RLS (`supabase/migrations/`)
- All required tables with correct types (bigint for money, date for periods, timestamptz for timestamps)
- Row-Level Security on every table; `anon` role has no grants
- `payment-slips` storage bucket (private, 5 MB limit) with org-scoped RLS
- Audit log: append-only trigger prevents DELETE/UPDATE; RLS blocks direct inserts via Data API
- SECURITY DEFINER helper functions for RLS predicates

### ✅ API routes
- All endpoints return exact required response shapes
- 401 for unauthenticated, 403 for wrong role, 404 for cross-org (no data leakage)
- Bearer token authentication supported alongside cookie sessions
- Concurrency: `FOR UPDATE` + Serializable isolation on payment recording, approval, and webhook

### ✅ Webhook (`POST /api/webhooks/gateway`)
- HMAC-SHA256 constant-time signature verification
- Idempotent: duplicate callbacks return 200, no second payment created
- Concurrency-safe: row lock prevents race between simultaneous callbacks
- `paid_at` from gateway payload used for `received_at` (not server clock)
- Never logs the HMAC key or full payload

### ✅ Malaysia Time handling
- All date calculations use `Date.getTime() + 8*3600*1000` — no server `TZ` dependence
- Collections SQL uses `AT TIME ZONE 'Asia/Kuala_Lumpur'` for correct monthly grouping
- Works identically under `TZ=UTC`, `TZ=Asia/Kuala_Lumpur`, `TZ=America/New_York`

### ✅ Seed data
- All 7 required accounts (password: `Seed1234!`)
- All 5 leases with correct invoices generated by `generateSchedule`
- Aisyah's 2 payments with correct allocations

### ✅ UI
- Login / logout
- Manager/staff dashboard: overdue count, 6-month collections table
- Lease list and detail with invoice status badges (live MYT status)
- Record payment form with file upload (slip) and rollback on failure
- Approve / reject / void actions (manager only)
- Tenant portal: view invoices, payments, Pay Now button, phone edit
- Gateway return page (`/payments/return`) — read-only status only

---

## What Was Skipped / Known Limitations

- **Automated integration tests**: No Jest/Vitest test suite for API routes or webhook. Billing functions have their own test runner (`npx tsx lib/billing.test.ts`).
- **AI transcript exports**: `ai-logs/` currently contains a session summary but no exported conversation transcript. Export and add the actual transcript(s) before submission.
- **Pagination**: Lease and payment lists return all records — no cursor/offset pagination.
- **Email notifications**: Not mentioned in the brief; not implemented.
- **Refresh on the gateway return page**: The `/payments/return` page does not auto-poll for status changes; the user must reload.
- **UI for audit log**: No UI view for the audit log (the brief does not require one).
- **Error boundaries**: Basic; the UI shows raw error messages from the server in some cases.

---

## Environment Variables Reference

See `.env.example` for all required variables with comments.

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase API URL (from `supabase status`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Yes | Supabase secret key (server-only, never sent to browser) |
| `DATABASE_URL` | Yes | Direct PostgreSQL connection string for Prisma |
| `GATEWAY_X_SIGNATURE_KEY` | Yes | Shared HMAC-SHA256 key with payment gateway |
