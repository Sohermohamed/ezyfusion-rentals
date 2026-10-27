/**
 * app/(staff)/leases/[leaseId]/page.tsx
 * Lease detail: invoices, payments, record payment, approve/reject/void.
 */
export const instant = false

import { getSession } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { redirect, notFound } from 'next/navigation'
import { connection } from 'next/server'
import { invoiceStatus } from '@/lib/billing'
import { formatDateMYT, formatMYT } from '@/lib/myt'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PaymentActions } from './payment-actions'
import { RecordPaymentForm } from './record-payment-form'
import Link from 'next/link'

function statusBadge(status: string) {
  const map: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'secondary' | 'default' }> = {
    paid: { label: 'Paid', variant: 'success' },
    overdue: { label: 'Overdue', variant: 'destructive' },
    partially_paid: { label: 'Partial', variant: 'warning' },
    unpaid: { label: 'Unpaid', variant: 'secondary' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' }
  return <Badge variant={variant}>{label}</Badge>
}

function paymentStatusBadge(status: string) {
  const map: Record<string, { label: string; variant: 'success' | 'destructive' | 'warning' | 'secondary' | 'default' }> = {
    approved: { label: 'Approved', variant: 'success' },
    pending_verification: { label: 'Pending', variant: 'warning' },
    rejected: { label: 'Rejected', variant: 'destructive' },
    voided: { label: 'Voided', variant: 'secondary' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'default' }
  return <Badge variant={variant}>{label}</Badge>
}

export default async function LeaseDetailPage({ params }: { params: Promise<{ leaseId: string }> }) {
  const session = await getSession()
  if (!session || session.role === 'tenant') redirect('/login')

  const { leaseId } = await params
  const prisma = getPrisma()

  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, orgId: session.orgId! },
    include: {
      unit: true,
      tenant: true,
      invoices: {
        include: { paymentAllocations: true },
        orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { periodIndex: 'asc' }],
      },
      payments: {
        orderBy: { receivedAt: 'asc' },
      },
    },
  })

  if (!lease) notFound()

  await connection()
  const now = new Date()

  const invoicesWithStatus = lease!.invoices.map((inv) => {
    const paidSen = Number(inv.paymentAllocations.reduce((s, a) => s + a.amountSen, BigInt(0)))
    return {
      ...inv,
      paidSen,
      status: invoiceStatus(
        { dueDate: inv.dueDate.toISOString().slice(0, 10), amountSen: Number(inv.amountSen), paidSen },
        now,
      ),
    }
  })

  const isManager = session.role === 'manager'

  // Generate signed URLs for slips (server-side)
  const paymentsWithSlips = await Promise.all(
    lease!.payments.map(async (p) => {
      let slipUrl: string | null = null
      if (p.slipPath) {
        const { createServiceClient } = await import('@/lib/supabase/server')
        const admin = createServiceClient()
        const { data } = await admin.storage.from('payment-slips').createSignedUrl(p.slipPath, 3600)
        slipUrl = data?.signedUrl ?? null
      }
      return { ...p, slipUrl }
    }),
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/leases" className="text-sm text-slate-500 hover:text-slate-700">← Leases</Link>
        <h1 className="text-2xl font-bold text-slate-900">
          Unit {lease!.unit.name} — {lease!.tenant.fullName}
        </h1>
      </div>

      {/* Lease info */}
      <Card>
        <CardHeader><CardTitle>Lease Details</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div><dt className="text-slate-500">Start</dt><dd className="font-mono">{formatDateMYT(lease!.startDate)}</dd></div>
            <div><dt className="text-slate-500">End</dt><dd className="font-mono">{formatDateMYT(lease!.endDate)}</dd></div>
            <div><dt className="text-slate-500">Monthly rent</dt><dd className="font-mono">RM {(Number(lease!.monthlyRentSen)/100).toFixed(2)}</dd></div>
            <div><dt className="text-slate-500">Deposit</dt><dd className="font-mono">RM {(Number(lease!.depositSen)/100).toFixed(2)}</dd></div>
          </dl>
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
                      {inv.periodStart ? `${inv.periodStart.toISOString().slice(0,10)} – ${inv.periodEnd?.toISOString().slice(0,10)}` : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono">{inv.dueDate.toISOString().slice(0, 10)}</td>
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
        <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
        <CardContent>
          {paymentsWithSlips.length === 0 ? (
            <p className="text-slate-500 text-sm">No payments yet.</p>
          ) : (
            <div className="space-y-3">
              {paymentsWithSlips.map((p) => (
                <div key={p.id} className="border border-slate-100 rounded-lg p-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">RM {(Number(p.amountSen)/100).toFixed(2)}</span>
                        {paymentStatusBadge(p.status)}
                        <span className="text-xs text-slate-500 capitalize">{p.method.replace('_', ' ')}</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Received: {formatMYT(p.receivedAt)} MYT
                      </div>
                      {Number(p.unappliedSen) > 0 && (
                        <div className="text-xs text-yellow-600 mt-1">
                          Unapplied: RM {(Number(p.unappliedSen)/100).toFixed(2)}
                        </div>
                      )}
                      {p.slipUrl && (
                        <a href={p.slipUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-600 underline mt-1 inline-block">
                          View slip
                        </a>
                      )}
                    </div>
                    {isManager && (
                      <PaymentActions paymentId={p.id} status={p.status} leaseId={leaseId} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Record payment */}
      <Card>
        <CardHeader><CardTitle>Record Payment</CardTitle></CardHeader>
        <CardContent>
          <RecordPaymentForm leaseId={leaseId} orgId={session.orgId!} role={session.role} />
        </CardContent>
      </Card>
    </div>
  )
}
