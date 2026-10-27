/**
 * components/nav.tsx — shared navigation for staff/manager
 */
'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface NavProps {
  role: string
  orgName: string
}

export function Nav({ role, orgName }: NavProps) {
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    toast.success('Signed out')
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-semibold text-slate-900 hover:text-slate-700">
              EzyFusion Rentals
            </Link>
            <Link href="/dashboard" className="text-sm text-slate-600 hover:text-slate-900">
              Dashboard
            </Link>
            <Link href="/leases" className="text-sm text-slate-600 hover:text-slate-900">
              Leases
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500">{orgName} · <span className="capitalize">{role}</span></span>
            <Button variant="outline" size="sm" onClick={handleLogout}>Sign out</Button>
          </div>
        </div>
      </div>
    </nav>
  )
}
