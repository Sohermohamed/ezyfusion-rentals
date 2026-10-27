/**
 * GET /api/leases/:leaseId
 * Staff, manager, or the lease's own tenant.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession, notFound, unauthorized } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { invoiceStatus } from '@/lib/billing'
import { formatDateMYT } from '@/lib/myt'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leaseId: string }> },
) {
  const session = await getSession()
  if (!session) return unauthorized()

  const { leaseId } = await params
  const prisma = getPrisma()

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: {
      invoices: {
        include: { paymentAllocations: true },
        orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { periodIndex: 'asc' }],
      },
      payments: {
        orderBy: { receivedAt: 'asc' },
      },
    },
  })

  if (!lease) return notFound()

  if (session.role === 'tenant') {
    if (lease.tenantId !== session.tenantId) return notFound()
  } else {
    if (lease.orgId !== session.orgId) return notFound()
  }

  const now = new Date()

  return NextResponse.json({
    lease: {
      id: lease.id,
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      startDate: formatDateMYT(lease.startDate),
      endDate: formatDateMYT(lease.endDate),
      monthlyRentSen: Number(lease.monthlyRentSen),
      depositSen: Number(lease.depositSen),
    },
    invoices: lease.invoices.map((inv) => {
      const paidSen = inv.paymentAllocations.reduce(
        (sum: number, a: { amountSen: bigint }) => sum + Number(a.amountSen), 0
      )
      const dueDateStr = formatDateMYT(inv.dueDate)
      return {
        id: inv.id,
        kind: inv.kind,
        periodIndex: inv.periodIndex,
        periodStart: inv.periodStart ? formatDateMYT(inv.periodStart) : null,
        periodEnd: inv.periodEnd ? formatDateMYT(inv.periodEnd) : null,
        dueDate: dueDateStr,
        amountSen: Number(inv.amountSen),
        paidSen,
        status: invoiceStatus({ dueDate: dueDateStr, amountSen: Number(inv.amountSen), paidSen }, now),
      }
    }),
    payments: lease.payments
      .filter((p: { status: string }) => p.status !== 'voided')
      .map((p: {
        id: string; amountSen: bigint; unappliedSen: bigint
        method: string; status: string; receivedAt: Date; slipPath: string | null
      }) => ({
        id: p.id,
        amountSen: Number(p.amountSen),
        unappliedSen: Number(p.unappliedSen),
        method: p.method,
        status: p.status,
        receivedAt: p.receivedAt.toISOString(),
        ...(p.slipPath ? { slipPath: p.slipPath } : {}),
      })),
  })
}
