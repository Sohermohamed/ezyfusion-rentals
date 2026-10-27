'use client'
/**
 * Pay Now button — creates a gateway bill and shows the bill ID + amount.
 * The return page (/payments/return) shows status only; it NEVER settles the bill.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export function PayNowButton({ leaseId }: { leaseId: string }) {
  const [loading, setLoading] = useState(false)
  const [bill, setBill] = useState<{ billId: string; amountSen: number } | null>(null)

  async function handlePayNow() {
    setLoading(true)
    try {
      const res = await fetch(`/api/leases/${leaseId}/gateway-bills`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? 'Failed to create bill'); return }
      setBill(data)
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }

  if (bill) {
    return (
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="pt-4 pb-4">
          <p className="text-sm font-semibold text-blue-900">Gateway Bill Created</p>
          <p className="text-xs text-blue-700 font-mono mt-1">Bill ID: {bill.billId}</p>
          <p className="text-xs text-blue-700 mt-1">Amount: RM {(bill.amountSen / 100).toFixed(2)}</p>
          <p className="text-xs text-blue-600 mt-2">
            Share this bill ID with the payment gateway to complete payment.
            Check status: <a href={`/payments/return?bill_id=${bill.billId}&paid=true`} className="underline" target="_blank">Return page</a>
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Button onClick={handlePayNow} disabled={loading} className="bg-orange-600 hover:bg-orange-700 text-white">
      {loading ? 'Creating bill…' : 'Pay Now'}
    </Button>
  )
}
