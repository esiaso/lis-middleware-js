import type { Db } from '@lis/db';

/** The transaction client Prisma passes to interactive transactions. */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];
