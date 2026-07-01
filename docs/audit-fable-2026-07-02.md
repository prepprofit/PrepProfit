# Auditoria completa — Fable — 2026-07-02

Branch: `audit/fable-2026-07-02`. Escopo: auditoria end-to-end de segurança,
multi-tenancy, RBAC, cálculos, integridade de dados, TypeScript, testes e operação,
com correções cirúrgicas em commits atômicos.

## Plano (ordem de execução)

1. **A1 — Multi-tenancy/RLS**: varrer todo uso de `db.select/insert/update/delete`,
   `execute` e `` sql` `` fora de `withOrg`; validar org-scoping e presença em
   `businessTables`; conferir `lib/db/rls.ts` vs `lib/db/schema.ts` vs migrations.
2. **A2 — IDOR**: params `id` em rotas/ações com lookup sem filtro de org;
   `organization_id` aceito do cliente.
3. **A3 — FKs cross-tenant**: composite `(organization_id, foreign_id)`.
4. **A4 — Headers/CSP**: estado do F-04 (Report-Only), cookies, headers.
5. **A5 — Injeções**: raw SQL não parametrizado, `dangerouslySetInnerHTML`,
   path traversal em upload/download, formula injection em CSV/XLSX.
6. **A6 — Webhooks**: verificação de assinatura (Clerk/Stripe/Resend) antes de efeito.
7. **A7 — Rate limiting**: rotas abuse-prone + cron; `npm audit --omit=dev`.
8. **A8 — Vazamento de segredos**: `NEXT_PUBLIC_*`, logs, error responses.
9. **B — RBAC**: páginas sensíveis → `NoAccess`; actions/handlers → `FORBIDDEN`
   antes de dado; lockdown financeiro kitchen (cost/margin/price).
10. **C — Cálculos/dinheiro**: pureza de `lib/calculations/**`, rounding, edges
    (zero/negativo/grande/NaN/Infinity/div-by-zero), cents inteiros.
11. **D — Integridade**: soft-delete (`deleted_at IS NULL`), numeração gap-free
    (invoices/POs), purge nulando FKs, migrations × schema × RLS.
12. **E — TS/qualidade**: `any`/`@ts-ignore`/eslint-disable, Zod em toda entrada,
    shape estável de ActionResult, strings hardcoded.
13. **F — Testes**: gate completo; cobertura RLS/RBAC/money/formula-injection/AI.
14. **G — Observabilidade**: `logError`/`unexpected` nos catches, `console.log`
    de PII/tokens, idempotência dos crons.
15. **Fechamento**: gate `lint && typecheck && test && build` verde + sumário.

## Sumário executivo

| Severidade | Achados | Corrigidos |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 1 | 1 |
| Nit / recomendação | 2 | 0 (deferidos, ver abaixo) |

O produto está em estado de segurança forte. As passagens A–G não encontraram
nenhuma vulnerabilidade explorável: RLS cobre 47/47 tabelas de negócio (única
exceção `rate_limits`, documentada), 45/45 FKs são compostas com
`organization_id`, todas as rotas/ações sensíveis fazem RBAC antes de dado,
todo SQL raw é parametrizado, exports neutralizam formula injection na origem,
webhook Clerk verifica assinatura Svix antes de qualquer efeito, cron usa
comparação constant-time, e `npm audit --omit=dev` retorna 0 vulnerabilidades.

## Achados

### LOW-1 — updates de linha em `applyInvoiceImport` sem filtro de org explícito — CORRIGIDO

- **Arquivo:** `lib/data/supplier-invoice-imports.ts:436,454,462` (pré-fix)
- **Severidade:** Low (defense-in-depth; não explorável)
- **Descrição:** os três UPDATEs por linha dentro de `applyInvoiceImport`
  filtravam apenas por `supplier_invoice_import_lines.id`. Os ids vêm de um
  SELECT org-scoped na MESMA transação `withOrg` e o RLS (`WITH CHECK`/`USING`)
  bloquearia qualquer escrita cross-org — logo não há vazamento real. Porém a
  Rule 1 exige que TODA query seja explicitamente org-scoped na camada de app.
- **Correção:** `and(eq(organizationId), eq(id))` nos três UPDATEs.
  Commit `1223cc9` — `fix(rls): org-scope invoice-import line status updates`.
- **Testes:** a suíte existente (`tests/supplier-invoice-imports.test.ts`,
  95 arquivos / 814 testes da pasta `tests/`) passou verde com a mudança; o
  comportamento é idêntico por construção (mesma transação, mesmos ids).

### REC-1 — CSP ainda em Report-Only (F-04) — DEFERIDO (decisão do owner)

- **Arquivo:** `next.config.ts:51`
- **Razão para deferir:** promover para `Content-Security-Policy` enforcing
  exige primeiro confirmar em PRODUÇÃO que não há violações reportadas
  (Clerk/Sentry/PostHog/Stripe checkout têm origens fáceis de sub-allowlistar).
  Esta auditoria é local-only (sem deploy/verificação prod), então promover às
  cegas poderia derrubar o checkout em produção. Ação sugerida ao owner:
  checar o console do browser em prod por `Content-Security-Policy-Report-Only`
  violations durante 1 semana de uso normal (incl. um checkout Stripe) e então
  trocar o header para enforcing.

### REC-2 — `'unsafe-inline'`/`'unsafe-eval'` no script-src da CSP — DEFERIDO

- Já documentado no próprio config: remover exige a CSP com nonce do Next
  (mudança arquitetural, fora do escopo cirúrgico desta auditoria).

## O que foi verificado e passou limpo

### A) Segurança & multi-tenancy
- **`getDb()` direto:** todos os ~30 usos são exclusivamente o rate limiter
  (`enforceRateLimit`) — a exceção `rate_limits` documentada — ou o próprio
  `withOrg`. Nenhuma query de negócio fora de `withOrg`/RLS.
- **Org-scoping app-layer:** varredura programática de todos os `.where(` em
  `app/` + `lib/` (janela de 10 linhas): único achado foi LOW-1. `trash.ts`
  usa `purgeableRecipeWhere` org-scoped; os hits em `schema.ts` são índices
  parciais/CHECKs.
- **`businessTables` vs schema:** 48 tabelas no schema, 47 em
  `businessTables`; a única ausente é `rate_limits` (exceção documentada).
  `audit_log` e `inventory_movements` com política append-only correta.
- **FKs compostas:** zero `.references()` single-column; 45 `foreignKey(...)`
  compostas, todas com `organizationId` na primeira coluna.
- **IDOR:** todas as rotas `[id]` (invoice PDF, recipe card/prep-card PDF,
  PO PDF) derivam org via `getOrgId()` e fazem lookup dentro de `withOrg` com
  filtro de org; cross-org → 404 sem vazar existência.
- **`organization_id` do cliente:** nenhuma ocorrência (grep por
  aceitação em body/params).
- **Injeção SQL:** todo `` sql` `` usa interpolação Drizzle (bound params) —
  search trigram, rate limiter, advisory locks, CHECKs de schema. Zero
  concatenação de string.
- **XSS:** zero `dangerouslySetInnerHTML`/`innerHTML`.
- **Path traversal / header injection:** todos os `Content-Disposition`
  passam por `documentFilename()` / `invoiceDocumentFilename()` (allowlist
  `[A-Za-z0-9._-]`), ou são constantes/derivados de enum.
- **Formula injection:** `neutralizeFormula` aplicado a todo texto
  user-controlled em CSV (`lib/finance/csv.ts`) e XLSX (`lib/documents/xlsx.ts`
  `textCell`/`headerCell`), cobrindo `= + - @ \t \r`.
- **Webhooks:** rota Clerk usa `verifyWebhook` (Svix) antes de qualquer efeito;
  org id só do payload VERIFICADO; writes em `withOrg`. Não há webhook Stripe
  separado (Clerk Billing re-emite) nem Resend inbound.
- **Rate limiting:** presente em TODAS as rotas abuse-prone (documents,
  exports, imports, AI, search, email) e nos 3 crons (keyed por hash do auth
  header, antes de qualquer trabalho).
- **Cron auth:** `timingSafeEqual` constant-time, fail-closed sem secret.
- **Segredos:** `NEXT_PUBLIC_*` inexistente fora de comentário; console
  restrito ao `logError` estruturado (eventId, sem PII/token).
- **`npm audit --omit=dev`:** 0 vulnerabilidades.

### B) RBAC end-to-end
- Páginas sensíveis (transactions, invoices, payroll, break-even, settings,
  trash, insights, billing, sales, financials, menus/engineering) todas com
  gate `NoAccess`/role.
- Todas as Server Actions sensíveis retornam `FORBIDDEN` antes de dado; os 4
  arquivos de action SEM gate de role (allergens ingrediente/receita, folders,
  presets) são deliberadamente operacionais (decisão owner-locked: kitchen
  edita), e mesmo assim autenticam, validam com Zod e rodam em `withOrg`.
- Lockdown financeiro kitchen confirmado: criação de ingrediente por kitchen
  força `priceCents=0 + needsPricing=true`; update recusa preço FORJADO com
  `FORBIDDEN` (não silent-drop); recipe cost card PDF exige
  `canSeeRecipeCosts`; prep-card e allergen-matrix são money-free por design.
- AI daily-close summary (Sprint 6.4): manager-only + entitlement + rate limit
  + quota mensal race-safe (advisory lock) ANTES do provider.

### C) Cálculos & dinheiro
- `lib/calculations/**` puro: zero `Date.now`/`new Date()`/`Math.random`/
  `parseFloat`/`toFixed` fora de testes; imports só de módulos puros.
- Dinheiro em cents inteiros em todo o caminho; `componentCost` é
  complete-or-null (nunca soma parcial nem 0 enganoso), com guarda de
  safe-integer/finito/não-negativo.
- Os 5 módulos sem `.test.ts` colado (componentCost, menu, production,
  purchaseOrder, tasks) são cobertos por `tests/menu-calc.test.ts`,
  `tests/production-calc.test.ts`, `tests/purchase-order-calc.test.ts`,
  `tests/tasks.test.ts` e `tests/production-calc.test.ts` (componentCost).

### D) Integridade de dados
- Soft-delete: reads ativos filtram `deleted_at` (spot-checks + suíte RLS);
  loaders honram trashed → custo null (ex.: daily-close ignora ingrediente
  trashed em vez de custo desonesto).
- Numeração gap-free: invoices com `FOR UPDATE` (fix `f3441d0`), POs com
  `po_counters` + teste real-PG de concorrência (F6).
- Purge: `purge-trash` nula FKs opcionais (transactions.recipeId,
  tasks.sourceRecipeId) antes de deletar receitas pinadas.
- Migrations × schema: `drizzle-kit generate` → "No schema changes" (zero
  drift); RLS gerada de `businessTables`, então nenhuma tabela fica sem policy.

### E) TypeScript & qualidade
- Zero `any` real, zero `@ts-ignore`/`@ts-expect-error`; os
  `eslint-disable-next-line` existentes são justificados (react-pdf `Image`
  sem alt; `<img>` em contexto print; deps de hook documentada).
- Zod em toda entrada (actions e route handlers); shape estável
  `{ ok, data } | { ok:false, code }` consistente.
- i18n: componentes novos (Sprint 6) usam `useTranslations`; erros de rota API
  retornam JSON de status (não UI copy) — padrão estabelecido.

### F) Testes
- Suíte `tests/` verde com o fix LOW-1: 95 arquivos, 814 pass / 30 skip.
- Gate completo (lint+typecheck+test+build) — resultado abaixo.
- Cobertura RLS (SELECT/INSERT WITH CHECK/UPDATE retag/DELETE), RBAC
  (kitchen→FORBIDDEN), money edges, formula injection e AI
  (hallucination/low-confidence/cross-org) já existente das sprints anteriores
  — nenhuma tabela/ação nova sem teste foi introduzida por esta auditoria.

### G) Observabilidade & operação
- Todos os `catch {}` silenciosos são intencionais e com fallback correto
  (fail-open cosmético, INVALID_INPUT em parse, erro tipado de provider AI).
- `console.*` só no `logError` estruturado; sem PII/tokens/payload cru.
- Crons idempotentes e rate-limited (purge-trash, email-outbox,
  ai-cost-report), auth constant-time.

## Correções aplicadas (commits)

1. `1223cc9` — `fix(rls): org-scope invoice-import line status updates in
   applyInvoiceImport` (LOW-1).

## Adendo (2026-07-02) — disposição do relatório de auditoria do dev

Um segundo relatório (`prelaunch-audit-report.md`, dev externo, 2026-07-01, sobre
o zip `PrepProfit-main (36)`) foi verificado achado a achado contra o código
atual da `main`:

| # | Achado do dev | Veredito | Ação |
|---|---|---|---|
| 1 | P1 — billing/pricing/entitlements inconsistentes | **Parcialmente válido** | Docs corrigidos + teste de regressão (abaixo) |
| 2 | P1 — `CLERK_WEBHOOK_SIGNING_SECRET` fora do `.env.example` | **Válido** | Corrigido |
| 3 | P2 — size check pós-parse nos uploads | **Válido** | Corrigido (pré-check de `Content-Length`) |
| 4 | P2 — 4 vulns moderate no npm | **Válido, risco aceito** | Triagem documentada (abaixo) |
| 5 | P2 — SSRF/DNS-rebinding residual no logo fetch | **Conhecido/deliberado** | Deferido (recomendação) |
| 6 | P2 — CSP Report-Only | **Já dispositionado** (REC-1 acima) | Deferido (ação do owner em prod) |
| 7 | P3 — E2E/checkout smoke opt-in | **Válido, ops** | Deferido (exige secrets de staging — owner) |
| 8 | P3 — build depende do Google Fonts | **Válido, baixo risco** | Documentado no SETUP.md; vendoring deferido |

**#1 — o que era real e o que não era.** A "inconsistência de moeda"
(`clerk/billing.json` em USD vs copy em EUR) é um placeholder de dev
DOCUMENTADO (CLAUDE.md: o gateway dev do Clerk só aceita USD; o prod cobra
€29/€79 em EUR) — não é bug. Real era o doc stale: SETUP.md listava cap de 50
receitas (vivo: 10), preço $99 (vivo: $79/€79) e um feature Clerk `ai_extraction`
que foi removido de propósito (AI é universal, medida só por quota mensal
app-side). SETUP.md corrigido; PLANO.md anotado (registros históricos de sprint
ganharam nota "superseded" em vez de reescrever história); novo
`tests/billing-catalogue.test.ts` trava `clerk/billing.json` ↔
`lib/entitlements.ts` ↔ copy público de pricing (4 asserts) para nunca mais
driftarem em silêncio. Commit `0ed8b4c`.

**#2.** `.env.example` ganhou o bloco `CLERK_WEBHOOK_SIGNING_SECRET` (obrigatório
em prod — sem ele todo evento Clerk é rejeitado com 400) e o SETUP.md deixou de
dizer "not used until slice 4c lands" (4c está no ar). Commit `0ed8b4c`.

**#3.** Novo guard `declaredBodyExceeds` (`lib/validation/request-size.ts`):
as rotas de upload AI (photo, photo/stage, supplier invoice) agora respondem 413
a um `Content-Length` declarado acima do cap ANTES de bufferizar o corpo.
Header ausente/malformado segue para o parser de propósito: o cap de corpo da
plataforma (Vercel ~4.5 MB) e os validadores de bytes pós-parse continuam sendo
o limite autoritativo — o guard é fast-fail, não a fronteira de segurança.
Testes: unit (5 casos) + 413 nas duas rotas. Commit `74fa58f`.

**#4 — triagem das 4 moderates.** As quatro são UMA cadeia devDependency:
`esbuild <=0.24.2` ← `@esbuild-kit/core-utils` ← `@esbuild-kit/esm-loader` ←
`drizzle-kit` (GHSA-67mh-4wv8-2f99). Não alcançável em produção: o advisory é
sobre o DEV SERVER do esbuild (que o drizzle-kit nem executa — usa esbuild só
para carregar config na CLI local de migração), drizzle-kit não entra no bundle
e `npm audit --omit=dev` = **0 vulnerabilidades**. Não há fix upstream:
drizzle-kit já está na última versão (0.31.10) e o `npm audit fix --force`
faria DOWNGRADE para 0.18.1. Disposição: **risco aceito**. Recomendação:
manter o CI em `--audit-level=high` para deps de prod (mudar para `moderate`
falharia permanentemente nesta cadeia sem fix); revisitar quando o drizzle-kit
trocar o loader.

**#5.** O risco residual TOCTOU/DNS-rebinding em `lib/documents/logo.ts` é
deliberado e documentado no próprio arquivo (pinning de IP quebraria SNI/cert);
os 6 controles ativos (https-only, lookup + blocklist de IP privado, sem
redirect, cap de 2 MB streamed, timeout 3s, allowlist de content-type) limitam o
blast radius a um GET cego que só "vaza" se a resposta for image/*. Fix real =
trocar URL remota por upload de arquivo em storage controlado (feature change,
fora do escopo cirúrgico). Fica como recomendação de produto.

**#7.** A infra E2E existe (`.github/workflows/ci.yml`, job gated por
`RUN_E2E == 'true'` + secrets `E2E_*`); ligá-la exige instância Clerk de staging
e usuários seed — ação do owner antes do launch pago, junto com um checkout real
de staging por plano (verificar moeda/valor/webhook/entitlement resultante).

**#8.** Nota adicionada ao SETUP.md §8: o build precisa de egress para Google
Fonts; vendoring via `next/font/local` só se builds offline virarem requisito.

## Resultado do gate

`npm run lint && npm run typecheck && npm test && npm run build` — **VERDE**
(exit 0), rodado no fim da auditoria com o fix LOW-1 aplicado:

- Lint: pass
- Typecheck: pass
- Testes: **158 arquivos / 1395 passed, 30 skipped** (skips são os testes
  opt-in de Postgres real, como sempre)
- Build: compilado com sucesso, 32/32 páginas geradas

Re-rodado após o adendo (fixes F1/F2/F3 do relatório do dev + 3 arquivos de
teste novos/estendidos): verde novamente — resultado registrado no commit do
adendo.
