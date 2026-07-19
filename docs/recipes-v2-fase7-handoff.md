# Recipes 2.0 — Handoff pós-Fase 6 (próxima = Fase 7, library parity & rollout)

Estado em 2026-07-18, fim da sessão que implementou a **Fase 6 (nutrição)**
completa, slices 1–7 em commits pequenos em `main`. Ler junto com
`docs/recipes-v2-fase6-plan.md` (plano aprovado + decisões D1–D5) e o plano
mestre `docs/recipes-meez-parity-senior-plan.md`.

## 0. ⚠️ Primeiro passo da próxima sessão

- `git push` continua BLOQUEADO nesta máquina ("Repository not found" — a
  credencial ativa é `labicresci-lgtm`, sem acesso a `Napster13Nord/PrepProfit`).
  O owner tem de trocar a conta (`gh auth switch`) e pushar TODOS os commits da
  Fase 6 + o docs `e4cb0b2`. Verificar `git status -sb` antes de trabalho novo.
- Env var nova para prod/preview quando o owner quiser USDA: `USDA_FDC_API_KEY`
  (opcional — sem ela o modal USDA cai em modo custom-only, decisão D1).

## 1. O que a Fase 6 entregou (NÃO refazer)

- **SEM migração nova** — `ingredient_nutrition_profiles` já existia (0041).
- `lib/calculations/nutrition.ts` — rollup puro com completude honesta
  (`null` = desconhecido; issues acionáveis `NO_PROFILE` /
  `NO_WEIGHT_EQUIVALENCY` / `SUBRECIPE_INCOMPLETE` / `NO_NUTRITION_SERVING`)
  + `nutritionServingFraction` (peso, unidade do yield, ou `serving(s)`).
- `lib/calculations/nutritionLabel.ts` — DV FDA 2016 único (D2) + rounding
  21 CFR 101.9 só na camada de label (D3); %DV calculado da precisão interna.
- `lib/usda/client.ts` — server-only FDC search/detail (abridged), Zod em tudo,
  timeout 8s + 1 retry + cache TTL em memória (D4), nutrientes normalizados
  por número FDC para o contrato por-100 g; key nunca logada.
- `lib/data/ingredient-nutrition.ts` — upsert 1-perfil-por-ingrediente sob
  lock do ingrediente ativo, batch loader, audit (`ingredient.nutritionSave`
  / `.nutritionRefresh` — ids/source, nunca valores).
- `app/(app)/ingredients/nutrition-actions.ts` — manager-only (D5), rate limit
  `usdaSearch` (20/min por org+user) antes de org work, USDA save RE-FETCHA
  server-side (valores do cliente só no caminho custom, Zod bounded).
  Error codes novos: `USDA_NOT_CONFIGURED`, `USDA_UNAVAILABLE`.
- `lib/data/recipe-nutrition-tree.ts` — resolver batch memoizado (gémeo do
  cost tree): closure bounded, sem N+1, volume/count→gramas via equivalencies
  (prep anchors substituem), filhos como batch (fração 1) e serving real só no
  topo (portion option `is_nutrition_serving` → fallback `nutrition_serving_*`).
- Tab Nutrition (`recipe-nutrition-tab.tsx`) — status+issues, Nutrition Facts
  preview, allergens contains/may-contain, tabela de ingredientes com source,
  modal USDA (Common/Branded, atribuição CC0) + custom + Refresh from source.
  Kitchen VÊ tudo; editar/refresh manager-only. i18n
  `recipes.workspace.nutrition.*` (só en.json).
- `/recipes/[id]/nutrition-label/print` + `/api/recipes/[id]/nutrition-label/pdf`
  — money-free (ambos os roles), rate limit `documents`, audit
  `export.nutritionLabelPdf` c/ flag draft; incompleto imprime com watermark
  `ESTIMATED / INCOMPLETE`; sem serving → 400/aviso; disclaimer sempre.
- Testes: 1837 pass / 35 skip; build OK. RLS (SELECT/INSERT/UPDATE/DELETE) da
  tabela de perfis, RBAC FORBIDDEN, trust boundary USDA, resolver (ciclos,
  equivalencies, serving), rota PDF (draft/400/404).

## 2. Deltas vs plano

- Slices 5+6 do plano fundiram-se: o bloco nutrition não entrou no
  `RecipeWorkspaceDTO`; o `workspace-page.tsx` resolve via
  `resolveRecipeNutritionTree` e envia `NutritionTabData` serializável no
  `WorkspaceClientData` (ambos os roles; `canEdit` = manager). Fixtures
  congeladas e deep key-scan intactos (nutrição é money-free).
- Rounding de vitaminas/minerais usa incrementos pragmáticos (vit D 0.1 mcg,
  cálcio 10 mg, ferro 0.1 mg) — rotulado estimativa, sem claim de conformidade.

## 3. Próxima fase — Fase 7 (plano mestre §16): library parity & rollout

- tabela/filtros/bulk actions/books; filtro por alergénico e status;
- atualização de consumidores legados; cohort rollout + remoção do fallback.
- Plan-first: fazer plano próprio antes de código.

## 3b. Feature pedida pelo owner (fora da Fase 7, sessão própria)

- **Catálogo seed de ingredientes comuns**: lista pesquisável (~milhares) para o
  user criar ingredientes sem começar do zero no onboarding. NÃO confundir com a
  busca USDA de nutrição (já entregue): isto cria o INGREDIENTE (nome, dimensão,
  alergénios típicos; `priceCents = 0` + `needsPricing = true` — preço nunca vem
  do catálogo). Plan-first; ver prompt no handoff da sessão que o owner guardou.

## 4. Pendências fora da Fase 7

- Rótulo EU 1169/2011 (produto foca Europa) — follow-up anotado na D2.
- Prep-reorder DEMAND — decidir prioridade com o owner.
- ⚠️ Rotação da password do Neon (owner).
- Eyeball em prod do tab Nutrition + label (manager + kitchen) — owner.
- Revisão jurídica do texto/layout do label antes de qualquer claim.

## 5. Invariantes herdadas (inegociáveis)

- Kitchen nunca recebe chaves financeiras; nutrição desconhecida = `unknown`,
  nunca 0; batch loaders; commits pequenos por slice; gate lint+typecheck+test
  por commit; build antes do push.
