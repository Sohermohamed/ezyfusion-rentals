/**
 * POST /api/payments/:paymentId/approve
 * Approve a pending_verification payment. Manager only.
 * Re-checks cap inside a locked transaction.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireManager, notFound } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { allocate } from '@/lib/allocation'
import { writeAuditLog } from '@/lib/audit'
import type { PrismaClient } from '@/app/generated/prisma/client'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const [session, err] = await requireManager()
  if (err) return err

  const { paymentId } = await params
  const prisma = getPrisma()

  const existing = await prisma.payment.findFirst({ where: { id: paymentId, orgId: session.orgId! } })
  if (!existing) return notFound()
  if (existing.status !== 'pending_verification') {
    return NextResponse.json({ error: 'Payment is not pending_verification' }, { status: 409 })
  }

  try {
    const payment = await prisma.$transaction(async (tx: Tx) => {
      // Lock payment row to prevent double approval
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`

      const locked = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })
      if (locked.status !== 'pending_verification') throw new Error('NOT_PENDING')

      // Serialize cap checks and approvals with other payment changes on this lease.
      await tx.$queryRaw`SELECT id FROM leases WHERE id = ${locked.leaseId}::uuid FOR UPDATE`

      // Re-check cap: remaining balance excluding THIS pending payment
      const [invSum, allocSum, otherPendingSum] = await Promise.all([
        tx.invoice.aggregate({ where: { leaseId: locked.leaseId }, _sum: { amountSen: true } }),
        tx.paymentAllocation.aggregate({ where: { payment: { leaseId: locked.leaseId } }, _sum: { amountSen: true } }),
        tx.payment.aggregate({
          where: { leaseId: locked.leaseId, status: 'pending_verification', id: { not: paymentId } },
          _sum: { amountSen: true },
        }),
      ])

      const remaining =
        (invSum._sum.amountSen ?? BigInt(0)) -
        (allocSum._sum.amountSen ?? BigInt(0)) -
        (otherPendingSum._sum.amountSen ?? BigInt(0))

      if (locked.amountSen > remaining) throw new Error('OVER_BALANCE')

      const updated = await tx.payment.update({ where: { id: paymentId }, data: { status: 'approved' } })
      await allocate(tx, paymentId)
      return updated
    }, { isolationLevel: 'ReadCommitted' })

    await writeAuditLog({
      orgId: session.orgId!,
      actorId: session.userId,
      action: 'payment.approved',
      entityId: payment.id,
      details: { amountSen: Number(payment.amountSen) },
    })

    return NextResponse.json({ status: payment.status })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_PENDING')
      return NextResponse.json({ error: 'Payment is not pending_verification' }, { status: 409 })
    if (e instanceof Error && e.message === 'OVER_BALANCE')
      return NextResponse.json({ error: 'Payment exceeds remaining balance' }, { status: 422 })
    console.error('Approve error:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
