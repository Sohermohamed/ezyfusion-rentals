/**
 * POST /api/leases/:leaseId/gateway-bills
 * Creates a gateway bill for the amount due now (MYT). Tenant only.
 * Amount = sum of unpaid amounts for invoices due on or before today (MYT).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession, unauthorized, notFound, forbidden } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { todayMYT } from '@/lib/myt'
import { randomBytes } from 'crypto'

function generateBillId(): string {
  // 32 bytes = 256 bits of randomness, base64url encoded
  return 'bill_' + randomBytes(32).toString('base64url')
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ leaseId: string }> },
) {
  const session = await getSession()
  if (!session) return unauthorized()
  if (session.role !== 'tenant') return forbidden()

  const { leaseId } = await params
  const prisma = getPrisma()

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    include: {
      invoices: { include: { paymentAllocations: true } },
    },
  })

  if (!lease) return notFound()
  if (lease.tenantId !== session.tenantId) return notFound()

  const today = todayMYT()
  let amountDue = BigInt(0)

  for (const inv of lease.invoices) {
    // Compare YYYY-MM-DD strings: date stored as Date in DB, format as YYYY-MM-DD
    const dueDateStr = inv.dueDate.toISOString().slice(0, 10)
    if (dueDateStr > today) continue

    const paid = inv.paymentAllocations.reduce(
      (s: bigint, a: { amountSen: bigint }) => s + a.amountSen,
      BigInt(0),
    )
    const unpaid = inv.amountSen - paid
    if (unpaid > BigInt(0)) amountDue += unpaid
  }

  if (amountDue <= BigInt(0)) {
    return NextResponse.json({ error: 'Nothing is due now' }, { status: 422 })
  }

  const bill = await prisma.gatewayBill.create({
    data: {
      id: generateBillId(),
      orgId: lease.orgId,
      leaseId: lease.id,
      amountSen: amountDue,
      status: 'pending',
    },
  })

  return NextResponse.json({ billId: bill.id, amountSen: Number(bill.amountSen) }, { status: 201 })
}
