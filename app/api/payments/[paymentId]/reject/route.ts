/**
 * POST /api/payments/:paymentId/reject
 * Reject a pending_verification payment. Manager only.
 * Requires a reason of at least 5 characters.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireManager, notFound } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { writeAuditLog } from '@/lib/audit'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const [session, err] = await requireManager()
  if (err) return err

  const { paymentId } = await params

  let body: { reason: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.reason || body.reason.trim().length < 5) {
    return NextResponse.json({ error: 'reason must be at least 5 characters' }, { status: 400 })
  }

  const prisma = getPrisma()

  const existingPayment = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: session.orgId! },
    select: { id: true },
  })
  if (!existingPayment) return notFound()

  let payment
  try {
    payment = await prisma.$transaction(async (tx) => {
      type LockedPayment = { id: string; lease_id: string; status: string }
      const rows = await tx.$queryRaw<LockedPayment[]>`
        SELECT id, lease_id, status FROM payments
        WHERE id = ${paymentId}::uuid AND org_id = ${session.orgId}::uuid
        FOR UPDATE
      `
      if (rows.length === 0) throw new Error('NOT_FOUND')
      if (rows[0].status !== 'pending_verification') throw new Error('NOT_PENDING')

      await tx.$queryRaw`SELECT id FROM leases WHERE id = ${rows[0].lease_id}::uuid FOR UPDATE`
      return tx.payment.update({ where: { id: paymentId }, data: { status: 'rejected' } })
    }, { isolationLevel: 'ReadCommitted' })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') return notFound()
    if (e instanceof Error && e.message === 'NOT_PENDING') {
      return NextResponse.json({ error: 'Payment is not pending_verification' }, { status: 409 })
    }
    console.error('Reject error:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  await writeAuditLog({
    orgId: session.orgId!,
    actorId: session.userId,
    action: 'payment.rejected',
    entityId: payment.id,
    details: { reason: body.reason },
  })

  return NextResponse.json({ status: payment.status })
}
