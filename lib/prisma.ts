/**
 * lib/prisma.ts
 * Prisma client singleton using the pg driver adapter.
 * Uses the generated client from app/generated/prisma/client.
 */
import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

declare global {
  var __prisma: PrismaClient | undefined
}

export function getPrisma(): PrismaClient {
  if (!global.__prisma) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
    global.__prisma = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0])
  }
  return global.__prisma
}

// Default export for convenience
export const prisma = getPrisma()
