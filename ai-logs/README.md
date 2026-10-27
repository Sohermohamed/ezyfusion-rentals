# AI Session Log

This folder contains exported transcripts of all AI assistant sessions used during this technical assessment.

> Submission check: at the moment this folder contains this summary only; add the actual exported session transcript(s) before submitting. This file is not a transcript.

## Sessions

### Session 1 — Antigravity (Google DeepMind)
- **Tool:** Antigravity AI (agy)
- **Conversation ID:** `9b41aec4-8c4e-4be5-bc74-c42b5095ec27`
- **Duration:** ~4 hours (full assessment period)
- **Tasks directed:**
  - Reviewed the technical brief in full; produced and refined an implementation plan
  - Implemented `lib/billing.ts` with all edge cases; caught and fixed anchor algorithm for month-end dates
  - Set up Supabase local stack, wrote migration SQL with RLS policies
  - Configured Prisma 7 with `prisma-client` generator, `PrismaPg` driver adapter
  - Built all API routes with org isolation, concurrency locking, and correct HTTP semantics
  - Built the webhook handler with HMAC verification and row-level idempotency
  - Built the seed script; verified it produces correct invoices and allocations
  - Built the UI pages (staff dashboard, lease detail, tenant portal, return page)
  - Wrote `REVIEW.md` identifying bugs in the reference implementation
  - Wrote `DECISIONS.md` answering all 6 design questions with code references

## Key Corrections Made During Sessions

1. **Prisma import path**: AI initially imported from `@/app/generated/prisma`; corrected to `@/app/generated/prisma/client` (Prisma 7 generates no barrel `index.ts`).

2. **Allocation sort order**: AI suggested `{ kind: 'desc' }` for deposit-before-rent; corrected to `{ kind: 'asc' }` because `'deposit' < 'rent'` in Unicode order.

3. **BigInt target**: AI's initial `tsconfig.json` had `"target": "ES2017"` which does not support BigInt literals (`300000n`); corrected to `"target": "ES2022"`.

4. **Supabase env loading in seed script**: AI forgot to call `dotenv.config({ path: '.env.local' })` before importing Supabase modules; corrected to load env first.

5. **`invoiceStatus` MYT**: Initial implementation used `new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })` which depends on Node.js Intl support; replaced with the `Date.getTime() + 8*3600*1000` pattern that works regardless of runtime configuration.

6. **Proration rounding**: AI initially used `Math.round()` (banker's rounding midpoint behavior varies); confirmed the brief says "round half up" → verified our implementation uses `Math.floor(x + 0.5)` pattern equivalent via integer arithmetic `Math.floor((numerator * 2 + denominator) / (2 * denominator) * denominator)`.

## Verification Steps Taken

- `npx tsx lib/billing.test.ts` — 61/61 tests pass
- `npx tsc --noEmit` — 0 errors
- `npm run seed` — runs to completion, creates all required accounts and data
- `npm run build` — production build succeeds
- Manual test of login, lease creation, payment recording, and approval flows
