import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'

/**
 * Creates a Supabase server client for the current request.
 * Supports both session cookies AND Authorization: Bearer <token> header.
 */
export async function createClient() {
  const cookieStore = await cookies()
  const headerStore = await headers()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Can be ignored in Server Components
          }
        },
      },
      global: {
        headers: {
          // Pass through Authorization header if provided (for API token auth)
          ...(headerStore.get('authorization')
            ? { Authorization: headerStore.get('authorization')! }
            : {}),
        },
      },
    },
  )
}

/**
 * Creates a Supabase client with the service role key.
 * NEVER expose this to the browser - server-side only.
 */
export function createServiceClient() {
  const { createClient: createSupabaseClient } = require('@supabase/supabase-js')
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
