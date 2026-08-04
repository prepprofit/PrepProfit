# Plano: role de aplicação sem BYPASSRLS (etapa 2 da migração do banco)

Escrito em 2026-08-04, para executar depois. Este documento é auto-contido: dá para
começar do zero a partir dele, sem contexto da sessão que o gerou.

## O problema

A role que a aplicação usa em produção, `neondb_owner`, tem `rolbypassrls = true`.
BYPASSRLS anula `ENABLE`/`FORCE ROW LEVEL SECURITY`, então as políticas de
`lib/db/rls.ts` **não filtram nada** para a aplicação.

Verificado contra o banco de produção:

```sql
select rolbypassrls from pg_roles where rolname = current_user;  -- true
select count(*) from recipes;                                     -- 143 (as DUAS orgs)
```

Sem o `set_config('app.current_org_id', …)` deveria devolver 0. Devolve tudo.

**Gravidade: média, não crítica.** A Regra 1 do `CLAUDE.md` (filtro `organization_id`
explícito em toda query) está implementada e é o que segura o isolamento hoje. O que
falta é a SEGUNDA camada, que `lib/db/rls.ts` descreve como *"the second layer of
multi-tenant defense"*. É defesa em profundidade ausente, não vazamento.

**Por que passou despercebido:** os testes de RLS rodam em PGlite, com uma role comum
onde as políticas funcionam. Passam em CI e continuariam passando para sempre,
provando uma propriedade que produção não tem.

## Auditoria de risco (feita em 2026-08-04)

O risco de "telas ficarem vazias" foi medido e é **baixo**:

- **336** chamadas de `withOrg`/`runInOrg` — todo dado de negócio passa por lá.
- **Zero** queries de negócio fora de `withOrg`. Todos os `getDb()` soltos em
  `app/` e `lib/` são `enforceRateLimit(getDb(), …)`, que só toca `rate_limits`.
- Tabelas sem RLS por design, que precisam de GRANT mas não de política:
  `rate_limits` (exceção documentada na Regra 1), `external_food_cache` (cache do
  Open Food Facts, lido direto), `drizzle.__drizzle_migrations` (não lido em runtime).
- `lib/db/org-enumeration.ts` é o único código que **depende** de BYPASSRLS. É chamado
  apenas por `scripts/backfill-recipes-v2.ts` e `scripts/verify-recipes-v2-parity.ts`,
  nunca em runtime — e esses rodam com a string do owner.
- **0 sequences e 0 views** no schema `public`, o que simplifica os GRANTs.

## Passos

Banco: o projeto Neon em `eu-central-1` (migrado em 2026-08-04).
Use o host **direto** (string sem `-pooler`) para o DDL abaixo.

### 1. Criar a role

```sql
CREATE ROLE app_runtime LOGIN PASSWORD '<gerar: openssl rand -hex 24>' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

`NOBYPASSRLS` já é o padrão de `CREATE ROLE`; explicitar deixa a intenção registrada.
O `ALTER DEFAULT PRIVILEGES` roda como `neondb_owner`, que é quem cria tabelas nas
migrações — então tabela nova nasce acessível, sem intervenção manual a cada sprint.

### 2. Provar o isolamento (é o ponto todo)

Conectado **como `app_runtime`**:

```sql
-- (a) sem o GUC: tem que dar 0. Hoje, como owner, dá 143.
select count(*) from recipes;

-- (b) com o GUC: só as linhas daquela org
begin;
  select set_config('app.current_org_id','org_3FM8U564wxG5So05jXKxkRzGFj5',true);
  select count(*) from recipes;   -- esperado: 24
commit;

-- (c) escrita cruzada tem que ser REJEITADA pelo WITH CHECK
begin;
  select set_config('app.current_org_id','org_3FM8U564wxG5So05jXKxkRzGFj5',true);
  insert into recipes (organization_id, name) values ('org_OUTRA','x');  -- deve falhar
rollback;
```

Se (a) não der 0, **pare** — a role foi criada com bypass ou os GRANTs estão errados.

### 3. Separar os papéis

- `DATABASE_URL` no Coolify (runtime) → **`app_runtime`**, host **pooled**.
  Variável runtime: só restart, sem rebuild, sem Build Variable.
- Migrações e scripts admin → string do **`neondb_owner`**, passada inline:
  `DATABASE_URL=<owner> npm run db:migrate`

### 4. Smoke test (manual, precisa de login)

Dashboard, receitas, ingredientes, financeiro, faturas, inventário, relatórios — e uma
**escrita** em cada área, não só leitura. O que se procura é tela vazia onde havia
dado, ou erro ao salvar.

### 5. Documentar

Atualizar `docs/production-operations.md`: divisão de roles, qual string usar para
migração e qual para runtime.

## O que muda de comportamento (de propósito)

- **Escrita com org errada passa a dar ERRO** em vez de gravar. Hoje o `WITH CHECK`
  nunca é avaliado.
- **`audit_log` e `inventory_movements` viram append-only de verdade.** Hoje um UPDATE
  ou DELETE neles funcionaria, apesar de as políticas só terem SELECT e INSERT.
  O purge de ingrediente continua removendo os movimentos, porque cascade de FK é ação
  referencial e não DELETE checado por RLS (ver comentário em `lib/db/rls.ts`).

## Rollback

Apontar `DATABASE_URL` de volta para o `neondb_owner` e reiniciar. Diferente da etapa 1
(mudança de região), aqui **não há divergência de dados** — é só troca de credencial.
Voltar é gratuito e imediato, a qualquer momento.

## Follow-up: fechar o buraco de vez

Estender os testes de RLS para **Postgres real com uma role sem BYPASSRLS**. Sem isso,
nada impede a regressão: PGlite vai continuar dando verde para sempre. O `CLAUDE.md` já
pede isso em outras palavras — *"Real Postgres concurrency tests are required before
launch for flows where PGlite cannot prove the property"*. RLS é exatamente um caso em
que a camada de teste local não consegue provar a propriedade de produção.
