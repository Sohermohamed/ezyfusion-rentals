'use client'
/**
 * app/(staff)/leases/[leaseId]/record-payment-form.tsx
 * Form to record cash or bank_transfer payments.
 * Parses amounts with parseRinggitToSen.
 */
import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { parseRinggitToSen } from '@/lib/billing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

interface Props {
  leaseId: string
  orgId: string
  role: string
}

export function RecordPaymentForm({ leaseId, orgId, role }: Props) {
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'cash' | 'bank_transfer'>('cash')
  // receivedAt: local MYT datetime string for input, stored as ISO
  const [receivedAt, setReceivedAt] = useState('')
  const [slipFile, setSlipFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [amountError, setAmountError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function validateAmount(v: string) {
    try {
      parseRinggitToSen(v)
      setAmountError('')
    } catch (e) {
      setAmountError(e instanceof Error ? e.message : 'Invalid amount')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    let slipPath: string | undefined

    try {
      // Parse amount
      let amountSen: number
      try {
        amountSen = parseRinggitToSen(amount)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Invalid amount')
        return
      }

      if (!receivedAt) { toast.error('Received date/time is required'); return }

      // Parse receivedAt as MYT → UTC ISO
      // Input type="datetime-local" gives YYYY-MM-DDTHH:mm
      const receivedAtISO = new Date(receivedAt + ':00+08:00').toISOString()

      // Upload slip if bank transfer
      if (method === 'bank_transfer') {
        if (!slipFile) { toast.error('Slip file is required for bank transfer'); return }
        const supabase = createClient()
        const path = `${orgId}/${Date.now()}-${slipFile.name}`
        const { error: upErr } = await supabase.storage.from('payment-slips').upload(path, slipFile)
        if (upErr) { toast.error(`Upload failed: ${upErr.message}`); return }
        slipPath = path
      }

      // Record payment
      const res = await fetch(`/api/leases/${leaseId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountSen, method, receivedAt: receivedAtISO, slipPath }),
      })
      const data = await res.json()

      if (!res.ok) {
        // If payment fails and we uploaded a slip, clean it up
        if (slipPath) {
          const supabase = createClient()
          const { error } = await supabase.storage.from('payment-slips').remove([slipPath])
          if (error) {
            console.error('Failed to remove payment slip after rejected payment:', error.message)
            toast.error('Payment failed and the uploaded slip could not be removed')
          }
        }
        toast.error(data.error ?? 'Failed to record payment')
        return
      }

      toast.success(
        data.status === 'approved'
          ? 'Payment recorded and approved'
          : 'Payment recorded — awaiting manager approval',
      )
      setAmount('')
      setReceivedAt('')
      setSlipFile(null)
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    } catch (e) {
      if (slipPath) {
        try {
          const supabase = createClient()
          const { error } = await supabase.storage.from('payment-slips').remove([slipPath])
          if (error) {
            console.error('Failed to remove payment slip after request error:', error.message)
            toast.error('The request failed and the uploaded slip could not be removed')
          }
        } catch (cleanupError) {
          console.error('Failed to clean up uploaded payment slip:', cleanupError)
          toast.error('The request failed and the uploaded slip could not be removed')
        }
      }
      toast.error(e instanceof Error ? e.message : 'Failed to record payment')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
      <div className="space-y-1">
        <Label htmlFor="amount">Amount (RM)</Label>
        <Input
          id="amount"
          placeholder="e.g. 1,500.00"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); validateAmount(e.target.value) }}
          disabled={loading}
          required
        />
        {amountError && <p className="text-xs text-red-600">{amountError}</p>}
      </div>

      <div className="space-y-1">
        <Label htmlFor="method">Payment Method</Label>
        <select
          id="method"
          className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
          value={method}
          onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer')}
          disabled={loading}
        >
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank Transfer</option>
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="receivedAt">Date &amp; Time Received (Malaysia time)</Label>
        <Input
          id="receivedAt"
          type="datetime-local"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          disabled={loading}
          required
        />
        <p className="text-xs text-slate-500">Enter date/time as shown on the receipt (Malaysia time)</p>
      </div>

      {method === 'bank_transfer' && (
        <div className="space-y-1">
          <Label htmlFor="slip">Bank Transfer Slip (JPEG, PNG or PDF, max 5 MB)</Label>
          <Input
            id="slip"
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            ref={fileRef}
            onChange={(e) => setSlipFile(e.target.files?.[0] ?? null)}
            disabled={loading}
            required
          />
        </div>
      )}

      <Button type="submit" disabled={loading || !!amountError}>
        {loading ? 'Recording…' : role === 'manager' ? 'Record & Approve' : 'Record Payment'}
      </Button>
      {role === 'staff' && (
        <p className="text-xs text-slate-500">Payment will be pending manager approval.</p>
      )}
    </form>
  )
}
