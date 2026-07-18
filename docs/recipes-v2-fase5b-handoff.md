# Recipes 2.0 — Handoff para a Fase 5b (UI de portion options + calculadora)

Estado em 2026-07-18, fim da sessão que fechou a **Fase 5 (cost parity,
backend + painel de custo)** — 6 commits `93ce8c6..b340db9`, PUSHED. Leia
junto com `docs/recipes-v2-fase5-handoff.md` (contexto da fase) e §6.8/§7.3 do
plano mestre `docs/recipes-meez-parity-senior-plan.md`.

## 1. O que a Fase 5 já entregou (NÃO refazer)

- **Migração/backfill**: `recipe_portion_options` está na migração 0041 (JÁ
  aplicada ao Neon) e o backfill "Default serving" existe em
  `lib/data/recipes-v2-backfill.ts`. Zero trabalho de schema pendente.
- **Data layer completo** (`lib/data/recipe-portion-options.ts`):
  `listPortionOptions`, `createPortionOption` (primeira opção vira default
  automaticamente; cap 50), `updatePortionOption`, `deletePortionOption`
  (apagar o default promove a próxima), `setDefaultPortionOption`,
  `setNutritionServingPortionOption`, `loadDefaultPortionPrices` (dual-read).
  Tudo audita dentro do `withOrg` (`recipe.portionOption*`, metadata só flags).
- **Server Actions manager-gated** (`app/(app)/recipes/[id]/portion-actions.ts`):
  create/update/delete/set-default/set-nutrition — `FORBIDDEN` antes de
  qualquer acesso, Zod em `lib/validation/recipe-portion-options.ts`, código
  novo `PORTION_OPTION_LIMIT_REACHED` já mapeado em next-intl.
- **Módulo puro** (`lib/calculations/foodCost.ts`, 100% testado):
  `foodCostBps`, `profitCents`, `suggestedPriceCents` (direção inversa,
  clamped), `portionCostCents`, `portionOptionCostCents`.
- **Painel de custo** (`CostPanel` em
  `components/app/recipes/workspace/recipe-workspace-tabs.tsx`): tiles + linhas
  expansíveis (supplier/pack/origem do preço via
  `lib/data/recipe-cost-details.ts`) + cost/kg + cost por yield unit + lista
  READ-ONLY de portion costs. O DTO manager já ships `portionOptions`
  completas; o kitchen ships `KitchenPortionOption` (sem
  `sellingPriceCents`/`targetFoodCostBps`).
- **Dual-read** ativo em: active-catalogue (CFO/daily-close/menu-eng/
  profit-leaks), dashboard, card print/PDF/email.

## 2. Âmbito da Fase 5b — SÓ UI client-side

Construir no workspace (tab Cost, sob a lista "Portion costs" existente, ou
painel próprio) a gestão manager-only de portion options:

1. **CRUD**: adicionar/editar/remover opção (name, quantity, unit,
   sellingPriceCents, targetFoodCostBps); marcar default / nutrition serving.
   Chama as actions existentes — NÃO criar actions novas.
2. **Calculadora bidirecional** (§7.3): com o custo da porção
   (`portionOptionCostCents` — o server já o calcula em
   `PortionCostView.costCents`):
   - editar preço → mostra `foodCostBps`/`profitCents` recalculados;
   - editar target food cost → mostra `suggestedPriceCents` (aplicar só ao
     gravar);
   - **UMA direção ativa por interação** (o último campo tocado ganha; nunca
     um loop de formulário). Os módulos puros são a única matemática — não
     duplicar fórmulas no cliente.
3. **RBAC na UI**: o formulário só renderiza para manager (o kitchen já nem
   recebe os dados — `cost === null`). Nenhuma chave financeira nova no DTO
   kitchen; deep key-scan (`tests/recipe-workspace.test.ts`) tem de continuar
   verde.
4. Money input em cents via os padrões existentes do repo (ver como o
   RecipeEditor legacy edita `sellingPriceCents`); dinheiro formatado com
   `formatMoney(cents, currency)`.

## 3. Onde ligar

- `PortionCostView`/`WorkspaceCostView` em `recipe-workspace-tabs.tsx` — hoje é
  read-only; a Fase 5b provavelmente estende o view-model com
  `sellingPriceCents`/`targetFoodCostBps`/`optionId` (manager-only, já são
  manager-only por construção porque vivem dentro de `cost`).
- O server monta `portionCosts` em `app/(app)/recipes/[id]/workspace-page.tsx`
  (bloco `dto.role === 'manager'`).
- Depois de mutar, `router.refresh()` (as actions já fazem `revalidatePath`).
- i18n: `recipes.workspace.cost.*` em `lib/i18n/messages/en.json`.

## 4. Invariantes (herdadas, inegociáveis)

- Kitchen nunca recebe chaves financeiras; fixtures congeladas
  (`tests/recipes-v2-regression-fixtures.test.ts`) intactas.
- Money = integer cents; targets em bps 1..10000.
- Commits pequenos por slice; `npm run lint && npm run typecheck && npm test`
  antes de cada commit; `npm run build` antes do push.

## 5. Pendências fora da Fase 5b

- **Prep-reorder DEMAND** (perda de prep na demanda de inventário) — design
  próprio, decidir prioridade com o owner.
- **Fase 6**: nutrição (tab "Coming soon").
- ⚠️ Rotação da password do Neon (owner).
- Eyeball em prod do painel de custo novo (manager + kitchen) — owner.
