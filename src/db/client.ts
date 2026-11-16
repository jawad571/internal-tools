import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.ts';

/**
 * One Db type for both drivers. Production uses node-postgres; dev and tests use in-process PGlite
 * (real Postgres semantics, no server). The query-builder surface is identical, so we type as PGlite.
 */
export type Db = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * @param databaseUrl `postgres://…` for a real server, or a filesystem path / undefined for PGlite
 *   (undefined = in-memory, used by tests).
 */
export async function openDb(databaseUrl?: string): Promise<DbHandle> {
  if (databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)) {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pool.end() };
  }
  if (databaseUrl) mkdirSync(databaseUrl, { recursive: true });
  const client = new PGlite(databaseUrl);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

/** Fresh migrated in-memory database for a test. */
export const createTestDb = () => openDb();

export { schema };
