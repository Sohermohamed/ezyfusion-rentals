/**
 * app/(staff)/leases/page.tsx
 * List of leases for the org.
 */
export const instant = false

import { getSession } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { invoiceStatus } from '@/lib/billing'
import { formatDateMYT } from '@/lib/myt'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'

export default async function LeasesPage() {
  const session = await getSession()
  if (!session || session.role === 'tenant') redirect('/login')

  const prisma = getPrisma()
  await connection()
  const now = new Date()

  const leases = await prisma.lease.findMany({
    where: { orgId: session.orgId! },
    include: {
      unit: true,
      tenant: true,
      invoices: { include: { paymentAllocations: true } },
    },
    orderBy: { startDate: 'desc' },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Leases</h1>
      </div>

      {leases.length === 0 ? (
        <p className="text-slate-500">No leases found.</p>
      ) : (
        <div className="space-y-3">
          {leases.map((lease) => {
            // Count overdue invoices
            let overdueCount = 0
            for (const inv of lease.invoices) {
              const paid = Number(inv.paymentAllocations.reduce((s, a) => s + a.amountSen, BigInt(0)))
              const st = invoiceStatus(
                { dueDate: inv.dueDate.toISOString().slice(0, 10), amountSen: Number(inv.amountSen), paidSen: paid },
                now,
              )
              if (st === 'overdue') overdueCount++
            }

            return (
              <Link key={lease.id} href={`/leases/${lease.id}`} className="block">
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-slate-900">{lease.unit.name}</div>
                        <div className="text-sm text-slate-600">{lease.tenant.fullName}</div>
                        <div className="text-xs text-slate-500 mt-1">
                          {formatDateMYT(lease.startDate)} → {formatDateMYT(lease.endDate)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-slate-900">
                          RM {(Number(lease.monthlyRentSen) / 100).toFixed(2)}/mo
                        </div>
                        {overdueCount > 0 && (
                          <Badge variant="destructive" className="mt-1">{overdueCount} overdue</Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
