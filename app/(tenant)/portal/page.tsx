/**
 * app/(tenant)/portal/page.tsx
 * Tenant portal — lease, invoices, payments, Pay Now, phone edit.
 * All dates shown in Malaysia time. Uses Supabase client with RLS.
 */
export const instant = false

import { getSession } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { invoiceStatus } from '@/lib/billing'
import { todayMYT, formatDateMYT, formatMYT } from '@/lib/myt'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PayNowButton } from './pay-now-button'
import { PhoneEditForm } from './phone-edit-form'

function statusBadge(s: string) {
  const map: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'secondary' }> = {
    paid: { label: 'Paid', variant: 'success' },
    overdue: { label: 'Overdue', variant: 'destructive' },
    partially_paid: { label: 'Partial', variant: 'warning' },
    unpaid: { label: 'Unpaid', variant: 'secondary' },
  }
  const { label, variant } = map[s] ?? { label: s, variant: 'secondary' }
  return <Badge variant={variant}>{label}</Badge>
}

export default async function PortalPage() {
  const session = await getSession()
  if (!session || session.role !== 'tenant') redirect('/login')

  const prisma = getPrisma()
  await connection()
  const now = new Date()
  const today = todayMYT(now)

  // Tenant data
  const tenant = await prisma.tenant.findFirst({ where: { userId: session.userId } })
  if (!tenant) redirect('/login')

  // Lease with invoices
  const lease = await prisma.lease.findFirst({
    where: { tenantId: tenant.id },
    include: {
      unit: true,
      invoices: {
        include: { paymentAllocations: true },
        orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { periodIndex: 'asc' }],
      },
      payments: {
        where: { status: { not: 'voided' } },
        orderBy: { receivedAt: 'asc' },
      },
    },
  })

  if (!lease) {
    return (
      <div className="text-center py-20 text-slate-500">
        <p className="text-lg">No active lease found.</p>
        <p className="text-sm mt-2">Please contact your property manager.</p>
      </div>
    )
  }

  const invoicesWithStatus = lease.invoices.map((inv) => {
    const paidSen = Number(inv.paymentAllocations.reduce((s, a) => s + a.amountSen, BigInt(0)))
    const dueStr = inv.dueDate.toISOString().slice(0, 10)
    return {
      ...inv,
      paidSen,
      status: invoiceStatus({ dueDate: dueStr, amountSen: Number(inv.amountSen), paidSen }, now),
    }
  })

  // Amount due now: unpaid invoices with dueDate <= today (MYT)
  let amountDueNow = 0
  for (const inv of invoicesWithStatus) {
    if (inv.dueDate.toISOString().slice(0, 10) <= today && inv.status !== 'paid') {
      amountDueNow += Number(inv.amountSen) - inv.paidSen
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome, {tenant.fullName}</h1>
        <p className="text-slate-500 text-sm mt-1">Unit {lease.unit.name} · {formatDateMYT(lease.startDate)} to {formatDateMYT(lease.endDate)}</p>
      </div>

      {/* Amount due now */}
      {amountDueNow > 0 && (
        <Card className="border-orange-300 bg-orange-50">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-orange-900">Amount due now</p>
                <p className="text-2xl font-bold font-mono text-orange-900">RM {(amountDueNow / 100).toFixed(2)}</p>
              </div>
              <PayNowButton leaseId={lease.id} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Profile */}
      <Card>
        <CardHeader><CardTitle>My Profile</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div><span className="text-sm text-slate-500">Name: </span><span>{tenant.fullName}</span></div>
            <div><span className="text-sm text-slate-500">Email: </span><span>{tenant.email}</span></div>
            <div>
              <span className="text-sm text-slate-500">Phone: </span>
              <PhoneEditForm tenantId={tenant.id} currentPhone={tenant.phone} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Invoices */}
      <Card>
        <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500 border-b">
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Period</th>
                <th className="pb-2 pr-3">Due</th>
                <th className="pb-2 pr-3 text-right">Amount</th>
                <th className="pb-2 pr-3 text-right">Paid</th>
                <th className="pb-2">Status</th>
              </tr></thead>
              <tbody>
                {invoicesWithStatus.map((inv) => (
                  <tr key={inv.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 capitalize">{inv.kind}</td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {inv.periodStart ? `${formatDateMYT(inv.periodStart)} – ${inv.periodEnd ? formatDateMYT(inv.periodEnd) : ''}` : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono">{formatDateMYT(inv.dueDate)}</td>
                    <td className="py-2 pr-3 text-right font-mono">RM {(Number(inv.amountSen)/100).toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right font-mono">RM {(inv.paidSen/100).toFixed(2)}</td>
                    <td className="py-2">{statusBadge(inv.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Payments */}
      <Card>
        <CardHeader><CardTitle>My Payments</CardTitle></CardHeader>
        <CardContent>
          {lease.payments.length === 0 ? (
            <p className="text-slate-500 text-sm">No payments yet.</p>
          ) : (
            <div className="space-y-2">
              {lease.payments.map((p) => (
                <div key={p.id} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm">
                  <div>
                    <span className="font-mono font-semibold">RM {(Number(p.amountSen)/100).toFixed(2)}</span>
                    <span className="text-slate-500 ml-2 capitalize">{p.method.replace('_', ' ')}</span>
                    <span className="text-slate-400 ml-2 text-xs">{formatMYT(p.receivedAt)} MYT</span>
                  </div>
                  <Badge variant={p.status === 'approved' ? 'success' : p.status === 'pending_verification' ? 'warning' : 'secondary'}>
                    {p.status === 'pending_verification' ? 'Pending' : p.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
