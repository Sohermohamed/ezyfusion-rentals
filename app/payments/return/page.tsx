/**
 * /payments/return
 * Gateway return page. Shows the bill status from the database only.
 * NEVER modifies any data — status is set exclusively by the webhook.
 */
export const instant = false

import { redirect } from 'next/navigation'
import { getPrisma } from '@/lib/prisma'

interface Props {
  searchParams: Promise<{ bill_id?: string }>
}

export default async function PaymentReturnPage({ searchParams }: Props) {
  const { bill_id } = await searchParams

  if (!bill_id) {
    redirect('/')
  }

  const prisma = getPrisma()
  const bill = await prisma.gatewayBill.findUnique({ where: { id: bill_id } })

  if (!bill) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center space-y-4">
          <div className="text-4xl">❓</div>
          <h1 className="text-xl font-semibold text-gray-800">Unknown Bill</h1>
          <p className="text-gray-500 text-sm">
            No payment record was found for reference <code className="font-mono bg-gray-100 px-1 rounded">{bill_id}</code>.
          </p>
          <a href="/portal" className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
            Back to Portal
          </a>
        </div>
      </main>
    )
  }

  const isPaid = bill.status === 'paid'
  const isFailed = bill.status === 'failed'
  const isPending = bill.status === 'pending'

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center space-y-4">
        {isPaid && (
          <>
            <div className="text-4xl">✅</div>
            <h1 className="text-xl font-semibold text-green-700">Payment Successful</h1>
            <p className="text-gray-600 text-sm">
              Your payment of <strong>RM {(Number(bill.amountSen) / 100).toFixed(2)}</strong> has been received and your invoices have been updated.
            </p>
          </>
        )}
        {isFailed && (
          <>
            <div className="text-4xl">❌</div>
            <h1 className="text-xl font-semibold text-red-700">Payment Failed</h1>
            <p className="text-gray-600 text-sm">
              Your payment could not be processed. Please try again or contact your property manager.
            </p>
          </>
        )}
        {isPending && (
          <>
            <div className="text-4xl">⏳</div>
            <h1 className="text-xl font-semibold text-yellow-700">Payment Pending</h1>
            <p className="text-gray-600 text-sm">
              Your payment is being processed. This page does not auto-refresh — please check back or contact your property manager if this persists.
            </p>
          </>
        )}
        <p className="text-xs text-gray-400 font-mono">Bill ID: {bill_id}</p>
        <a href="/portal" className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
          Back to Portal
        </a>
      </div>
    </main>
  )
}
