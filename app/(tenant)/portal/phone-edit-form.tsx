'use client'
/**
 * Phone number edit form for tenant portal.
 * Uses the Supabase client directly (RLS allows tenant to update own phone).
 */
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PhoneEditForm({ tenantId, currentPhone }: { tenantId: string; currentPhone: string }) {
  const [editing, setEditing] = useState(false)
  const [phone, setPhone] = useState(currentPhone)
  const [loading, setLoading] = useState(false)

  async function handleSave() {
    if (!phone.trim()) { toast.error('Phone number cannot be empty'); return }
    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('tenants')
        .update({ phone: phone.trim() })
        .eq('id', tenantId)
      if (error) { toast.error(error.message); return }
      toast.success('Phone number updated')
      setEditing(false)
    } finally {
      setLoading(false)
    }
  }

  if (!editing) {
    return (
      <span>
        {phone || '—'}{' '}
        <button onClick={() => setEditing(true)} className="text-xs text-blue-600 underline ml-1">Edit</button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Input
        className="h-7 text-sm w-36"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="e.g. +60123456789"
        disabled={loading}
      />
      <Button size="sm" onClick={handleSave} disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setPhone(currentPhone); setEditing(false) }}>Cancel</Button>
    </span>
  )
}
