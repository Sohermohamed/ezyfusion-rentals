/**
 * app/(tenant)/layout.tsx
 * Layout for tenant portal pages.
 */
export const instant = false

import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { TenantNav } from '@/components/tenant-nav'

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role !== 'tenant') redirect('/dashboard')

  return (
    <div className="min-h-screen bg-slate-50">
      <TenantNav />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {children}
      </main>
    </div>
  )
}
