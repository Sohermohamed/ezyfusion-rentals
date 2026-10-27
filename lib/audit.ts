/**
 * lib/audit.ts
 * Audit log helper - writes to audit_log via Prisma (service role, bypasses RLS).
 * This is server-side only.
 */
import { getPrisma } from '@/lib/prisma'

export async function writeAuditLog(entry: {
  orgId: string
  actorId: string
  action: string
  entityId?: string
  details?: Record<string, unknown>
}): Promise<void> {
  const prisma = getPrisma()
  await prisma.$executeRaw`
    INSERT INTO audit_log (org_id, actor_id, action, entity_id, details)
    VALUES (
      ${entry.orgId}::uuid,
      ${entry.actorId}::uuid,
      ${entry.action},
      ${entry.entityId ?? null}::uuid,
      ${entry.details ? JSON.stringify(entry.details) : null}::jsonb
    )
  `
}
