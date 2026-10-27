/**
 * app/(staff)/layout.tsx
 * Layout for staff/manager pages. Requires auth and staff/manager role.
 */
export const instant = false

import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getPrisma } from '@/lib/prisma'
import { Nav } from '@/components/nav'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')
  if (session.role === 'tenant') redirect('/portal')

  const prisma = getPrisma()
  const org = await prisma.organization.findUnique({ where: { id: session.orgId! } })

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav role={session.role} orgName={org?.name ?? ''} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}
