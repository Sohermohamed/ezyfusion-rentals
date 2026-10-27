/**
 * POST /api/leases/:leaseId/payments
 * Record cash or bank_transfer payment. Staff or manager.
 * Manager → approved immediately. Staff → pending_verification.
 * Cap enforced with DB-level locking.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireStaffOrManager, notFound } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { allocate } from '@/lib/allocation'
import { writeAuditLog } from '@/lib/audit'
import { createClient } from '@/lib/supabase/server'
import type { PrismaClient } from '@/app/generated/prisma/client'

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leaseId: string }> },
) {
  const [session, err] = await requireStaffOrManager()
  if (err) return err

  const { leaseId } = await params

  let body: { amountSen?: unknown; method?: unknown; receivedAt?: unknown; slipPath?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { amountSen, method, receivedAt, slipPath } = body

  if (!amountSen || !method || !receivedAt) {
    return NextResponse.json({ error: 'Missing required fields: amountSen, method, receivedAt' }, { status: 400 })
  }
  if (!['cash', 'bank_transfer'].includes(method as string)) {
    return NextResponse.json({ error: 'method must be cash or bank_transfer' }, { status: 400 })
  }
  if (typeof amountSen !== 'number' || !Number.isSafeInteger(amountSen) || amountSen <= 0) {
    return NextResponse.json({ error: 'amountSen must be a positive integer' }, { status: 400 })
  }
  if (method === 'bank_transfer' && !slipPath) {
    return NextResponse.json({ error: 'slipPath is required for bank_transfer' }, { status: 400 })
  }
  if (slipPath && typeof slipPath !== 'string') {
    return NextResponse.json({ error: 'slipPath must be a string' }, { status: 400 })
  }

  const timestamp = typeof receivedAt === 'string' ? receivedAt : ''
  const timestampMatch =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(timestamp)
  if (!timestampMatch) {
    return NextResponse.json({ error: 'receivedAt must be a valid ISO 8601 date-time' }, { status: 400 })
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = timestampMatch
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText ?? '0')
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const offsetHour = Number(offsetHourText ?? '0')
  const offsetMinute = Number(offsetMinuteText ?? '0')
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return NextResponse.json({ error: 'receivedAt must be a valid ISO 8601 date-time' }, { status: 400 })
  }
  const receivedAtDate = new Date(timestamp)
  if (isNaN(receivedAtDate.getTime())) {
    return NextResponse.json({ error: 'receivedAt must be a valid ISO 8601 date-time' }, { status: 400 })
  }

  if (slipPath) {
    const path = slipPath as string
    const segments = path.split('/')
    if (
      segments.length < 2 ||
      segments[0] !== session.orgId ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      return NextResponse.json({ error: 'slipPath must be in your organization folder' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: file, error } = await supabase.storage.from('payment-slips').info(path)
    if (error || !file) {
      return NextResponse.json({ error: 'slipPath must reference an existing file' }, { status: 400 })
    }
    if (
      file.size === undefined ||
      file.size > 5 * 1024 * 1024 ||
      !['image/jpeg', 'image/png', 'application/pdf'].includes(file.contentType ?? '')
    ) {
      return NextResponse.json({ error: 'Slip must be a JPEG, PNG, or PDF no larger than 5 MB' }, { status: 400 })
    }
  }

  const prisma = getPrisma()

  const lease = await prisma.lease.findFirst({ where: { id: leaseId, orgId: session.orgId! } })
  if (!lease) return notFound()

  try {
    const payment = await prisma.$transaction(async (tx: Tx) => {
      // Lock lease row to prevent concurrent cap violations
      await tx.$queryRaw`SELECT id FROM leases WHERE id = ${leaseId}::uuid FOR UPDATE`

      const [invoiceSum, allocSum, pendingSum] = await Promise.all([
        tx.invoice.aggregate({ where: { leaseId }, _sum: { amountSen: true } }),
        tx.paymentAllocation.aggregate({ where: { payment: { leaseId } }, _sum: { amountSen: true } }),
        tx.payment.aggregate({ where: { leaseId, status: 'pending_verification' }, _sum: { amountSen: true } }),
      ])

      const total = invoiceSum._sum.amountSen ?? BigInt(0)
      const allocated = allocSum._sum.amountSen ?? BigInt(0)
      const pending = pendingSum._sum.amountSen ?? BigInt(0)
      const cap = total - allocated - pending

      if (BigInt(amountSen as number) > cap) throw new Error('CAP_EXCEEDED')

      const isManager = session.role === 'manager'
      const status = isManager ? 'approved' : 'pending_verification'

      const newPayment = await tx.payment.create({
        data: {
          orgId: session.orgId!,
          leaseId,
          amountSen: BigInt(amountSen as number),
          unappliedSen: BigInt(0),
          method: method as string,
          status,
          receivedAt: receivedAtDate,
          slipPath: (slipPath as string | undefined) ?? null,
        },
      })

      if (isManager) await allocate(tx, newPayment.id)
      return newPayment
    }, { isolationLevel: 'ReadCommitted' })

    await writeAuditLog({
      orgId: session.orgId!,
      actorId: session.userId,
      action: 'payment.recorded',
      entityId: payment.id,
      details: { amountSen, method, leaseId, status: payment.status },
    })

    return NextResponse.json({ id: payment.id, status: payment.status }, { status: 201 })
  } catch (e) {
    if (e instanceof Error && e.message === 'CAP_EXCEEDED') {
      return NextResponse.json({ error: 'Payment exceeds remaining balance cap' }, { status: 422 })
    }
    // Prisma P2034: serialization failure or deadlock from concurrent transactions.
    // The winner already committed; losers failed cap check implicitly → 422.
    if (
      e != null &&
      typeof e === 'object' &&
      'code' in e &&
      (e as { code: string }).code === 'P2034'
    ) {
      return NextResponse.json({ error: 'Payment exceeds remaining balance cap (concurrent conflict)' }, { status: 422 })
    }
    console.error('Payment creation error:', e instanceof Error ? e.message : 'unknown')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
