/**
 * lib/auth.ts
 * Server-side authentication and authorization helpers.
 * Derives roles from the database, never from user metadata.
 */
import { createClient } from '@/lib/supabase/server'
import { getPrisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

export type SessionRole = 'manager' | 'staff' | 'tenant'

export interface SessionContext {
  userId: string
  role: SessionRole
  orgId: string | null      // null for tenants (they have their own org via tenant record)
  tenantId: string | null   // null for staff/managers
  tenantOrgId: string | null // org of the tenant (for cross-org isolation)
}

/**
 * Get the authenticated user and their role from the database.
 * Authenticates via cookie session OR Authorization: Bearer header.
 * Returns null if not authenticated.
 */
export async function getSession(): Promise<SessionContext | null> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (error || !user) return null

  const prisma = getPrisma()

  // Check if staff/manager
  const membership = await prisma.membership.findUnique({
    where: { userId: user.id },
  })

  if (membership) {
    return {
      userId: user.id,
      role: membership.role as SessionRole,
      orgId: membership.orgId,
      tenantId: null,
      tenantOrgId: null,
    }
  }

  // Check if tenant
  const tenant = await prisma.tenant.findFirst({
    where: { userId: user.id },
  })

  if (tenant) {
    return {
      userId: user.id,
      role: 'tenant',
      orgId: null,
      tenantId: tenant.id,
      tenantOrgId: tenant.orgId,
    }
  }

  return null
}

/** Returns 401 JSON response */
export function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

/** Returns 403 JSON response */
export function forbidden() {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

/** Returns 404 JSON response */
export function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/**
 * Require at minimum a logged-in user with a given role.
 * Returns [session, null] on success, [null, errorResponse] on failure.
 */
export async function requireRole(
  ...roles: SessionRole[]
): Promise<[SessionContext, null] | [null, NextResponse]> {
  const session = await getSession()
  if (!session) return [null, unauthorized()]
  if (!roles.includes(session.role)) return [null, forbidden()]
  return [session, null]
}

/**
 * Require staff or manager role.
 */
export async function requireStaffOrManager(): Promise<[SessionContext, null] | [null, NextResponse]> {
  return requireRole('staff', 'manager')
}

/**
 * Require manager role.
 */
export async function requireManager(): Promise<[SessionContext, null] | [null, NextResponse]> {
  return requireRole('manager')
}
