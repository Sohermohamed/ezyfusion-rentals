/**
 * lib/allocation.ts
 * Invoice allocation logic for approved payments.
 *
 * Allocation order: due date ASC, then deposit before rent, then period index ASC.
 * 'deposit' < 'rent' alphabetically, so orderBy kind ASC puts deposit first.
 */
import { getPrisma } from '@/lib/prisma'
import type { PrismaClient } from '@/app/generated/prisma/client'

// Prisma 7 interactive transaction client type
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * Allocate a payment's amount to the lease's invoices.
 * Must be called inside a Serializable transaction with a lock already held.
 */
export async function allocate(tx: Tx, paymentId: string): Promise<void> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })

  // Allocation order from spec: due date, then deposit before rent, then period index
  // 'deposit' < 'rent' alphabetically → ASC puts deposit first ✓
  const invoices = await tx.invoice.findMany({
    where: { leaseId: payment.leaseId },
    orderBy: [
      { dueDate: 'asc' },
      { kind: 'asc' },   // 'deposit' before 'rent'
      { periodIndex: 'asc' },
    ],
  })

  // Sum existing allocations per invoice (to handle re-allocation scenarios)
  const existing = await tx.paymentAllocation.findMany({
    where: { invoiceId: { in: invoices.map((i) => i.id) } },
    select: { invoiceId: true, amountSen: true },
  })
  const paidMap = new Map<string, bigint>()
  for (const a of existing) {
    paidMap.set(a.invoiceId, (paidMap.get(a.invoiceId) ?? BigInt(0)) + a.amountSen)
  }

  let remaining = payment.amountSen

  for (const invoice of invoices) {
    if (remaining <= BigInt(0)) break
    const paid = paidMap.get(invoice.id) ?? BigInt(0)
    const unpaid = invoice.amountSen - paid
    if (unpaid <= BigInt(0)) continue

    const toAllocate = remaining < unpaid ? remaining : unpaid
    remaining -= toAllocate

    await tx.paymentAllocation.upsert({
      where: { paymentId_invoiceId: { paymentId: payment.id, invoiceId: invoice.id } },
      create: { orgId: payment.orgId, paymentId: payment.id, invoiceId: invoice.id, amountSen: toAllocate },
      update: { amountSen: toAllocate },
    })
  }

  await tx.payment.update({ where: { id: paymentId }, data: { unappliedSen: remaining } })
}

/**
 * Remove allocations for a payment (when voiding).
 */
export async function deallocate(tx: Tx, paymentId: string): Promise<void> {
  await tx.paymentAllocation.deleteMany({ where: { paymentId } })
  await tx.payment.update({ where: { id: paymentId }, data: { unappliedSen: BigInt(0) } })
}

/**
 * Compute lease remaining balance (total invoiced - total allocated by approved payments).
 * Used for cap calculations — call inside a locked transaction.
 */
export async function getLeaseBalance(leaseId: string): Promise<bigint> {
  const prisma = getPrisma()
  const [inv, alloc] = await Promise.all([
    prisma.invoice.aggregate({ where: { leaseId }, _sum: { amountSen: true } }),
    prisma.paymentAllocation.aggregate({ where: { payment: { leaseId } }, _sum: { amountSen: true } }),
  ])
  return (inv._sum.amountSen ?? BigInt(0)) - (alloc._sum.amountSen ?? BigInt(0))
}
