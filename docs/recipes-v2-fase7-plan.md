# Recipes 2.0 — Fase 7: library parity & rollout (plano para aprovação)

Fonte de âmbito: plano mestre `docs/recipes-meez-parity-senior-plan.md` §16 (Fase 7)
+ handoff `docs/recipes-v2-fase7-handoff.md` §3. Screenshots alvo: `Recipes/1.png`
(biblioteca em tabela), `Recipes/2.png` (Recipe Books), `Nutrition and label/6.png`
(filtro por alergénico com contagem e busca).

Status: ✅ COMPLETO 2026-07-19 (Slices 1–6b, commits `7c6c4e8..3808c8e` em
`main`, PUSHADO; SEM migração nova). O owner correu em prod
`npm run backfill:recipes-v2` (idempotente, 0 alterações → já conforme) +
`npm run verify:recipes-v2` (paridade limpa) e o Slice 6b removeu o fallback
`?? recipes.selling_price_cents` de TODOS os consumidores — a default portion
option é agora a fonte única do preço. `recipes.selling_price_cents` continua
a ser escrita+espelhada (D3: drop físico = migração futura fora da Fase 7),
apenas deixou de ser LIDA. Delta vs plano: o Slice 5 já estava maioritariamente
feito na Fase 5 (todos os LEITORES usavam o helper); o trabalho foi a ESCRITA
(default option em todo o createRecipe + mirror de preço alterado no
updateRecipe). Fix colateral: isForeignKey/isUniqueViolation agora percorrem a
cause chain do DrizzleQueryError. ⚠️ verify enumerou só 1 org — confirmar com
o owner que é mesmo o universo prod completo. Gate final: 1876 pass/35 skip +
build OK.

Decisões aprovadas 2026-07-19:
D1 = toggle tabela/cards (tabela default, cards preservados);
D2 = books e folders COEXISTEM nesta fase (FolderRail mantém-se; books aditivos,
write-through folder→book homónimo mantém paridade);
D3 = drop físico das colunas legadas fica para migração futura fora da Fase 7;
D4 = proxy SQL barato para "nutrition incomplete";
D5 = ship direto SEM flag (rollback = revert de commit).

## 0. Estado atual (levantado no código, 2026-07-19)

- Biblioteca (`app/(app)/recipes/page.tsx`): grid de cards (`RecipeList`) +
  `FolderRail` por `recipes.folder_id`. Sem tabela, sem bulk actions, sem filtros
  além de folder.
- `recipe_books` + `recipe_book_entries` existem no schema (0041), com RLS e
  backfill idempotente folders→books (`lib/data/recipes-v2-backfill.ts`), mas
  **sem data layer CRUD e sem UI**. ⚠️ Confirmar com o owner se
  `scripts/backfill-recipes-v2.ts` já correu em prod (pré-requisito do rollout).
- Dual-read de preço: `loadDefaultPortionPrices` (lib/data/recipe-portion-options.ts)
  resolve `option.sellingPriceCents ?? recipes.selling_price_cents`. Consumidores
  do legado: menus, dashboard, active-catalogue, menu-engineering, profit-leaks,
  cfo-report, documents/recipe-card (+ workspace já migrado).
- Alergénios: `loadOrgRecipeAllergens` já devolve rollup por receita (derived +
  overrides, contains/may-contain) — serve o filtro sem cálculo novo.
- Nutrição: completude honesta existe por receita via resolver
  (`resolveRecipeNutritionTree`), mas é caro para uma listagem — o filtro de
  status usa proxy barato (ver Slice 3).

## 1. Âmbito

1. Biblioteca em tabela com pesquisa/ordenação/colunas por role + bulk actions.
2. Recipe Books: CRUD + membership many-to-many como organizador primário.
3. Filtros: por alergénico (com contagens) e por status (incompletos).
4. Consumidores legados → novo modelo (preço via portion option default;
   folders → books).
5. Cohort rollout + remoção do fallback dual-read quando seguro.

Fora de âmbito: nutrição/label (Fase 6, DONE), catálogo seed (DONE), slideshow,
qualquer alteração de cálculo de custo.

## 2. Decisões a aprovar

- **D1 — DECIDIDO: toggle tabela/cards.** Tabela é a vista default (parity com
  `Recipes/1.png`); toggle no header preserva o grid de cards; preferência via
  `?view=` (default table).
- **D2 — DECIDIDO: coexistência.** FolderRail mantém-se; books são aditivos
  (secção/tab própria no rail). `moveRecipeToFolder` ganha write-through para o
  book homónimo, mantendo books em paridade com folders; remoção do UI de
  folders fica para depois da Fase 7.
- **D3 — DECIDIDO: sem drop físico nesta fase.** Apenas parar de LER
  `selling_price_cents`/`folder_id` onde o novo modelo cobre; migração de drop
  fica registada como pendência futura.
- **D4 — DECIDIDO: proxy barato.** "nutrition incomplete" = existe ingrediente
  ativo da receita sem `ingredient_nutrition_profiles`; documentado como
  aproximação. Status exato continua no workspace.
- **D5 — DECIDIDO: ship direto sem flag.** Sem env var de cohort; rollback =
  revert de commit. O Slice 6 perde o passo de remoção de flag.

## 3. Slices (1 commit cada; gate lint+typecheck+test+build antes de cada)

### Slice 1 — Data layer de books + backfill-check

- `lib/data/recipe-books.ts`: listBooksWithCounts, createBook, renameBook,
  deleteBook (entries via cascade), setRecipeBooks (replace atómico das
  memberships de uma receita), addRecipesToBook / removeRecipesFromBook (bulk).
  Tudo org-scoped, dentro de `withOrg`, locks onde há replace.
- Dual-write: mutações de books mantêm `folder_id` coerente quando a receita
  tem exatamente 1 book com nome de folder existente? NÃO — decisão inversa:
  `moveRecipeToFolder` legado passa a TAMBÉM gravar membership no book homónimo
  (write-through), e o caminho novo só escreve books. Simples e um só sentido.
- Testes: RLS (SELECT/INSERT/UPDATE/DELETE cross-org), unicidade (org,name),
  replace atómico, cascade.

### Slice 2 — Biblioteca em tabela

- `listRecipesForLibrary` novo em `lib/data/recipes.ts`: uma passada org-scoped
  que devolve por receita: nome, books (ids+nomes), yield chef-facing,
  lineCount, preço default (via `loadDefaultPortionPrices`), custo total (via
  cost tree batch já existente do catálogo), allergens rollup
  (`loadOrgRecipeAllergens`), flags de status. Batch loaders, sem N+1.
- RBAC: custo/margem/preço STRIPPED server-side para kitchen (padrão
  `toKitchenRecipe`), payload inspecionado em teste, não CSS.
- UI: TanStack Table (`components/app/recipes/library-table.tsx`) — colunas
  name / books / yield / allergens (chips) / status / [cost, price, margin —
  manager-only], pesquisa client-side, sort, paginação client-side se >100.
  Row click → workspace. i18n `recipes.library.*` (só en.json).
- Toggle tabela/cards no header (D1, `?view=`, default table); FolderRail
  mantém-se e o rail ganha secção de books (D2); `?book=` no URL como
  `?folder=` hoje (mutuamente exclusivos: book ganha se ambos presentes).

### Slice 3 — Filtros por alergénico e por status

- Filtro alergénico: multi-select dos 14 slugs com contagem por slug
  (contains e may-contain distinguidos, como `Nutrition and label/6.png`);
  interseção com pesquisa/book. Fonte: rollup já carregado no Slice 2 —
  filtragem client-side sobre o payload da listagem (a listagem já é full-org).
- Filtro status (multi): `needs-pricing` (algum ingrediente needsPricing ou
  preço 0), `no-selling-price` (default option sem preço), `nutrition-incomplete`
  (proxy D4), `allergens-unreviewed` (ingrediente com allergens não revistos —
  `reviewed_at IS NULL`), `no-book`. Flags computadas server-side no
  `listRecipesForLibrary`; filtro client-side.
- Kitchen vê filtros operacionais (alergénio, allergens-unreviewed, no-book);
  filtros financeiros (needs-pricing, no-selling-price) manager-only e ausentes
  do payload kitchen.

### Slice 4 — Bulk actions

- Multi-select na tabela → barra de ações: add to book / remove from book /
  move to trash (soft-delete em lote). Server Actions com Zod (array de ids
  bounded, ex. máx 200), org-scoped, uma transação `withOrg` por ação, audit
  (`recipe.bulkTrash` com count+ids; book ops sem audit — operacional, como
  folders hoje) — confirmar na revisão se bulk trash é "high-risk" o suficiente
  (proposta: sim, audita).
- Trash em lote respeita as invariantes existentes de softDeleteRecipe
  (sub-receitas: bloquear se a receita é componente ativa de outra — mesmo
  código-caminho, erro estável `RECIPE_IN_USE` por linha, resultado parcial
  reportado).

### Slice 5 — Consumidores legados → novo modelo

- Preço: todos os consumidores (menus, dashboard, active-catalogue,
  menu-engineering, profit-leaks, cfo-report, documents/recipe-card) passam a
  resolver via `loadDefaultPortionPrices` (os que ainda leem a coluna direto).
  O fallback `?? sellingPriceCents` MANTÉM-SE neste slice (é a remoção do
  Slice 6). Escritas de preço no editor legado gravam TAMBÉM na default option
  (write-through), para o fallback deixar de ser necessário.
- Folders: coexistem (D2) — nenhum consumidor de folder é removido nesta fase;
  apenas o write-through folder→book (Slice 1) mantém paridade.
- Testes de regressão: fixtures congeladas de custo intactas; snapshot de
  preços por consumidor antes/depois idêntico.

### Slice 6 — Rollout + remoção do fallback

Pré-requisitos (owner): backfill v2 corrido em prod para TODAS as orgs
(script existente) + verificação (contagens books/options vs folders/recipes).

- Verificação automatizada: script `scripts/verify-recipes-v2-parity.ts`
  (read-only) que reporta por org: receitas sem default option, options default
  com preço NULL mas coluna legada com preço, folders sem book homónimo.
  Correr em prod; zero divergências = seguro.
- Remoção do fallback: `loadDefaultPortionPrices` deixa de ler
  `recipes.selling_price_cents`; write-through do editor legado removido junto
  (o editor legado de preço aponta só para a option). `folder_id` continua
  lido pelos caminhos de folder que coexistem (D2).
- Docs: handoff Fase 7 → estado final; nota da migração futura de drop das
  colunas (D3) registada como pendência.

## 4. Invariantes (herdadas, inegociáveis)

- Rule 1 org scoping em toda a query; RLS testada para tabelas tocadas.
- Kitchen nunca recebe chaves financeiras no payload (teste de inspeção).
- Zod em todo o input; error codes estáveis via next-intl (só en.json).
- Dinheiro em cents inteiros; cálculos puros intocados.
- Fixtures congeladas de custo/escala/estoque passam sem alteração.
- Commits pequenos por slice; gate completo antes de cada commit; build antes
  do push (push é do owner nesta máquina).

## 5. Riscos

- Backfill não corrido/parcial em prod → Slice 6 bloqueado; o verify script é
  o gate objetivo.
- Listagem full-org com rollups pode pesar em orgs grandes (Gui: 133 receitas —
  ok); paginação client-side e batch loaders limitam; se necessário, medir e
  só então otimizar.
- Bulk trash com sub-receitas: resultado parcial precisa de UX honesta
  (n moved, m blocked + porquê).
