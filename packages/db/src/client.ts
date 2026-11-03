import prismaPkg from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';

// @prisma/client is CommonJS; a default import is the portable way to load it from ESM.
const { PrismaClient, Prisma } = prismaPkg;
export { PrismaClient, Prisma };
export type Db = PrismaClientType;

export function createDb(url: string): Db {
  return new PrismaClient({ datasources: { db: { url } } });
}

/** True when PostgreSQL rejected a write because the lease epoch is stale (fencing trigger). */
export function isStaleLeaseError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return text.includes('stale or expired lease epoch');
}

import type { Prisma as PrismaNS } from '@prisma/client';
export type DecimalValue = PrismaNS.Decimal;
export type JsonInput = PrismaNS.InputJsonValue;

/** Exact decimal from a decimal string (never via a JS number). */
export function decimal(text: string): DecimalValue {
  return new Prisma.Decimal(text);
}
