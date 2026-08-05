# Plano: impedir a regressão silenciosa do RLS (follow-up da etapa 2)

> **ESTADO: EXECUTADO em 2026-08-05.** As decisões D1–D4 ficaram todas na opção
> recomendada, e as três peças estão implementadas:
> **A** → `lib/db/runtime-role.ts` + `instrumentation.ts` (fail-open, provado contra a base
> real nos dois sentidos: alarme com o owner, silêncio com `app_runtime`);
> **B** → `lib/db/runtime-grants.ts` + passo final em `scripts/migrate.ts` (dry-run
> read-only contra produção: 61 tabelas com DML, RLS *enabled+forced* nas 59 de negócio);
> **C** → `tests/concurrency/rls-real-role.pg.test.ts`, opt-in por `TEST_DATABASE_URL_APP`.
> O documento fica como registo do raciocínio e das decisões.

Escrito em 2026-08-05, para executar numa sessão dedicada. Auto-contido: dá para começar
do zero a partir daqui, sem contexto da sessão que o gerou.

Antecedente: `docs/rls-app-role-plan.md` (etapa 2, **executada** em 2026-08-04). Produção
passou a ligar-se como `app_runtime`, uma role `NOBYPASSRLS`, em vez de `neondb_owner`.
`docs/production-operations.md` § *Database roles* descreve o estado final.

## O problema, enunciado com precisão

O primeiro enunciado deste follow-up estava errado e vale a pena corrigi-lo, porque leva a
construir a coisa errada:

> ~~"os testes de RLS correm em PGlite com uma role comum, portanto dariam verde mesmo que
> alguém voltasse a apontar o runtime para o owner"~~

A primeira metade é verdade, a segunda não segue dela. `tests/helpers/db.ts` cria a role
`tenant_app` e os testes fazem `SET ROLE tenant_app` antes de tocar nos dados — em PGlite,
tal como em Postgres, uma role não-privilegiada **não** ignora o RLS. `tests/isolation.test.ts`
(35 casos) exercita políticas reais. As políticas estão testadas.

O que nenhum teste alcança é **com que role o processo de produção se liga**. Isso vive numa
variável de ambiente do Coolify, não no repositório. Um teste unitário não a consegue ler, e
nenhuma quantidade de testes de RLS a consegue provar.

Daí que o buraco real seja outro, e sejam **três**:

| # | Buraco | Como se manifesta | Detetado hoje por |
|---|---|---|---|
| 1 | O `DATABASE_URL` de produção volta a uma role com `BYPASSRLS` | Silêncio absoluto: tudo funciona, o RLS deixa de filtrar | **nada** |
| 2 | Uma migração futura cria tabela sem GRANT para `app_runtime` | `permission denied for table X` em runtime, depois do deploy | **nada** (só o utilizador) |
| 3 | Uma política de RLS deixa de ser aplicada numa tabela nova | Isolamento perde-se nessa tabela | parcialmente: `rlsStatements` é gerado de `businessTables` |

O buraco 1 é o que motivou este documento. O buraco 2 é o que **mais provavelmente** causa
uma avaria real, e nasceu com a etapa 2: antes, a app era dona das tabelas e nunca lhe
faltava privilégio. O `ALTER DEFAULT PRIVILEGES` cobre o caso normal (tabela criada pelo
owner numa migração), mas não cobre tabela criada por outra role, `GRANT` revogado à mão,
ou schema novo que não seja `public`.

## Princípio que orienta as três peças

Nenhuma delas é um teste unitário, porque o que falha aqui não é lógica — é **configuração
que diverge do que o código assume**. As três verificam a base de dados real, cada uma no
momento em que ainda dá para reagir barato: no deploy (B), no arranque (A), e num ambiente
descartável antes de chegar a produção (C).

---

## Peça A — guard de arranque: "não estou a correr com BYPASSRLS"

**O quê:** ao arrancar, o servidor pergunta à base de dados se a role com que se ligou tem
`rolbypassrls`. Se tiver, grita.

**Onde:** `instrumentation.ts` já existe e o `register()` do Next corre uma vez por boot do
servidor — é o sítio certo. Nova função em `lib/db/assert-runtime-role.ts`.

```ts
// esboço, não é a implementação final
export async function assertRuntimeRoleIsolated(db: Db): Promise<void> {
  const [row] = (await db.execute(sql`
    select current_user as role,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypasses
  `)).rows;
  if (row?.bypasses) {
    logError(new Error(`DB role "${row.role}" has BYPASSRLS — RLS is NOT enforced`), …);
  }
}
```

**Decisão D1 — fail-open ou fail-closed?** Recomendo **fail-open**: registar em `console.error`
+ Sentry e deixar o servidor subir. Razões: (a) um soluço de rede no boot não pode derrubar a
produção; (b) a condição é postura de segurança, não corrupção — com a Regra 1 em vigor o
isolamento aguenta-se enquanto alguém reage; (c) fail-closed num boot em loop é um outage
auto-infligido às 3 da manhã. Se preferires fail-closed, é uma linha diferente, mas assume
essa troca conscientemente.

Custo: uma query por arranque de container. Não está no caminho de nenhum pedido.

**Como se prova que funciona:** apontar o `.env.local` para a string do owner, `npm run dev`,
e confirmar que a linha de erro aparece. Depois voltar atrás.

---

## Peça B — verificação pós-migração: GRANTs e RLS, no deploy

**O quê:** estender `scripts/migrate.ts` (que já corre como owner e já tem o precedente do
`assertJournalOrdering`) com um passo final que verifica, contra a base de dados que acabou
de migrar:

1. a role `app_runtime` existe e tem `rolbypassrls = false`;
2. para **todas** as tabelas de `businessTables` + `rate_limits` + `external_food_cache`:
   `has_table_privilege('app_runtime', tabela, 'SELECT'|'INSERT'|'UPDATE'|'DELETE')`;
3. para todas as de `businessTables`: `relrowsecurity` **e** `relforcerowsecurity` a true, e
   pelo menos uma política presente.

Falha ⇒ `process.exit(1)` com a lista de tabelas em falta e o `GRANT` exato a correr. Isto
apanha o buraco 2 **no deploy**, não em produção com o utilizador à frente.

**Decisão D2 — e quando a role não existe?** Em dev local, em CI, ou contra uma branch nova,
`app_runtime` pode não existir. Recomendo: **avisar e saltar** (não falhar) quando a role não
existe; **falhar** quando existe mas está incompleta. Assim o passo é inócuo fora de produção
e rigoroso onde importa. Alternativa: variável `EXPECT_APP_RUNTIME_ROLE=1` para tornar a
ausência um erro — usa-se no deploy de produção. Fica ao teu critério; a primeira chega.

Custo: duas queries no fim de `npm run db:migrate`.

---

## Peça C — teste opt-in contra Postgres real com role sem BYPASSRLS

**O quê:** codificar, como teste, a bateria ad-hoc que provou a etapa 2 em 2026-08-04.
Ficheiro `tests/concurrency/rls-real-role.pg.test.ts` (a pasta já é a casa dos testes opt-in
contra Postgres real — ver `invoice-numbering.pg.test.ts`, que é o molde a copiar: gate por
env var, `describe.skipIf`, `Pool` do `@neondatabase/serverless`).

Gate: **`TEST_DATABASE_URL_APP`** — string de uma role `NOBYPASSRLS` numa branch Neon
descartável. Nome deliberadamente diferente do `TEST_DATABASE_URL` dos testes de
concorrência, que aponta para o **owner**; um teste que precisa de bypass e outro que precisa
de não-bypass não podem partilhar variável.

Casos (iterar sobre `businessTables`, para que tabela nova de sprint futuro entre sozinha):

- sem `app.current_org_id`: `select count(*)` devolve **0** em cada tabela de negócio;
- com o GUC: só as linhas daquela org, e `count(distinct organization_id) = 1`;
- `INSERT` com org diferente da do GUC ⇒ erro **42501**;
- `UPDATE` que retagueia para outra org ⇒ **42501**;
- `audit_log` e `inventory_movements`: `UPDATE` e `DELETE` afetam **0 linhas**;
- `rate_limits` legível **e** gravável sem GUC nenhum (é o que o limitador faz antes de
  qualquer `withOrg` — se isto partir, todas as rotas com limite partem);
- `external_food_cache` legível sem GUC.

Tudo em transações com `rollback`; o teste não deixa lixo.

**Preparar a branch (documentar no topo do ficheiro):**

```sql
-- na branch descartável, como owner:
CREATE ROLE test_app LOGIN PASSWORD '…' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO test_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_app;
```
com `DATABASE_URL=<branch-owner> npm run db:migrate` antes, para ter schema + políticas.

**Decisão D3 — isto corre em CI?** Recomendo **não**, pelo menos para já: precisa de segredo
e de uma branch viva, e os minutos do GitHub Actions já se esgotaram uma vez este ano
(ver memória `github-actions-quota`). Fica opt-in como os outros `.pg.test.ts`, e mais tarde,
se valer a pena, um workflow `workflow_dispatch` manual.

**Nota honesta sobre o valor desta peça:** ela sobrepõe-se bastante ao que
`tests/isolation.test.ts` já prova em PGlite. O que acrescenta é (a) Postgres verdadeiro em
vez de WASM, (b) uma role de **login** real em vez de `SET ROLE`, e (c) os GRANTs — que o
PGlite não modela porque lá a role recebe tudo no helper. É a peça de menor valor marginal
das três. Se o tempo apertar, faz A e B e deixa esta.

---

## Ordem sugerida e esforço

| | Peça | Esforço | Porquê primeiro |
|---|---|---|---|
| 1 | **B** — verificação pós-migração | ~1 h | fecha o buraco que mais provavelmente parte produção (GRANT em falta), e corre em todo o deploy |
| 2 | **A** — guard de arranque | ~1 h | é o único que deteta o buraco 1, que é o motivo deste documento |
| 3 | **C** — teste opt-in | ~2 h | menor valor marginal; ver nota acima |

São independentes: cada uma pode entrar sozinha, cada uma no seu commit.

## Decisões a fechar antes de começar

- **D1**: guard de arranque fail-open (recomendado) ou fail-closed.
- **D2**: `migrate.ts` avisa-e-salta quando a role não existe (recomendado), ou exige-a.
- **D3**: peça C fica opt-in local (recomendado) ou vai para CI com segredo.
- **D4**: a branch Neon de teste é criada e destruída à mão a cada uso, ou fica permanente?
  Permanente é mais cómodo e custa quase nada; à mão evita uma cópia esquecida de dados
  reais. Recomendo **descartável, criada a partir de uma branch vazia** — nunca a partir de
  produção, para não haver dados de clientes numa branch de teste.

## Testes a escrever (para o gate `npm test`)

- `lib/db/assert-runtime-role.test.ts`: a função deteta `rolbypassrls = true`, não grita no
  caso normal, e não rebenta se a query falhar (fail-open verificado, não presumido).
- A verificação da peça B é código de script; a parte pura (comparar a lista esperada com o
  que a base devolveu) sai para uma função testável, como já se fez com
  `findSkippableMigrations`.

## Definição de pronto

- `npm run lint && npm run typecheck && npm test && npm run build` verde.
- `npm run db:migrate` contra produção imprime a verificação de GRANTs e passa.
- Um arranque local com a string do owner produz o erro esperado; com a `app_runtime`, não.
- `docs/production-operations.md` § *Database roles*: substituir o parágrafo final
  ("Known gap: …") pelo que passou a existir.
- Atualizar a memória `rls-bypassed-in-prod` — é lá que este follow-up está registado como
  o que falta.
