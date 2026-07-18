# Recipes 2.0 — Handoff pós-Fase 5b (próxima = Fase 6, Nutrição)

Estado em 2026-07-18, fim da sessão que fechou a **Fase 5b (UI de portion
options + calculadora bidirecional)** — commit `e4d4097` em `main`. Leia junto
com `docs/recipes-v2-fase5b-handoff.md` (contexto) e o plano mestre
`docs/recipes-meez-parity-senior-plan.md`.

## 0. ⚠️ Primeiro passo da próxima sessão

- O commit `e4d4097` está **LOCAL, não pushed**: o `gh` desta máquina está
  autenticado como `labicresci-lgtm`, que não tem acesso a
  `Napster13Nord/PrepProfit`. O owner tem de `gh auth login`/`gh auth switch`
  para a conta Napster13Nord e correr `git push`. Verificar com `git status`
  se `main` ainda está ahead antes de começar trabalho novo.

## 1. O que a Fase 5b entregou (NÃO refazer)

- `components/app/recipes/workspace/recipe-portion-options.tsx` — CRUD
  manager-only de portion options no tab Cost (add/edit/delete com confirmação,
  make default, use-for-nutrition) chamando as Server Actions da Fase 5
  (`portion-actions.ts`); `router.refresh()` após mutar; erros via
  `useActionError` (incl. `PORTION_OPTION_LIMIT_REACHED`).
- Calculadora bidirecional no form: custo da porção live via
  `portionOptionCostCents` (reage a quantity/unit); preço → food cost % +
  profit; target % → suggested price com botão "Use suggested" (só preenche o
  campo; nada persiste até Save). Último campo tocado decide a direção; toda a
  matemática vem de `lib/calculations/foodCost` — zero fórmulas no cliente.
- `PortionCostView` estendido com `quantity/unit/sellingPriceCents/
  targetFoodCostBps/isNutritionServing` — montado só no bloco
  `dto.role === 'manager'` de `workspace-page.tsx`, dentro de `cost`
  (kitchen recebe `cost: null`; deep key-scan e fixtures congeladas verdes).
- i18n `recipes.workspace.cost.portionEditor.*` (só `en.json` existe).
- Gate 1755 pass / 35 skip + build OK. Sem migração.

## 2. Próxima fase — Fase 6: Nutrição (plano mestre)

Secções relevantes do plano `docs/recipes-meez-parity-senior-plan.md`:

- **§6.7** `ingredient_nutrition_profiles` (um ativo por ingrediente; cada
  nutriente nullable — `null` = desconhecido, NUNCA zero silencioso; regra 8).
- **§7.4** cálculo: nutriente por grama × edible weight, rollup recursivo por
  componente, `% Daily Value` só com DV configurado; ausência propaga como
  ausente.
- **§9.6** UI do tab Nutrition: tabela de ingredientes com source match,
  edible %, peso nutricional; modal "Update Ingredient Nutrition" com busca
  USDA (Common/Branded) e opção custom.
- Rotas: `/recipes/[id]/nutrition-label/print` +
  `/api/recipes/[id]/nutrition-label/pdf`.
- `is_nutrition_serving` já existe em `recipe_portion_options` (migração 0041)
  e a UI de marcar já está feita (Fase 5b). `nutrition_serving_*` também já
  existem em `recipes`.
- Invariantes: nada de afirmação de conformidade legal sem revisão jurídica;
  auditoria em nutrição customizada/refresh USDA; batch loaders, nunca N+1.
- Fase 6 é grande: fazer plano próprio (plan-first) e partir em slices; provável
  migração nova (`ingredient_nutrition_profiles`) → diff review antes de prod.

## 3. Pendências fora da Fase 6

- **Prep-reorder DEMAND** (perda de prep na demanda de inventário) — design
  próprio; decidir prioridade com o owner.
- Follow-up pequeno opcional: a gestão de porções só renderiza quando o custo
  está completo (mesmo branch do painel); permitir gerir com custo incompleto
  se incomodar na prática.
- ⚠️ Rotação da password do Neon (owner).
- Eyeball em prod do painel de custo + portion editor (manager + kitchen) —
  owner.

## 4. Invariantes herdadas (inegociáveis)

- Kitchen nunca recebe chaves financeiras; fixtures congeladas intactas.
- Money = integer cents; targets em bps 1..10000; nutrição desconhecida =
  `unknown`, nunca 0.
- Commits pequenos por slice; `npm run lint && npm run typecheck && npm test`
  antes de cada commit; `npm run build` antes do push.
