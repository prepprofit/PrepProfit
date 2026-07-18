# Recipes 2.0 — Fase 6: Nutrição (plano para aprovação)

Estado: **APROVADO pelo owner 2026-07-18.** Decisões: D1 sim (`USDA_FDC_API_KEY`,
sem ela só custom; produto foca Europa no launch); D2 FDA 2016 único (schema é
FDA-shaped; rótulo EU 1169/2011 anotado como follow-up); D3 sim (rounding FDA só na
camada de label, estimativa); D4 sim (cache memória + snapshot, sem tabela nova);
D5 kitchen VÊ tab/label, edição manager-only com audit.
Base: plano mestre `docs/recipes-meez-parity-senior-plan.md` §6.7 / §7.4 / §9.6 / §19 / §20
e handoff `docs/recipes-v2-fase6-handoff.md`.

## 0. O que JÁ existe (não refazer)

- **Sem migração nova necessária**: `ingredient_nutrition_profiles` já foi criada na
  migração `0041` (aplicada em prod), com CHECK de `basis_grams`, unique por
  `(org, ingredient)`, FK composta, índice org e entrada em `businessTables` (RLS).
- `recipes.nutrition_serving_quantity/unit` e
  `recipe_portion_options.is_nutrition_serving` (unique parcial: 1 por receita) já
  existem; a UI de marcar "use for nutrition" foi entregue na Fase 5b.
- Alergénios: rollup completo (`lib/calculations/allergens.ts`) — Fase 6 só apresenta
  `contains` vs `may contain` no tab Nutrition; não mexe no modelo.
- Tab Nutrition existe em `recipe-workspace-tabs.tsx` como placeholder "coming soon".
- Equivalências UoM + prep yield (Fase 4) fornecem o caminho volume/count→gramas.

## 1. Âmbito da Fase 6

1. Integração USDA FoodData Central **server-side** (search Common/Branded + detail),
   API key só no servidor, cache + timeout + retry limitado + rate limit por org.
2. Perfil nutricional por ingrediente: snapshot USDA normalizado por 100 g **ou**
   custom manual (mesmo contrato por 100 g); `Refresh from source` explícito.
3. Cálculo puro recursivo de nutrição da receita com **completeness honesto**
   (`null` = desconhecido, nunca zero silencioso; sub-receita incompleta contamina o pai).
4. UI do tab Nutrition (§9.6): status de completude, tabela de ingredientes
   (source match, edible %, peso nutricional, editar), modal Update Ingredient
   Nutrition (busca USDA + custom), allergens/may-contain, preview do rótulo.
5. Label print/PDF: `/recipes/[id]/nutrition-label/print` +
   `/api/recipes/[id]/nutrition-label/pdf`; estados disabled/draft(`ESTIMATED /
   INCOMPLETE` watermark)/final; disclaimer "estimativa, não substitui análise
   laboratorial nem garante conformidade 21 CFR 101.9"; atribuição USDA (CC0).

Fora de âmbito: filtro de biblioteca por alergénico (Fase 7), prep-reorder demand,
qualquer afirmação de conformidade legal.

## 2. Decisões que preciso do owner

- **D1 — Env var**: novo `USDA_FDC_API_KEY` (Vercel + `.env.local`). Sem a key, o
  modal USDA mostra estado "não configurado" e só permite custom. OK?
- **D2 — Daily Values**: um único padrão FDA 2016 (adultos) hard-coded em módulo puro
  versionado (`lib/calculations/nutritionLabel.ts`), sem seletor de padrão por org
  nesta fase. OK?
- **D3 — Rounding**: aplicar as regras de arredondamento FDA na camada de label
  (separada da precisão interna), marcado como estimativa. OK?
- **D4 — Cache USDA**: cache em memória por processo (TTL curto) + snapshot no DB no
  momento do save; sem tabela de cache nova. OK?
- **D5 — RBAC**: nutrição é operacional (kitchen pode VER o tab Nutrition e o label;
  edição de perfis = manager-only, com audit). Confirmar.

## 3. Slices (1 commit cada; gate lint+typecheck+test antes de cada commit)

### Slice 1 — cálculo puro `lib/calculations/nutrition.ts`
- Tipos: `NutrientKey` (17 nutrientes do schema), `NutritionProfilePer100g`
  (valores `number | null`), resultado discriminado
  `{ status: 'complete' | 'incomplete', totals, perServing, missing: [...] }`.
- `nutrientForLine = per100g * edibleWeightGrams / 100`; rollup recursivo por
  componente proporcional ao peso usado; divisão por servings; ausência propaga.
- Motivos de incompletude acionáveis: `NO_PROFILE`, `NO_WEIGHT_EQUIVALENCY`,
  `NO_NUTRITION_SERVING`, `SUBRECIPE_INCOMPLETE`.
- Testes: zero/negativo/NaN/Infinity, null-propagation, sub-receita contaminante,
  linha volume sem equivalência.

### Slice 2 — label puro `lib/calculations/nutritionLabel.ts`
- Tabela DV FDA 2016 + `%DV` só para nutrientes com DV; regras de arredondamento
  FDA em camada separada; testes de fronteiras de arredondamento.

### Slice 3 — cliente USDA server-only `lib/usda/`
- `searchFoods` (Common=Foundation/SR Legacy vs Branded) + `getFood(fdcId)` com
  Zod nos payloads, timeout, retry limitado, normalização para o contrato por 100 g
  (mapa nutrientId→coluna; ausente = `null`).
- Rate limit por org via limiter existente (`rateLimitKey('usda', orgId:userId)`).
- Testes com respostas mockadas: nutriente em falta, unidade inesperada, erro HTTP.

### Slice 4 — data layer + Server Actions
- `lib/data/ingredient-nutrition.ts`: get/upsert profile (um ativo por ingrediente,
  upsert), `refreshFromSource`, batch loader `getProfilesForIngredients` (nunca N+1).
- Actions manager-only: `searchUsdaFoodsAction`, `saveIngredientNutritionAction`
  (USDA snapshot ou custom com validação não-negatividade/limites máximos),
  `refreshIngredientNutritionAction`. Audit event em save/refresh (ids e source,
  sem conteúdo). Error codes estáveis (`USDA_UNAVAILABLE`, `USDA_NOT_CONFIGURED`…).
- Testes RLS (SELECT/INSERT/UPDATE cross-org) + RBAC FORBIDDEN.

### Slice 5 — DTO do workspace
- `getRecipeWorkspace` ganha bloco `nutrition` (batch: perfis + pesos + equivalências
  já resolvidos) para manager **e** kitchen (D5) — sem chaves financeiras; deep
  key-scan e fixtures congeladas continuam a passar.

### Slice 6 — UI do tab Nutrition
- Substituir placeholder: status de completude no topo com lista acionável;
  tabela de ingredientes (source match, edible %, peso nutricional, ação editar
  manager-only); allergens vs may-contain; preview Nutrition Facts live.
- Modal `Update Ingredient Nutrition`: busca USDA com toggle Common/Branded,
  atribuição USDA visível, fallback custom; `router.refresh()` pós-save.
- i18n `recipes.workspace.nutrition.*` (en.json).

### Slice 7 — print + PDF
- `/recipes/[id]/nutrition-label/print` (página print-friendly) e
  `/api/recipes/[id]/nutrition-label/pdf` (stack PDF existente dos documentos).
- Botão no tab: disabled sem serving/dados; `Print draft` com watermark
  `ESTIMATED / INCOMPLETE`; final só com completeness OK. Disclaimer + fonte.

### Slice 8 — docs + handoff
- Atualizar este plano com o realizado, runbook USDA (env var, limites, custos),
  handoff Fase 7.

## 4. Invariantes

- Money nunca aparece no payload kitchen; nutrição desconhecida = `unknown`, nunca 0.
- AI/API externa = untrusted: Zod em tudo, snapshot só após confirmação humana.
- Batch loaders; `npm run build` antes de push; commits pequenos por slice.
