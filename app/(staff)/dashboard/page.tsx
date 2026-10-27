/**
 * app/(staff)/dashboard/page.tsx
 * Dashboard: overdue invoice count + collections for last 6 months.
 */
// This page performs per-request auth — opt out of static prerendering.
export const instant = false

import { getSession } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { invoiceStatus } from '@/lib/billing'
import { todayMYT, monthRange, thisMonthMYT, monthStartMYT, nextMonthStartMYT } from '@/lib/myt'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'

export default async function DashboardPage() {
  const session = await getSession()
  if (!session || session.role === 'tenant') redirect('/login')

  const prisma = getPrisma()
  const orgId = session.orgId!
  await connection()
  const now = new Date()
  const today = todayMYT(now)

  // Overdue invoices count
  const allInvoices = await prisma.invoice.findMany({
    where: { orgId },
    include: { paymentAllocations: true },
  })

  let overdueCount = 0
  for (const inv of allInvoices) {
    const paidSen = Number(inv.paymentAllocations.reduce((s, a) => s + a.amountSen, BigInt(0)))
    const status = invoiceStatus(
      { dueDate: inv.dueDate.toISOString().slice(0, 10), amountSen: Number(inv.amountSen), paidSen },
      now,
    )
    if (status === 'overdue') overdueCount++
  }

  // Collections last 6 months (MYT)
  const toMonth = thisMonthMYT(now)
  const [toY, toM] = toMonth.split('-').map(Number)
  const fromDate = new Date(Date.UTC(toY, toM - 7, 1)) // 6 months back
  const fromMonth = `${fromDate.getUTCFullYear()}-${String(fromDate.getUTCMonth() + 1).padStart(2, '0')}`
  const months = monthRange(fromMonth, toMonth)

  const rows = await prisma.$queryRaw<{ month: string; total: bigint }[]>`
    SELECT
      to_char(date_trunc('month', received_at AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM') AS month,
      COALESCE(SUM(amount_sen), 0) AS total
    FROM payments
    WHERE org_id = ${orgId}::uuid
      AND status = 'approved'
      AND received_at >= ${monthStartMYT(fromMonth)}
      AND received_at < ${nextMonthStartMYT(toMonth)}
    GROUP BY 1
    ORDER BY 1
  `

  const rowMap = new Map(rows.map((r) => [r.month, Number(r.total)]))
  const collections = months.map((m) => ({ month: m, collectedSen: rowMap.get(m) ?? 0 }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">Overview for {today} (Malaysia time)</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className={overdueCount > 0 ? 'border-red-300' : ''}>
          <CardHeader>
            <CardTitle className={`text-3xl font-bold ${overdueCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {overdueCount}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600">Overdue invoices</p>
            {overdueCount > 0 && (
              <Link href="/leases" className="text-sm text-red-600 underline mt-1 inline-block">
                View leases →
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Collections table */}
      <Card>
        <CardHeader>
          <CardTitle>Collections (last 6 months, Malaysia time)</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b">
                <th className="pb-2 pr-4">Month</th>
                <th className="pb-2 text-right">Collected (RM)</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.month} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-mono">{c.month}</td>
                  <td className="py-2 text-right font-mono">
                    {(c.collectedSen / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
