# Recipes 2.0 — Handoff para a Fase 4 (UoM equivalencies + prep actions)

Estado em 2026-07-17, fim da sessão que fechou a Fase 3. Leia junto com o plano
mestre `docs/recipes-meez-parity-senior-plan.md` — as secções relevantes agora
são **§6.6** (modelo), **§7.2** (contrato de conversão), **§7.3** (custo com
prep yield) e **Fase 4 em §16** (5–7 dias).

## 1. O que já está feito e EM PRODUÇÃO

- **Fases 0–3 completas e PUSHED** (`origin/main` ≥ `35edd2d`). Workspace v2 é
  a experiência default nas 5 orgs (`organization_settings.recipes_workspace_v2`;
  rollback = `?editor=legacy`).
- **Migração 0041 aplicada ao Neon** — as tabelas da Fase 4 JÁ EXISTEM:
  `ingredient_uom_equivalencies` (schema.ts:209, unique por (org, ingredient),
  CHECKs de positividade nos três anchors) e `ingredient_prep_actions`
  (schema.ts:283, `yield_bps`, overrides opcionais de anchors). **NÃO é precisa
  migração nova**, salvo imprevisto.
- **As recipe lines já carregam os campos consumidores**: `recipe_ingredients`
  tem `prep_action_id` (FK composta), `entered_quantity` e `entered_unit`
  (schema.ts:746-755) — hoje sempre NULL; a Fase 4 passa a escrevê-los.
- **Fase 3 entregou**: save de método full-replace, upload de mídia (Vercel
  Blob PRIVADO, smoke-tested em prod), capa + mídia de passo, slideshow
  kitchen-safe, cron `sweep-recipe-media`. Ver `docs/recipes-v2-fase3-handoff.md`
  §1 para o mapa da facade/DTO.
- **Facade**: `lib/data/recipe-workspace.ts` — `getRecipeWorkspace` (DTO por
  role) e `saveRecipeWorkspace` (FOR UPDATE + `expectedVersion` + full-replace;
  padrão: TODA validação nova corre ANTES de qualquer write — um return non-ok
  não faz rollback, ver comentário no bloco de mídia).
- A tab **UoM** do workspace é um placeholder (`comingSoon`) em
  `components/app/recipes/workspace/recipe-workspace-tabs.tsx`.
- Testes: 1674 verdes. Fixtures congeladas de custo/escala em
  `tests/recipes-v2-regression-fixtures.test.ts` — **release blocker, não
  atualizar levianamente**: a Fase 4 só pode mudar custo quando uma prep action
  ou equivalência for realmente aplicada; linhas sem prep/equivalência têm de
  custar EXATAMENTE o mesmo.

## 2. Âmbito da Fase 4 (plano §16, 5–7 dias)

1. **Conversões puras** (`lib/calculations/` novo módulo, p.ex. `uom.ts`):
   contrato §7.2 — mesma dimensão via `lib/units`; entre dimensões via anchors
   (`weight_grams`/`volume_ml`/`each_count`). Resultado discriminado
   `{ ok, canonical, unit } | { ok: false, reason: 'MISSING_EQUIVALENCY' |
   'INVALID_INPUT' }`. **Nunca devolver zero em erro.** Pelo menos dois anchors
   positivos para uma equivalência válida (ex.: `141.75 g = 236.59 ml = 1 each`).
2. **Data layer + actions de equivalências**: CRUD por ingrediente (um registo
   ativo por ingrediente — unique já existe), `source manual|standard`,
   `updated_by`. Validação Zod server-side; audit se decidirem que é
   high-risk (provavelmente não é — é operacional, sem dinheiro).
3. **Prep actions**: CRUD por ingrediente (`name`, `yield_bps` em basis points,
   7854 = 78.54%; anchors opcionais que SOBRESCREVEM a equivalência base do
   ingrediente — "onion, diced" ≠ "onion, whole"). `sort_order` para o picker.
4. **Integração nas recipe lines**: o editor de linha ganha unidade de entrada
   (`entered_quantity`/`entered_unit` preservam o que o utilizador digitou; a
   `quantity` canónica continua a ser a fonte do custo) e prep action opcional.
   Estender `WorkspaceLineDraft` + `saveRecipeWorkspace` (mesmo padrão:
   validação pré-write de ownership da prep action → detail novo em
   `invalid_draft`).
5. **Custo com prep yield** (§7.3): `lineCostCents`/`recipeCost` consideram o
   yield da prep action **sem dupla perda** — a quantidade canónica da linha é
   o que a receita USA (edible); a perda de prep afeta custo/compra requerida.
   Cuidado: decidir e documentar explicitamente se `quantity` é pré ou pós-prep
   (o plano §6.6 diz: canónico = o que a receita usa; prep loss entra no custo).
6. **Missing-equivalency states na UI**: tab UoM do workspace deixa de ser
   placeholder — mostra as equivalências dos ingredientes da receita, marca as
   linhas em volume/count sem equivalência de peso e explica QUAL anchor falta
   (mensagem acionável, nunca silêncio nem zero).

## 3. Invariantes a não violar

- Fixtures congeladas: linha sem prep action e sem conversão de dimensão custa
  o MESMO cent que hoje.
- Nunca guardar texto de unidade como matemática — converter para anchors
  canónicos no server (`lib/units/quantity.ts` já faz parsing de texto).
- Kitchen nunca recebe chaves financeiras (deep key-scan em
  `tests/recipe-workspace.test.ts` tem de continuar verde e cobrir DTOs novos).
- Save sempre via facade com `expectedVersion`; validação nova SEMPRE antes do
  primeiro write (return non-ok não faz rollback).
- Money = integer cents; `yield_bps` = integer basis points; testes de
  NaN/Infinity/overflow nos módulos puros.

## 4. Convenções do repo (resumo; detalhe no handoff da Fase 3 §4)

- PGlite via `tests/helpers/db.ts` (migrations + RLS reais); tabela nova →
  `businessTables` (não aplicável aqui, as tabelas já existem e já estão lá).
- `withOrg`/`runInOrg` sempre; FKs compostas `(org_id, id)`.
- UI via next-intl (`recipes.workspace.*` em `lib/i18n/messages/en.json`);
  erros de action via `ActionErrorCode` + `actionErrors.*`.
- `noUncheckedIndexedAccess` no typecheck — cuidado com indexação de arrays.
- Commits pequenos por slice; `npm run lint && npm run typecheck && npm test`
  antes de cada commit; `npm run build` antes do push final.

## 5. Ordem sugerida de slices

1. Módulo puro de conversão UoM + testes (zero, negativo, NaN, Infinity,
   anchor em falta, round-trip weight↔volume↔each).
2. Data layer + Zod + actions de equivalências e prep actions + testes
   PGlite/RLS (cross-org, unique por ingrediente).
3. UI de gestão (onde: página do ingrediente e/ou tab UoM do workspace — a tab
   UoM mostra o estado por receita; a edição pode viver num dialog).
4. Recipe lines: entered unit + prep action no draft/save/facade + editor.
5. Custo com prep yield em `lib/calculations/recipeCost.ts` + fixtures novas
   (as antigas intactas) + DTO do cost panel.
6. Missing-equivalency states + polish + testes RBAC/deep-scan das superfícies
   novas.
