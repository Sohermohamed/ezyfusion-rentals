/**
 * POST /api/webhooks/gateway
 * Gateway payment callback.
 * Verifies HMAC-SHA256 signature. Idempotent. Concurrency-safe via DB locking.
 * Never logs the secret key or complete payloads.
 */
import { createHmac } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { allocate } from '@/lib/allocation'
import type { PrismaClient } from '@/app/generated/prisma/client'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

function verifySignature(fields: Record<string, string>, sig: string, key: string): boolean {
  const source = Object.keys(fields)
    .filter((k) => k !== 'x_signature')
    .sort()
    .map((k) => `${k}${fields[k]}`)
    .join('|')
  const computed = createHmac('sha256', key).update(source).digest('hex')
  // Constant-time compare
  if (computed.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ sig.charCodeAt(i)
  }
  return diff === 0
}

export async function POST(req: NextRequest) {
  const key = process.env.GATEWAY_X_SIGNATURE_KEY
  if (!key) {
    console.error('[webhook] GATEWAY_X_SIGNATURE_KEY not configured')
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  let fields: Record<string, string>
  try {
    const fd = await req.formData()
    fields = Object.fromEntries(fd) as Record<string, string>
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const sig = fields.x_signature
  if (!sig || !verifySignature(fields, sig, key)) {
    // Do not log fields (may contain sensitive data)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const billId = fields.id
  if (!billId || (fields.paid !== 'true' && fields.paid !== 'false')) {
    return NextResponse.json({ error: 'Invalid callback fields' }, { status: 400 })
  }
  const paid = fields.paid === 'true'

  const prisma = getPrisma()

  try {
    await prisma.$transaction(async (tx: Tx) => {
      // Serialize all callbacks for this bill so late failure callbacks cannot
      // overwrite a successful payment and duplicate success callbacks are idempotent.
      type BillRow = { id: string; status: string; amount_sen: bigint; org_id: string; lease_id: string }
      const bills = await tx.$queryRaw<BillRow[]>`
        SELECT id, status, amount_sen, org_id, lease_id
        FROM gateway_bills WHERE id = ${billId} FOR UPDATE
      `
      if (bills.length === 0) throw new Error('NOT_FOUND')

      const bill = bills[0]
      if (bill.status === 'paid') return

      if (!paid) {
        if (bill.status === 'pending') {
          await tx.gatewayBill.update({ where: { id: billId }, data: { status: 'failed' } })
        }
        return
      }

      if (!/^\d+$/.test(fields.paid_amount ?? '')) throw new Error('AMOUNT_MISMATCH')
      const paidAmountSen = BigInt(fields.paid_amount)
      if (paidAmountSen !== bill.amount_sen) throw new Error('AMOUNT_MISMATCH')

      // Parse paid_at: 'YYYY-MM-DD HH:mm:ss +0800'
      const normalized = (fields.paid_at ?? '')
        .replace(' ', 'T')
        .replace(/\s+([+-]\d{2})(\d{2})$/, '$1:$2')
      const receivedAt = new Date(normalized)
      if (isNaN(receivedAt.getTime())) throw new Error('INVALID_PAID_AT')

      // Serialize allocations across different bills for the same lease.
      await tx.$queryRaw`SELECT id FROM leases WHERE id = ${bill.lease_id}::uuid FOR UPDATE`
      await tx.gatewayBill.update({ where: { id: billId }, data: { status: 'paid' } })

      const payment = await tx.payment.create({
        data: {
          orgId: bill.org_id,
          leaseId: bill.lease_id,
          amountSen: paidAmountSen,
          unappliedSen: BigInt(0),
          method: 'online',
          status: 'approved',
          receivedAt,
          gatewayBillId: billId,
        },
      })

      await allocate(tx, payment.id)
    }, { isolationLevel: 'ReadCommitted' })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') return NextResponse.json({ error: 'Unknown bill' }, { status: 404 })
      if (e.message === 'AMOUNT_MISMATCH') return NextResponse.json({ error: 'paid_amount does not match bill amount' }, { status: 422 })
      if (e.message === 'INVALID_PAID_AT') return NextResponse.json({ error: 'paid_at must be a valid timestamp' }, { status: 400 })
    }
    console.error('[webhook] Processing error:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
