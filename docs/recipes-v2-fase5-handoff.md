# Recipes 2.0 — Handoff para a Fase 5 (cost parity)

Estado em 2026-07-17, fim da sessão que fechou a **Fase 4** (UoM equivalencies +
prep actions). Leia junto com o plano mestre
`docs/recipes-meez-parity-senior-plan.md` — secções relevantes: **§6.8**
(portion options + food cost), **§7.3** (contrato de custo) e **Fase 5 em §16**
(4–6 dias). O handoff da Fase 4 (`docs/recipes-v2-fase4-handoff.md`) continua
válido como mapa do módulo UoM/prep.

## 1. O que já está feito e onde está

- **Fases 0–4 completas.** Fases 0–3 estão PUSHED (`origin/main` ≥ `35edd2d`).
  A **Fase 4 está COMMITTED em `main` LOCAL mas NÃO PUSHED** — 7 commits:
  `914220f..afef943` (6 slices) + `2de682b` (follow-up: prep-yield nos
  relatórios do catalogue). **Primeira ação da Fase 5: dar `git push`** (ou o
  owner faz). Gate verde 1709 pass/35 skip, `npm run build` OK.
- **Migração:** a última aplicada ao Neon é a **0041** (tabelas UoM/prep +
  colunas de linha `prep_action_id`/`entered_quantity`/`entered_unit`). A
  Fase 5 **PRECISA de migração nova** para `recipe_portion_options` — ver §3.
- **Workspace v2 é o editor default** nas 5 orgs
  (`organization_settings.recipes_workspace_v2`; rollback `?editor=legacy`).

## 2. Âmbito da Fase 5 (plano §16, 4–6 dias)

Objetivo: **custo equivalente aos screenshots do Meez sem vazar dinheiro para
kitchen.** Cinco frentes:

1. **Painel de custo expansível + supplier details** (§7.3). O `CostPanel`
   (`components/app/recipes/workspace/recipe-workspace-tabs.tsx`) hoje mostra 4
   tiles agregados. A Fase 5 abre cada linha: purchase item, custo de compra,
   unidade, fornecedor, data e **origem do preço aprovado**. Linha sem preço
   mostra `Needs pricing` — nunca zero "grátis". Sub-receita continua recursiva
   e falha-fechado se a árvore for incompleta.
2. **Resumo por yield unit** — custo por unidade de yield (ex.: custo/kg, já há
   `costPerKgCents` em `lib/calculations/recipeCost.ts`) e por porção, coerente
   com o batch scaling do workspace.
3. **Portion options + food cost calculator** (§6.8) — a peça grande:
   nova tabela `recipe_portion_options` (schema já ESBOÇADO em `schema.ts:1102`
   — CONFIRMAR que corresponde a §6.8 e gerar a migração). Cada opção tem
   `quantity/unit`, `selling_price_cents`, `target_food_cost_bps`, flags
   `is_default`/`is_nutrition_serving` (uniques parciais já no schema). Calculadora
   bidirecional: alterar target food cost → sugere preço; alterar preço →
   recalcula food cost (`foodCostBps = round(costCents*10000/sellingPriceCents)`,
   `profitCents = sellingPriceCents - costCents`). **Uma só direção ativa por
   interação** (evita loop de formulário). Backfill: criar `Default serving`
   (qty `1 serving`, preço atual). **Dual-read** até menus/dashboard/documentos
   migrarem da origem antiga (`recipes.selling_price_cents`).
4. **RBAC/audit** — tudo isto é MANAGER-ONLY (dinheiro). O `CostPanel` já ships
   `null` para kitchen (o DTO kitchen não tem chaves financeiras — o deep
   key-scan em `tests/recipe-workspace.test.ts` tem de continuar verde e cobrir
   os DTOs novos). Mutações de portion option / preço passam por action
   manager-gated + audit (mesmo padrão das mutações financeiras existentes).
5. **Regressão financeira** — as fixtures congeladas
   (`tests/recipes-v2-regression-fixtures.test.ts`) são release blocker:
   custo/escala não podem mexer. Portion options são aditivos; o preço via
   default option tem de bater certo com o `selling_price_cents` de hoje no
   backfill.

## 3. Migração nova (obrigatória nesta fase)

`recipe_portion_options` está DEFINIDA em `lib/db/schema.ts:1102` (com uniques
parciais para um só default e um só nutrition-serving, CHECKs de qty>0 e de
preço/target ≥ 0) e a fase 3 já a lê no facade
(`lib/data/recipe-workspace.ts` — `portionRows`, `KitchenPortionOption` remove
`sellingPriceCents`/`targetFoodCostBps`). **MAS a migração drizzle pode ainda
não existir** — confirmar com `npm run db:generate` (deve haver diff se a tabela
não estiver numa migração aplicada) e garantir que está em `businessTables`
(RLS). Aplicar em local primeiro; **prod migra só após diff review** (o owner
costuma autorizar diretamente, padrão F5/F6). O owner tem de rotacionar a Neon
pw pendente antes/depois.

## 4. Invariantes a não violar (herdadas)

- Kitchen NUNCA recebe chaves financeiras — deep key-scan verde, cobrir DTOs
  novos (portion prices, supplier cost details).
- Money = integer cents; food cost / target em basis points; testes de
  NaN/Infinity/overflow nos módulos puros novos.
- Custo é SEMPRE live via `resolveRecipeCostTree` (`lib/data/recipe-cost-tree.ts`)
  — o resolver partilhado; nenhum consumidor cria a sua própria recursão. O
  custo já honra o **prep yield** (Fase 4): `lineCostCents` tem `prepYieldBps`
  opcional = perda de compra requerida, sem dupla perda.
- Save via facade com `expectedVersion`; validação nova SEMPRE antes do primeiro
  write (return non-ok não faz rollback — ver comentários no `saveRecipeWorkspace`).
- Fixtures congeladas intactas.

## 5. Estado do custo/prep yield (para não duplicar trabalho)

O prep yield da Fase 4 já flui para TODAS as superfícies de **custo**:
- painel de custo do workspace + página legacy + card impresso (via
  `resolveRecipeCostTree` e `lib/data/recipes.ts` loaders);
- relatórios do catalogue: CFO semanal, daily-close, menu-engineering,
  profit-leaks (via `CatalogueRecipeLine.prepYieldBps` em
  `lib/data/active-catalogue.ts`).

**Pendência conhecida (fora da Fase 5, eixo diferente):** o prep yield afeta o
**custo** mas o `prep-reorder-plan` (`lib/data/prep-reorder-plan.ts`) calcula
**demanda/compra** (quantidade de inventário consumida), que NÃO foi ajustada —
uma receita que usa 200 g de cebola "diced" (edível) consome 250 g de cebola
crua do stock. Isso é um design próprio (matemática de quantidade + fixtures) e
foi deixado explicitamente de fora. Decidir se entra na Fase 5 ou fica para
depois.

## 6. Ordem sugerida de slices

1. Confirmar/gerar migração de `recipe_portion_options` + `businessTables` +
   testes RLS (cross-org, um-default, um-nutrition-serving) + backfill
   `Default serving`.
2. Data layer + Zod + actions manager-gated + audit para portion options
   (CRUD, set-default, set-nutrition-serving).
3. Módulo puro do food cost calculator (`foodCostBps`/`profitCents`/sugestão de
   preço; uma direção por interação; NaN/Infinity/overflow) + testes.
4. Painel de custo expansível + supplier/price-origin details no DTO
   manager-only + deep key-scan das superfícies novas.
5. Resumo por yield unit + portion cost (fração da porção sobre o yield total).
6. Dual-read (menus/dashboard/documentos) da default portion option; regressão
   financeira + `npm run build`.

## 7. Convenções do repo (resumo)

- PGlite via `tests/helpers/db.ts` (migrations + RLS reais); tabela nova →
  `businessTables`. `withOrg`/`runInOrg` sempre; FKs compostas `(org_id, id)`.
- UI via next-intl (`recipes.workspace.*` em `lib/i18n/messages/en.json`);
  erros de action via `ActionErrorCode` + `actionErrors.*` (Fase 4 adicionou
  `PREP_ACTION_IN_USE`).
- `noUncheckedIndexedAccess` no typecheck.
- Commits pequenos por slice; `npm run lint && npm run typecheck && npm test`
  antes de cada commit; `npm run build` antes do push final.
- ⚠️ prod Neon pw continua a precisar de rotação.
