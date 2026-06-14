import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from './schema';
import { runInOrg, type TenantTx } from './tenant';

export * from './schema';
export { runInOrg } from './tenant';
export type { TenantClient, TenantDb, TenantTx } from './tenant';

// Em ambiente Node sem WebSocket global, o driver serverless precisa de um.
// O driver Pool (WebSocket) suporta transações reais — necessárias para o
// `SET LOCAL`/`set_config` que ativa as policies de RLS (ver lib/db/tenant.ts).
if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

let cached: NeonDatabase<typeof schema> | null = null;

/**
 * Cliente Drizzle de produção (Neon, via Pool). Lazy: só lê DATABASE_URL quando
 * usado, para não quebrar build/import quando a env não está presente.
 */
export function getDb(): NeonDatabase<typeof schema> {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = drizzle(new Pool({ connectionString: url }), { schema });
  }
  return cached;
}

/** Atalho: roda `fn` escopado à organização (RLS) usando o cliente de produção. */
export function withOrg<T>(
  organizationId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return runInOrg(getDb(), organizationId, fn);
}
