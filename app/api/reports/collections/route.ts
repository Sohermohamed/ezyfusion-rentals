/**
 * GET /api/reports/collections?from=YYYY-MM&to=YYYY-MM
 * Returns total approved payments per calendar month (MYT) over a range.
 * Staff or manager.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireStaffOrManager } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { monthRange, monthStartMYT, nextMonthStartMYT } from '@/lib/myt'

export async function GET(req: NextRequest) {
  const [session, err] = await requireStaffOrManager()
  if (err) return err

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  // Validate
  if (!from || !to || !/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM' }, { status: 400 })
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be before or equal to to' }, { status: 400 })
  }

  const prisma = getPrisma()
  const orgId = session.orgId!

  // Get all months in range
  const months = monthRange(from, to)

  // Query approved payments, grouped by MYT month
  // received_at is stored in UTC; we shift to MYT (+8 hours) before grouping
  const rows = await prisma.$queryRaw<{ month: string; total: bigint }[]>`
    SELECT
      to_char(
        date_trunc('month', received_at AT TIME ZONE 'Asia/Kuala_Lumpur'),
        'YYYY-MM'
      ) AS month,
      COALESCE(SUM(amount_sen), 0) AS total
    FROM payments
    WHERE org_id = ${orgId}::uuid
      AND status = 'approved'
      AND received_at >= ${monthStartMYT(from)}
      AND received_at < ${nextMonthStartMYT(to)}
    GROUP BY 1
    ORDER BY 1
  `

  // Build a map for quick lookup
  const rowMap = new Map<string, bigint>()
  for (const row of rows) {
    rowMap.set(row.month, row.total)
  }

  // Return all months, including those with 0 collected
  const result = months.map((month) => ({
    month,
    collectedSen: Number(rowMap.get(month) ?? 0n),
  }))

  return NextResponse.json(result)
}
