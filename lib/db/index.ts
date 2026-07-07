import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from './schema';
import { serverEnv } from '../env';
import { runInOrg, type TenantTx } from './tenant';

export * from './schema';
export { runInOrg } from './tenant';
export type { TenantClient, TenantDb, TenantTx } from './tenant';

// In a Node environment without a global WebSocket, the serverless driver needs
// one. The Pool (WebSocket) driver supports real transactions — required for the
// SET LOCAL / set_config that activates the RLS policies (see lib/db/tenant.ts).
if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

let cached: NeonDatabase<typeof schema> | null = null;

/**
 * Production Drizzle client (Neon, via Pool). Lazy: only reads DATABASE_URL when
 * used, so it does not break build/import when the env var is absent.
 */
export function getDb(): NeonDatabase<typeof schema> {
  if (!cached) {
    const { DATABASE_URL } = serverEnv();
    const pool = new Pool({ connectionString: DATABASE_URL });
    // node-postgres emits 'error' ASYNCHRONOUSLY on idle pooled clients when the
    // backend terminates them — e.g. Neon's idle timeout / scale-to-zero firing
    // while a slow AI call runs between two transactions. That event is off the
    // await path, so a request's try/catch can never catch it; without this
    // listener it escalates to an unhandled rejection ('Connection terminated
    // unexpectedly') that Sentry reports as a crash. The pool discards the dead
    // client and reconnects on the next checkout, so this is EXPECTED lifecycle
    // noise — a console line (searchable in Vercel logs) without a Sentry event.
    // A genuinely broken DB still surfaces on the await path of the next query.
    pool.on('error', (err: Error) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          at: new Date().toISOString(),
          action: 'dbPoolIdleClient',
          message: err.message,
        }),
      );
    });
    cached = drizzle(pool, { schema });
  }
  return cached;
}

/** Shortcut: run `fn` scoped to the organization (RLS) using the prod client. */
export function withOrg<T>(
  organizationId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return runInOrg(getDb(), organizationId, fn);
}
