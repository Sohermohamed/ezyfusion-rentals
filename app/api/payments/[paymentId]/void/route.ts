/**
 * POST /api/payments/:paymentId/void
 * Void an approved payment. Manager only.
 * Reason must be at least 5 characters.
 * Removes allocations; unapplied_sen from online payments is NOT redistributed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireManager, notFound } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { deallocate } from '@/lib/allocation'
import { writeAuditLog } from '@/lib/audit'
import type { PrismaClient } from '@/app/generated/prisma/client'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const [session, err] = await requireManager()
  if (err) return err

  const { paymentId } = await params

  let body: { reason?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body.reason !== 'string' || body.reason.trim().length < 5) {
    return NextResponse.json({ error: 'reason must be at least 5 characters' }, { status: 400 })
  }

  const prisma = getPrisma()

  const existing = await prisma.payment.findFirst({
    where: { id: paymentId, orgId: session.orgId! },
    select: { id: true },
  })
  if (!existing) return notFound()

  let payment
  try {
    payment = await prisma.$transaction(async (tx: Tx) => {
      type LockedPayment = { id: string; lease_id: string; status: string }
      const rows = await tx.$queryRaw<LockedPayment[]>`
        SELECT id, lease_id, status FROM payments
        WHERE id = ${paymentId}::uuid AND org_id = ${session.orgId}::uuid
        FOR UPDATE
      `
      if (rows.length === 0) throw new Error('NOT_FOUND')
      if (rows[0].status !== 'approved') throw new Error('NOT_APPROVED')

      await tx.$queryRaw`SELECT id FROM leases WHERE id = ${rows[0].lease_id}::uuid FOR UPDATE`
      await deallocate(tx, paymentId)
      return tx.payment.update({ where: { id: paymentId }, data: { status: 'voided' } })
    }, { isolationLevel: 'ReadCommitted' })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') return notFound()
    if (e instanceof Error && e.message === 'NOT_APPROVED') {
      return NextResponse.json({ error: 'Payment is not approved' }, { status: 409 })
    }
    console.error('Void error:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  await writeAuditLog({
    orgId: session.orgId!,
    actorId: session.userId,
    action: 'payment.voided',
    entityId: payment.id,
    details: { reason: body.reason as string },
  })

  return NextResponse.json({ status: payment.status })
}
