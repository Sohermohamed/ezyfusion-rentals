'use client'
/**
 * app/(staff)/leases/[leaseId]/payment-actions.tsx
 * Approve / Reject / Void payment buttons (manager only).
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  paymentId: string
  leaseId: string
  status: string
}

export function PaymentActions({ paymentId, leaseId, status }: Props) {
  const router = useRouter()
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [showVoidForm, setShowVoidForm] = useState(false)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function doAction(path: string, body: Record<string, unknown>) {
    setLoading(true)
    try {
      const res = await fetch(`/api/payments/${paymentId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? 'Action failed'); return }
      toast.success(`Payment ${path}d successfully`)
      setShowRejectForm(false)
      setShowVoidForm(false)
      setReason('')
      router.refresh()
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  if (status === 'pending_verification') {
    return (
      <div className="flex flex-col gap-2 items-end">
        <div className="flex gap-2">
          <Button size="sm" onClick={() => doAction('approve', {})} disabled={loading}>Approve</Button>
          <Button size="sm" variant="outline" onClick={() => setShowRejectForm((v) => !v)} disabled={loading}>Reject</Button>
        </div>
        {showRejectForm && (
          <div className="flex gap-2 items-end">
            <div>
              <Label className="text-xs">Reason (min 5 chars)</Label>
              <Input className="h-8 text-xs w-48" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rejection reason" />
            </div>
            <Button size="sm" variant="destructive" onClick={() => doAction('reject', { reason })} disabled={loading || reason.trim().length < 5}>
              Confirm Reject
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (status === 'approved') {
    return (
      <div className="flex flex-col gap-2 items-end">
        <Button size="sm" variant="secondary" onClick={() => setShowVoidForm((v) => !v)} disabled={loading}>Void</Button>
        {showVoidForm && (
          <div className="flex gap-2 items-end">
            <div>
              <Label className="text-xs">Reason (min 5 chars)</Label>
              <Input className="h-8 text-xs w-48" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Void reason" />
            </div>
            <Button size="sm" variant="destructive" onClick={() => doAction('void', { reason })} disabled={loading || reason.trim().length < 5}>
              Confirm Void
            </Button>
          </div>
        )}
      </div>
    )
  }

  return null
}
