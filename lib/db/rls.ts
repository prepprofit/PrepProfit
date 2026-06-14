import { businessTables } from './schema';

/**
 * Row-Level Security — segunda camada de defesa do multi-tenancy.
 *
 * Cada tabela de negócio só expõe linhas cuja `organization_id` casa com o
 * valor da GUC `app.current_org_id`, definida por transação via `runInOrg()`
 * (ver lib/db/tenant.ts). Se a GUC não estiver setada, `current_setting(..., true)`
 * retorna NULL e nenhuma linha passa — seguro por padrão.
 *
 * `FORCE ROW LEVEL SECURITY` faz a policy valer inclusive para o dono da tabela
 * (o papel que o app usa no Neon), não só para papéis sem privilégio.
 *
 * Geramos as instruções a partir de `businessTables` para garantir que nenhuma
 * tabela de negócio fique sem isolamento.
 */
export const rlsStatements: string[] = businessTables.flatMap((table) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  `DROP POLICY IF EXISTS org_isolation ON ${table};`,
  `CREATE POLICY org_isolation ON ${table}
     USING (organization_id = current_setting('app.current_org_id', true))
     WITH CHECK (organization_id = current_setting('app.current_org_id', true));`,
]);
