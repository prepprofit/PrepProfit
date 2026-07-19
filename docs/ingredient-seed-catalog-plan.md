# Catálogo seed de ingredientes comuns — plano para aprovação

Estado: **IMPLEMENTADO 2026-07-19 (Slices 1–5 em `main`).** Realizado vs
plano: dataset final = **1.873 entradas** (geração SR Legacy + brand filter
Title-case + segment-stripping de descritores de prep/grade; overrides curados
com 2 adds de levedura + 2 patches de mustard-greens); Slices 1+2 = commits
separados (dataset+módulo / script); a migração 0042 (`suggested_fdc_id`) saiu
ANTES do Slice 3 (a action de create grava o hint); Slice 5 = botão "Use
suggested USDA" no tab Nutrition (manager-only, reutiliza
`saveIngredientNutritionAction` que re-fetcha server-side). Ainda por aplicar
em PROD: migração 0042. Gate: 1854 pass / 35 skip + build OK.
Aprovação: owner 2026-07-19. Decisões: D1 = geração
USDA + curadoria (~1.500–2.500); D2 = EN-only (sem PT no v1); D3 = sim
(coluna `suggested_fdc_id`, migração 0042); D4 = bloquear `DUPLICATE_NAME`;
D5 = sem audit (paridade com criação manual).
Origem: handoff `docs/recipes-v2-fase7-handoff.md` §3b (feature própria, fora da
Fase 7). Requisitos fixados pelo owner: cria o INGREDIENTE (não é a busca USDA de
nutrição, que continua separada no tab Nutrition); `priceCents = 0` +
`needsPricing = true` SEMPRE; bónus fdcId USDA sugerido; nomes pesquisáveis
EN (+PT); decidir fonte/tamanho/atualização/impacto.

## 0. O que JÁ existe (não refazer)

- `ingredients` (schema.ts:137): `name`, `dimension: weight|volume|count`,
  `priceCents` default 0, `needsPricing` (comentário do schema já prevê
  "created without a real price"), RLS + org scoping.
- `ingredient_allergens` (schema.ts:1168): slug ∈ 14 EU FIC
  (`lib/allergens/catalog.ts`), `presence`, CHECKs no DB, provenance
  reviewed_at/by (Sprint 9) — "não revisto" = provenance vazia.
- `createIngredient` em `lib/data/ingredients.ts` + action existente com Zod.
- Busca USDA de NUTRIÇÃO (Fase 6) — separada; este catálogo apenas pode
  sugerir um `fdcId` para ela.

## 1. Decisão central — fonte dos dados

**Escolha proposta: dataset estático versionado no repo, servido por Server
Action (opção A).**

| Opção | Prós | Contras |
|---|---|---|
| **A. Dataset estático no repo** (JSON gerado + curado, carregado server-side em memória) | Zero migração; zero I/O de DB; determinístico e testável; atualiza-se por PR normal com diff revisável; não colide com o modelo multi-tenant (não é business data, logo não precisa de `organization_id`/RLS — como `ALLERGEN_CATALOG` e `CATEGORY_SEED`, que já são "pure data" no repo) | Atualização exige deploy; dataset vive no bundle do servidor (~300–500 KB, irrelevante em lambda) |
| B. Tabela seed no DB | Atualizável sem deploy | Viola/complica a Rule 1: seria a 2.ª tabela sem org (a única exceção documentada é `rate_limits`, INFRA); precisa de migração + pipeline de seed + RLS exception; sem benefício real porque os dados mudam raramente |
| C. API externa (USDA live) | Sempre fresca | Dependência online no onboarding, latência, rate limits externos, sem alergénios EU FIC (teria de ser curado à mesma), key obrigatória — e o requisito é criar ingrediente, não nutrição |

Justificação: os dados são globais, read-only, raramente mudam e precisam de
curadoria humana (alergénios EU). Isso é exatamente o perfil dos catálogos
"pure data" já existentes no repo. B só faria sentido se o catálogo fosse
editável em runtime — não é o caso.

**Impacto no bundle do CLIENTE: zero.** O dataset nunca é enviado ao browser;
a pesquisa corre numa Server Action (debounced) sobre um índice em memória do
módulo (carregado 1× por instância de lambda). Impacto no DB: zero tabelas
novas (exceto D3 abaixo, opcional).

## 2. Conteúdo e tamanho do dataset

- **Tamanho alvo: ~1.500–2.500 entradas** (fase 1 pode arrancar com ~800–1.000
  curadas). "Milhares" de qualidade > 10.000 com lixo: USDA SR Legacy tem
  ~7.800 foods mas cheios de variantes ("Beef, chuck, arm pot roast, separable
  lean only, trimmed to 1/8" fat, braised") que são ruído para onboarding.
- **Geração**: script one-off `scripts/generate-ingredient-catalog.ts` (não
  corre em CI) que parte do USDA FDC Foundation + SR Legacy (CC0), filtra
  por categorias culinárias, normaliza nomes, e produz o JSON base; a camada
  de **alergénios EU FIC e nomes PT é curada à mão** por cima (ficheiro de
  overrides commitado). O JSON final é commitado e validado por Zod num teste.
- **Cada entrada**: `{ id (slug estável), nameEn, aliases[] (EN),
  dimension, allergens: [{slug, presence}], suggestedFdcId?, category }`.
  (D2: EN-only no v1 — `namePt`/aliases PT ficam para um PR de dados futuro;
  o schema já aceita `namePt?` opcional para esse dia.)
- **Atualização**: PR normal (re-correr o script + rever diff). Append-mostly;
  ids estáveis nunca reutilizados.

## 3. Comportamento ao criar (regras duras)

1. Criação = `createIngredient` normal com `priceCents: 0`,
   `needsPricing: true` — SEMPRE, mesmo que o futuro dataset tenha preços
   (nunca terá). Regra CLAUDE.md de custo honesto.
2. Alergénios típicos inseridos em `ingredient_allergens` com o `presence`
   do catálogo e **provenance de revisão vazia** (reviewed_at/by = null) →
   a UI já os mostra como não-revistos. Nunca escreve "allergen-free".
3. `dimension` vem do catálogo; o user pode mudá-la no picker antes de criar.
4. Duplicados: ver D4.
5. `suggestedFdcId` (se D3 aprovado): guardado no ingrediente; o tab Nutrition
   mostra "perfil USDA sugerido — importar" que reutiliza o fluxo Fase 6
   (re-fetch server-side, manager-only, opt-in). Nutrição continua opt-in.
6. Audit: `ingredient.createFromCatalog` (id do ingrediente + catalogId, sem
   conteúdo) — alinhar com a política de audit existente para criação de
   ingredientes (hoje a criação simples não audita; propor auditar só o extra
   "fromCatalog" se o owner quiser, senão nenhum).

## 4. Multi-idioma (como se resolve com o next-intl atual)

Dois planos distintos:

- **UI copy** (labels do picker, botões, empty states): next-intl normal,
  `ingredients.catalog.*` em `en.json` (hoje só existe `en.json`; quando um
  `pt.json` nascer, traduz-se aí como o resto da app).
- **Nomes pesquisáveis**: NÃO são UI copy — são dados. next-intl não serve
  para milhares de entradas. O próprio dataset carrega `nameEn` + `namePt` +
  `aliases` e a pesquisa normaliza (lowercase + strip de diacríticos:
  "acucar" → "Açúcar") e procura em TODAS as línguas simultaneamente — sem
  toggle de idioma. O nome gravado no ingrediente é o que o user vê/escolhe
  no picker (pode editar antes de criar); default = nome no locale ativo,
  fallback EN.

## 5. RBAC, rate limit, entitlements

- Role: igual à criação manual de ingredientes hoje (operacional). O picker
  não expõe nada financeiro.
- Server Action de pesquisa: Zod no termo (min 2 chars, max length), rate
  limit `rateLimitKey('ingredientCatalogSearch', orgId:userId)` antes de org
  work (é barata, mas mantém o padrão), máx. ~20 resultados por resposta.
- Se existir/aparecer um `assertPlanLimit` para nº de ingredientes, a criação
  via catálogo passa pelo MESMO limite (é só outro caminho para
  `createIngredient`).

## 6. Slices (1 commit cada; gate `lint+typecheck+test` antes de cada commit)

### Slice 1 — dataset + módulo puro `lib/ingredient-catalog/`
- `catalog.schema.ts` (Zod + tipos), `search.ts` (normalização de diacríticos,
  índice, ranking prefixo>substring, empates por nome), dataset JSON inicial
  (~800–1.000 entradas geradas+curadas) + ficheiro de overrides.
- Testes: Zod valida o dataset inteiro (slugs de alergénios ∈ catálogo,
  dimensões válidas, ids únicos), pesquisa com/sem acentos, PT e EN, ranking,
  termo vazio/curto.

### Slice 2 — script de geração `scripts/generate-ingredient-catalog.ts`
- Documentado, offline (lê dumps FDC descarregados à mão), merge com
  overrides curados; nunca corre em build/CI. Runbook no próprio ficheiro.
- (Pode fundir-se com o Slice 1 se o owner preferir começar por uma lista
  100% curada e adiar a geração automática.)

### Slice 3 — Server Actions
- `searchIngredientCatalogAction` (Zod, rate limit, sem DB) e
  `createIngredientFromCatalogAction`: dentro de `withOrg`, cria ingrediente
  (preço 0 / needsPricing true / dimension) + linhas de alergénios
  não-revistas + `suggestedFdcId` (se D3), tratamento de duplicado (D4),
  error codes estáveis.
- Testes: RLS (insert cross-org), RBAC, duplicado, alergénios inseridos
  com provenance vazia, needsPricing sempre true mesmo com input adverso.

### Slice 4 — UI do picker
- Na flow de "Add ingredient": command-palette/dialog com pesquisa debounced
  (server action), resultados com nome + dimensão + chips de alergénios
  "typical, unreviewed", botão 1-clique "Add"; fallback visível "Create
  '<termo>' manually" para não bloquear nomes fora do catálogo; badge
  needsPricing pós-criação (já existe).
- i18n `ingredients.catalog.*` em `en.json`; `router.refresh()` pós-create.

### Slice 5 — (só se D3 = sim) coluna `suggested_fdc_id` + hint no Nutrition tab
- Migração 0042 (nullable, sem backfill); tab Nutrition mostra o atalho
  "Import suggested USDA profile" que abre o fluxo Fase 6 pré-preenchido.

### Slice 6 — docs + handoff
- Atualizar este plano com o realizado; nota no handoff da Fase 7.

## 7. Decisões em aberto (preciso do owner antes de começar)

- **D1 — Fonte/arranque do dataset**: (a) arrancar já com geração
  USDA→curadoria (~1.500–2.500) ou (b) v1 só lista curada à mão (~800) e
  geração automática depois? Proposta: (a), com corte de qualidade agressivo.
- **D2 — PT no v1**: incluir `namePt`/aliases PT já no dataset inicial
  (esforço de curadoria maior) ou lançar EN-only e acrescentar PT num PR de
  dados? Proposta: PT já no v1 pelo menos para os ~300 mais comuns.
- **D3 — `suggested_fdc_id`**: nova coluna nullable em `ingredients`
  (migração 0042) para o atalho de nutrição a 1 clique? Sem ela, o bónus cai
  (o fdcId não sobrevive à criação). Proposta: sim.
- **D4 — Duplicados**: ao criar do catálogo um nome que já existe ativo na
  org: (a) bloquear com erro `DUPLICATE_NAME` + link para o existente
  (proposta), ou (b) permitir duplicado como a criação manual permite hoje?
- **D5 — Audit**: auditar `ingredient.createFromCatalog`? A criação manual
  hoje não audita (não é high-risk). Proposta: não auditar, manter paridade.

## 8. Invariantes

- Preço NUNCA vem do catálogo; needsPricing true sempre.
- Alergénios seed = não-revistos; nunca "allergen-free".
- Dataset é data, não código de UI: Zod-validado em teste, ids estáveis.
- Nada do dataset no bundle do cliente; pesquisa server-side com rate limit.
- Commits pequenos por slice; build antes de push.
