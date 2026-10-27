import { createBrowserClient } from '@supabase/ssr'

/**
 * Creates a Supabase browser client.
 * Uses the PUBLISHABLE key only - NEVER the secret key.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}
