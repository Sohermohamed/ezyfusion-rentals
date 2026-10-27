/**
 * POST /api/leases
 * Creates a lease + invoices atomically. Manager only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireManager, notFound } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { generateSchedule } from '@/lib/billing'
import { writeAuditLog } from '@/lib/audit'
import type { PrismaClient } from '@/app/generated/prisma/client'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export async function POST(req: NextRequest) {
  const [session, err] = await requireManager()
  if (err) return err

  let body: {
    unitId?: unknown
    tenantId?: unknown
    startDate?: unknown
    endDate?: unknown
    monthlyRentSen?: unknown
    depositSen?: unknown
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { unitId, tenantId, startDate, endDate, monthlyRentSen, depositSen } = body

  if (typeof unitId !== 'string' || typeof tenantId !== 'string' ||
      typeof startDate !== 'string' || typeof endDate !== 'string') {
    return NextResponse.json({ error: 'Missing required fields: unitId, tenantId, startDate, endDate' }, { status: 400 })
  }
  if (typeof monthlyRentSen !== 'number' || typeof depositSen !== 'number') {
    return NextResponse.json({ error: 'monthlyRentSen and depositSen must be numbers' }, { status: 400 })
  }

  let schedule: ReturnType<typeof generateSchedule>
  try {
    schedule = generateSchedule({ startDate, endDate, monthlyRentSen, depositSen })
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 })
  }

  const prisma = getPrisma()

  // Verify unit and tenant belong to manager's org
  const [unit, tenant] = await Promise.all([
    prisma.unit.findFirst({ where: { id: unitId, orgId: session.orgId! } }),
    prisma.tenant.findFirst({ where: { id: tenantId, orgId: session.orgId! } }),
  ])
  if (!unit) return notFound()
  if (!tenant) return notFound()

  try {
    const lease = await prisma.$transaction(async (tx: Tx) => {
      // Serialize lease creation for this unit, including when no lease exists yet.
      await tx.$queryRaw`SELECT id FROM units WHERE id = ${unitId}::uuid FOR UPDATE`
      const overlapping = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM leases
        WHERE unit_id = ${unitId}::uuid
          AND start_date <= ${endDate}::date
          AND end_date >= ${startDate}::date
      `
      if (overlapping.length > 0) throw new Error('OVERLAP')

      const newLease = await tx.lease.create({
        data: {
          orgId: session.orgId!,
          unitId,
          tenantId,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          monthlyRentSen: BigInt(monthlyRentSen),
          depositSen: BigInt(depositSen),
        },
      })

      await tx.invoice.createMany({
        data: schedule.map((inv) => ({
          orgId: session.orgId!,
          leaseId: newLease.id,
          kind: inv.kind,
          periodIndex: inv.periodIndex,
          periodStart: inv.periodStart ? new Date(inv.periodStart) : null,
          periodEnd: inv.periodEnd ? new Date(inv.periodEnd) : null,
          dueDate: new Date(inv.dueDate),
          amountSen: BigInt(inv.amountSen),
        })),
      })

      return newLease
    }, { isolationLevel: 'ReadCommitted' })

    await writeAuditLog({
      orgId: session.orgId!,
      actorId: session.userId,
      action: 'lease.created',
      entityId: lease.id,
      details: { unitId, tenantId, startDate, endDate, monthlyRentSen, depositSen },
    })

    return NextResponse.json({ id: lease.id }, { status: 201 })
  } catch (e) {
    if (e instanceof Error && e.message === 'OVERLAP') {
      return NextResponse.json({ error: 'Lease overlaps another lease on this unit' }, { status: 409 })
    }
    console.error('Error creating lease:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
