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

## 5. Nutrição passou para Ingredients (2026-09-15)

- O perfil nutricional é do **ingrediente** (um por ingrediente). Edita-se a partir do
  popup **View ingredient** (ícone olho em cada linha): secção Nutrition → "Add/Edit
  nutrition" abre o editor (estado Not added / Added / Incomplete no resumo da secção —
  sem colunas nem ícones extra na lista).
- Editor partilhado `components/app/ingredients/ingredient-nutrition-dialog.tsx`:
  Search for a food (USDA), Barcode lookup (Open Food Facts), Enter values manually.
  Sem botão Save: um resultado só é **selecionado**; "Use this match" é a única ação que
  grava. Valores manuais fazem autosave (pausa curta / blur) via
  `updateIngredientNutritionValuesAction` — patch esparso: chave omitida = intacta,
  `null` = limpar explícito, `0` = zero deliberado. Nunca substitui um match externo em
  silêncio (`NUTRITION_SOURCE_CONFLICT`); "Edit values manually" converte e reescala
  exatamente para 100 g.
- O tab Nutrition da receita só mostra o resultado; "Add nutrition" abre o mesmo
  editor sobre a receita e recalcula ao fechar. O hint "Use suggested USDA" passou a
  ser um match sugerido para rever dentro do editor.
- **Completude do rótulo mais estrita:** um perfil sem algum nutriente CORE (energia,
  gordura, hidratos, proteína, sódio — o mesmo core da qualidade OFF) gera
  `PARTIAL_PROFILE` → receita `incomplete` (print = rascunho). Receitas cujos
  ingredientes só tinham p.ex. calorias deixam de aparecer como completas — intencional.
- Sem migração.

## 6. Popup de detalhes do ingrediente (2026-09-15)

- `components/app/ingredients/ingredient-details-dialog.tsx`: o ícone olho substitui o
  antigo ícone de alergénios (e a ação Nutrition) na linha. Mostra nome + tipo, preço
  atual por kg/l/pc (excl. VAT + taxa de VAT resolvida por `suggestPurchaseVat`), e
  secções recolhíveis Supplier (nome, nome/código do produto, pack, preço do pack),
  Nutrition (valores, base, fonte) e Allergens (tags + estado de revisão).
- Só leitura: os botões de edição trocam o popup pelo editor autorizado existente
  (supplier / nutrition / allergens) e voltam ao popup ao fechar — nunca popups
  empilhados. Fechar devolve o foco ao botão da linha sem mexer em pesquisa/ordenação.
- Kitchen: sem preço/pack/código (não vêm no payload); vê nome do fornecedor,
  nutrição (só leitura) e alergénios (pode rever).
- Dados em falta: "Not added" / "Not reviewed", nunca 0 nem "allergen-free".
- Preço em falta: `displayPriceCents` (`lib/ingredients/incomplete.ts`) → "—" quando
  `needsPricing`; €0.00 só para um zero registado. Criar como manager sem preço de
  abertura passa a marcar `needsPricing = true`.
