'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function TenantNav() {
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
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between">
          <Link href="/portal" className="font-semibold text-slate-900">EzyFusion Rentals</Link>
          <Button variant="outline" size="sm" onClick={handleLogout}>Sign out</Button>
        </div>
      </div>
    </nav>
  )
}
