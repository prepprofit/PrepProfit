# Recipes 2.0 — Plano sênior de implementação

Status: especificação para desenvolvimento, 17 de julho de 2026. Nenhuma alteração
funcional foi implementada por este documento.

Objetivo: reconstruir a experiência de receitas do PrepProfit com a estrutura e as
interações mostradas nos 18 screenshots de referência da Meez, preservando a marca,
as regras financeiras e a arquitetura multi-tenant do PrepProfit.

## 1. Veredito sênior

Esta não é uma simples troca de layout. Os screenshots descrevem seis capacidades
interligadas:

1. biblioteca de receitas e recipe books;
2. workspace de receita em duas colunas, com modos de leitura e edição;
3. escalonamento de lote e de ingredientes;
4. método de preparo estruturado, com fotos/vídeos e slideshow;
5. custo detalhado, conversões de unidade e calculadora de food cost;
6. nutrição, alergênicos e geração de rótulo.

Implementar tudo dentro do atual `recipe-editor.tsx` criaria um componente
incontrolável e aumentaria o risco de regressão em custos, estoque e permissões. A
implementação deve ser feita por fatias verticais, protegida por feature flag e com
migração aditiva. O editor atual permanece como fallback até a nova experiência
passar pelos testes de paridade e pelos testes financeiros.

Estimativa realista para o escopo completo: **45–65 dias de engenharia**, mais
validação de produto/QA. Um senior trabalhando sozinho deve planejar 9–13 semanas.
Com dois engenheiros e QA, 6–8 semanas é plausível, respeitando as dependências entre
unidades, custo e nutrição.

## 2. O que significa “exatamente como os screenshots”

### Copiar como contrato de produto

- workspace desktop dividido aproximadamente 50/50;
- resumo e ingredientes à esquerda;
- painel contextual com abas à direita;
- abas `Prep Method`, `Cost`, `Nutrition` e `UoM Equivalency`;
- modo leitura e modo edição claramente separados;
- escala de lote instantânea, sem alterar a receita-base;
- ingredientes e sub-receitas na mesma sequência visual, com cabeçalhos e notas;
- método dividido em seções e passos ordenáveis;
- foto ou vídeo associado ao passo;
- slideshow operacional para execução na cozinha;
- custo expansível por ingrediente/sub-receita;
- calculadora de food cost por tamanho de porção;
- nutrição atualizada a partir dos ingredientes e rótulo imprimível;
- alergênicos `Contains` e `May contain` com edição explícita;
- busca e filtros na biblioteca, inclusive por alergênico;
- recipe books com associação de uma receita a vários livros.

### Não copiar

- marca, logotipo, cores ou textos proprietários da Meez;
- pop-ups numerados de onboarding presentes nos screenshots;
- seletor de owners/concepts da Meez, porque o PrepProfit usa uma organização Clerk
  ativa como boundary do tenant;
- central de notificações, botão global `New`, Docs e Purchase Items da Meez;
- qualquer afirmação de conformidade legal nutricional sem revisão jurídica;
- fotografia decorativa. No PrepProfit, mídia deve ser operacional: capa da receita
  ou evidência visual de um passo.

O visual deve usar tokens e componentes do `DESIGN.md`. A paridade desejada é de
hierarquia, densidade, comportamento e fluxo — não um clone de marca.

## 3. Estado atual verificado no PrepProfit

### Pode ser reaproveitado

- Next.js App Router, Server Components, Server Actions, Drizzle e PostgreSQL;
- RLS por `organization_id`, `withOrg(...)` e FKs compostas entre tenant e entidade;
- papéis `manager` e `kitchen`;
- separação server-side de dados financeiros para usuários de cozinha;
- receitas, ingredientes, linhas, sub-receitas e prevenção de ciclos;
- quantidades canônicas em g/ml/count;
- conversões métricas/imperiais já testadas;
- rendimento em porções, perda percentual e peso final do lote;
- custo direto, custos indiretos, custo por porção, margem e preço sugerido;
- custo recursivo de sub-receitas;
- presets de peso final;
- folders, soft delete e trash;
- alergênicos derivados, overrides e matriz PDF/XLSX;
- receita/prep card em PDF;
- importação de receita por foto com imagem efêmera;
- histórico de preço e fornecedores de ingredientes.

### Lacunas reais

- o editor atual tem cerca de 1.500 linhas e mistura UI, estado e cálculos;
- não existe modo leitura equivalente ao screenshot;
- não existem seções de ingredientes nem notas por linha;
- ingrediente e sub-receita são coleções separadas e não possuem uma ordem visual
  compartilhada;
- a restrição atual impede repetir o mesmo ingrediente na mesma receita;
- `notes` é um único texto, não um método estruturado;
- não existe armazenamento permanente de mídia de receita;
- não existe slideshow;
- folders são exclusivos; recipe books precisam ser muitos-para-muitos;
- o yield principal não representa naturalmente `3 qt`, `12 oz` ou `1 serving`;
- não existem equivalências entre peso, volume e unidade;
- não existem prep actions com rendimento próprio;
- não existe perfil nutricional de ingrediente nem integração USDA;
- não existe cálculo nutricional recursivo;
- não existe rótulo nutricional;
- custo detalhado ainda não expõe compra/fornecedor por linha no workspace;
- não existe porção de venda configurável para a calculadora de food cost.

## 4. Decisões de produto fechadas para o desenvolvimento

1. A receita salva é sempre a receita-base (`batch factor = 1x`). Escalas vistas na
   tela são derivadas e nunca sobrescrevem silenciosamente a base.
2. `Edit` abre um draft local; `Done` persiste o workspace em uma transação. Cancelar
   ou navegar com mudanças pendentes exige confirmação.
3. O save usa `expectedVersion`; conflitos não sobrescrevem trabalho de outro usuário.
4. Manager vê custos e preço. Kitchen não recebe campos financeiros no payload.
5. Mídia, método, rendimento, unidades e alergênicos são dados operacionais visíveis
   aos dois papéis. Exclusão de mídia e alterações em alergênicos são auditadas.
6. O PrepProfit continua usando g/ml/count como quantidades canônicas internas.
7. Conversão entre dimensões só acontece quando existir equivalência cadastrada.
   Nunca assumir que `1 ml = 1 g`.
8. Ausência de dado nutricional é `unknown`, não zero. Um rótulo incompleto deve ser
   marcado como incompleto e não pode parecer uma declaração final.
9. Alergênicos continuam independentes do perfil USDA. Ausência no USDA nunca significa
   ausência de alergênico.
10. O primeiro padrão visual de rótulo é o americano (`US FDA`). Ele deve ser chamado
    de rótulo estimado até revisão regulatória. O catálogo operacional atual de 14
    alergênicos europeus permanece intacto; a apresentação do label usa o subconjunto
    exigido pela jurisdição selecionada.
11. Recipe Books substituem o conceito visual de folders. Uma receita pode pertencer
    a zero ou vários books.
12. Os overlays de tutorial dos screenshots não fazem parte deste projeto.

## 5. Arquitetura-alvo de rotas

```text
/recipes
  Biblioteca em tabela, filtros, recipe books e criação

/recipes/[id]
  Workspace; query string mantém estado compartilhável:
  ?tab=method|cost|nutrition|uom
  ?mode=view|edit

/recipes/[id]/slideshow
  Execução de passos em tela cheia, sem dados financeiros

/recipes/[id]/nutrition-label/print
  HTML de impressão do rótulo

/api/recipes/[id]/nutrition-label/pdf
  PDF opcional, gerado no servidor

/api/recipes/[id]/media/upload-url
  Cria upload assinado para o tenant/recipe/step correto

/api/recipes/[id]/media/confirm
  Confirma objeto, valida metadados e grava vínculo
```

As abas devem ser estado de URL, não quatro páginas que repetem o loader. O Server
Component carrega um DTO único, e cada aba recebe somente o slice necessário. Para
`kitchen`, o DTO não pode conter chaves de custo, preço, fornecedor ou histórico de
compra.

## 6. Modelo de dados proposto

Todas as tabelas abaixo carregam `organization_id`, entram em `businessTables`, têm
RLS e usam FKs compostas `(organization_id, foreign_id)`. Dinheiro continua em cents.
Quantidades decimais usam `numeric`, com arredondamento apenas nos boundaries.

### 6.1 Alterações em `recipes`

Adicionar de forma aditiva:

```text
subtitle                    text nullable
version                     integer not null default 1
yield_quantity              numeric(12,4) nullable
yield_unit                  text nullable
nutrition_serving_quantity  numeric(12,4) nullable
nutrition_serving_unit      text nullable
servings_per_container      numeric(12,4) nullable
cover_media_id              text nullable
```

Regras:

- `yield_quantity + yield_unit` representam a saída como o chef descreve (`3 qt`,
  `30 lb`, `1 serving`);
- `yield_weight_grams` continua existindo como âncora física para custo/kg, presets e
  conversões quando o yield principal não for de peso;
- `yield_portions` continua durante a migração e alimenta o default de servings;
- `version` incrementa em todo save do workspace;
- `cover_media_id` aponta para mídia confirmada da mesma receita e organização.

### 6.2 Seções e linhas de ingredientes

Nova tabela `recipe_ingredient_sections`:

```text
id, organization_id, recipe_id, title, sort_order, created_at, updated_at
```

Adicionar a `recipe_ingredients`:

```text
section_id          text nullable
display_sort_order  integer not null default 0
note                text nullable
prep_action_id      text nullable
entered_quantity    numeric(12,4) nullable
entered_unit        text nullable
```

Adicionar os mesmos campos de seção/nota/ordem relevantes a `recipe_components`.

Remover a unique atual `(recipe_id, ingredient_id)`. O identificador da linha passa a
ser a identidade; repetir sal em duas seções deve ser permitido. O reorder deve operar
em uma sequência mesclada de ingredient lines, component lines e section headers e
persistir tudo em uma única transação.

`quantity` canônica continua sendo a fonte para custo e estoque. `entered_quantity`
e `entered_unit` preservam o que o chef digitou. Ao trocar unidade/prep action, o
servidor recalcula a quantidade canônica; alterações futuras na equivalência não
reescrevem receitas antigas silenciosamente.

### 6.3 Método e passos

`recipe_method_sections`:

```text
id, organization_id, recipe_id, title, sort_order, created_at, updated_at
```

`recipe_steps`:

```text
id, organization_id, recipe_id, section_id
instruction text not null
sort_order integer not null
created_at, updated_at
```

`recipe_step_media`:

```text
id, organization_id, recipe_id, step_id, media_id, sort_order
caption text nullable
```

Passos sem mídia são válidos. Uma mídia pode ser capa e também estar vinculada a um
passo, mas o objeto físico não é duplicado.

### 6.4 Mídia

`recipe_media`:

```text
id, organization_id, recipe_id
storage_key text unique
kind image|video
mime_type, byte_size, width, height, duration_ms
status pending|ready|rejected|deleted
sha256, uploaded_by, created_at, deleted_at
```

Usar um adapter `RecipeMediaStorage` sobre bucket privado S3-compatible. O browser faz
upload direto por URL assinada curta; a chave nunca vem livre do cliente e deve usar
`org/{orgId}/recipes/{recipeId}/{mediaId}`. Downloads usam URL assinada ou proxy
autorizado. Não gravar blobs no PostgreSQL.

Regras mínimas:

- imagens JPEG/PNG/WebP; validar bytes reais, dimensões e tamanho;
- vídeos MP4/WebM; validar container, tamanho e duração antes de status `ready`;
- objetos `pending` não confirmados são removidos por cron;
- exclusão é soft delete no banco e remoção assíncrona idempotente no bucket;
- nenhum upload público ou cross-tenant;
- registrar upload/delete em audit log sem registrar conteúdo da mídia.

### 6.5 Recipe Books

Criar `recipe_books` e `recipe_book_entries`:

```text
recipe_books:
  id, organization_id, name, icon, sort_order, created_at, updated_at

recipe_book_entries:
  id, organization_id, recipe_book_id, recipe_id, sort_order, created_at
  unique (organization_id, recipe_book_id, recipe_id)
```

Cada folder atual vira um recipe book e cada `recipes.folder_id` vira uma membership.
Depois do rollout, `folder_id` e `recipe_folders` entram em depreciação; não apagar na
mesma release.

### 6.6 Equivalência de unidades e prep actions

`ingredient_uom_equivalencies`:

```text
id, organization_id, ingredient_id
weight_grams numeric nullable
volume_ml numeric nullable
each_count numeric nullable
source manual|standard
updated_at, updated_by
```

Pelo menos dois anchors positivos são necessários. Exemplo: `141.75 g = 236.59 ml =
1 each`. Não guardar texto de unidade como matemática; converter primeiro para as
âncoras canônicas.

`ingredient_prep_actions`:

```text
id, organization_id, ingredient_id, name
yield_bps integer not null
weight_grams, volume_ml, each_count nullable
sort_order, created_at, updated_at
```

`yield_bps` usa basis points (`7854 = 78.54%`). Uma prep action pode sobrescrever a
equivalência base porque “onion, diced” e “onion, whole” podem ter comportamentos
distintos. O cálculo deve evitar dupla perda: a quantidade canônica da linha representa
o que a receita usa; a perda de prep serve para custo/compra requerida quando aplicável.

### 6.7 Nutrição por ingrediente

`ingredient_nutrition_profiles` (um ativo por ingrediente):

```text
id, organization_id, ingredient_id
source usda|custom
fdc_id nullable
fdc_data_type nullable
source_description nullable
brand_owner nullable
basis_grams numeric not null default 100
calories_kcal, total_fat_g, saturated_fat_g, trans_fat_g
cholesterol_mg, sodium_mg, total_carbohydrate_g, dietary_fiber_g
total_sugars_g, added_sugars_g, protein_g
vitamin_d_mcg, calcium_mg, iron_mg, potassium_mg, caffeine_mg
source_updated_at, refreshed_at, updated_by, created_at, updated_at
```

Cada nutriente é nullable. `null` significa desconhecido. Valores customizados usam o
mesmo contrato por 100 g e passam por validação de não-negatividade e limites máximos.
Ao selecionar um resultado USDA, salvar um snapshot normalizado e os metadados da
fonte. Mudanças futuras na API não alteram receitas até o usuário executar `Refresh
from source`.

A integração usa somente endpoints oficiais FoodData Central de search/detail, com a
API key exclusivamente no servidor. Aplicar cache, timeout, retry limitado e rate
limit por organização. A USDA publica os dados do FoodData Central sob CC0; mostrar a
atribuição da fonte no diálogo de seleção.

### 6.8 Porções e food cost

Criar `recipe_portion_options`:

```text
id, organization_id, recipe_id, name
quantity numeric(12,4), unit text
selling_price_cents integer nullable
target_food_cost_bps integer nullable
is_default boolean not null default false
is_nutrition_serving boolean not null default false
sort_order, created_at, updated_at
```

A opção default substitui gradualmente o atual `selling_price_cents`. No backfill,
criar uma opção `Default serving` com quantidade `1 serving` e o preço atual. Manter
dual-read até menus, dashboard e documentos usarem a nova origem.

## 7. Contratos de cálculo

Todos os cálculos abaixo ficam em módulos puros em `lib/calculations/` com testes.

### 7.1 Escala

```text
batchFactor = targetYieldCanonical / baseYieldCanonical
scaledLine = baseLineCanonical * batchFactor
```

- presets comuns: 0.5x, 1x, 2x, 3x, 4x, 6x;
- aceitar fator customizado positivo dentro do limite de domínio;
- editar a quantidade de uma linha no modo leitura recalcula o fator, não a base;
- se uma linha base for zero, ela não pode ser usada como âncora;
- toda a receita, componentes, yield, custo e nutrição refletem o mesmo fator;
- nunca escalar por arredondamentos já exibidos; sempre partir do valor canônico base.

### 7.2 Conversões UoM

Conversão dentro da mesma dimensão usa `lib/units`. Conversão entre dimensões exige
equivalência:

```text
weight -> volume = inputGrams / anchorWeightGrams * anchorVolumeMl
volume -> each   = inputMl / anchorVolumeMl * anchorEachCount
```

Retornar um resultado discriminado:

```ts
{ ok: true, canonical, unit }
| { ok: false, reason: 'MISSING_EQUIVALENCY' | 'INVALID_INPUT' }
```

Não retornar zero em erro. A UI deve explicar qual equivalência está faltando.

### 7.3 Custo

Reutilizar `recipeCost`, `lineCostCents` e `resolveRecipeCostTree`, ampliando o DTO.

- custo da linha considera quantidade canônica, preço aprovado e prep yield;
- custo de sub-receita continua recursivo e falha fechado se a árvore for incompleta;
- linha sem preço mostra `Needs pricing`; não entra como zero “grátis”;
- detalhes expansíveis mostram purchase item, custo de compra, unidade, fornecedor,
  data e origem do preço aprovado;
- `Total cost` inclui ingredientes/sub-receitas + labor + energy + packaging;
- custo da porção usa a fração da porção sobre o yield total;
- `foodCostBps = round(costCents * 10000 / sellingPriceCents)`;
- `profitCents = sellingPriceCents - costCents`;
- se o usuário alterar target food cost, sugerir preço; se alterar preço, recalcular
  food cost. Uma única direção é ativa por interação para evitar loop de formulário;
- todos os resultados monetários são inteiros em cents e cobrem overflow/NaN/Infinity.

### 7.4 Nutrição

Normalizar nutrientes de cada ingrediente por grama:

```text
nutrientForLine = nutrientPer100g * edibleWeightGrams / 100
```

Depois:

1. somar linhas diretas;
2. expandir sub-receitas proporcionalmente ao peso final utilizado;
3. dividir pelo número/fração de servings;
4. calcular `% Daily Value` somente para nutrientes com DV configurado no padrão de
   label selecionado;
5. aplicar as regras de arredondamento do padrão em uma camada separada da precisão
   interna.

Regras de completude:

- linha em volume/count sem equivalência de peso torna o cálculo incompleto;
- ingrediente sem perfil torna o cálculo incompleto;
- nutriente ausente continua ausente; não somar como zero silencioso;
- sub-receita incompleta contamina o status da receita pai;
- mostrar lista acionável de ingredientes pendentes;
- a impressão final fica desabilitada até haver serving size e todos os campos
  obrigatórios; pode existir `Print draft` com watermark `ESTIMATED / INCOMPLETE`.

### 7.5 Alergênicos

Reutilizar o rollup atual e sua proveniência.

- `contains` ganha de `may_contain`;
- recipe override só adiciona ou escala severidade de presença, nunca suprime;
- `May contain` permanece manual/advisory;
- o rótulo US mostra os nove major allergens relevantes;
- a área operacional pode continuar mostrando os 14 do catálogo atual;
- nunca exibir `allergen-free`; usar `no allergens recorded` e o disclaimer atual.

## 8. Componentização do front-end

O atual `RecipeEditor` deve ser substituído por composição. Meta: nenhum componente de
feature acima de aproximadamente 300 linhas sem justificativa.

```text
components/app/recipes/workspace/
  recipe-workspace.tsx
  recipe-workspace-header.tsx
  recipe-view-mode.tsx
  recipe-edit-mode.tsx
  batch-scale-control.tsx
  recipe-input-list.tsx
  recipe-input-row.tsx
  recipe-section-row.tsx
  recipe-workspace-tabs.tsx
  prep-method-panel.tsx
  prep-step-editor.tsx
  prep-step-media.tsx
  cost-panel.tsx
  cost-tree-row.tsx
  food-cost-calculator.tsx
  nutrition-panel.tsx
  nutrition-completeness.tsx
  nutrition-label.tsx
  uom-equivalency-panel.tsx
  recipe-slideshow.tsx

components/app/recipes/library/
  recipe-library.tsx
  recipe-library-filters.tsx
  recipe-library-table.tsx
  recipe-books-panel.tsx
```

Estado:

- Server Component carrega `RecipeWorkspaceDTO`;
- `useReducer` ou store local pequeno controla draft e dirty state;
- cálculos derivados são memoizados e recebem objetos simples;
- mutations retornam DTO/version atualizados;
- não duplicar custo/nutrição em estados independentes;
- tabs e mode ficam na URL; draft não fica na URL;
- drag-and-drop deve ter alternativa por teclado (`Move up/down`).

## 9. Contrato de UI por tela

### 9.1 Biblioteca `/recipes`

- header com busca ampla e botão de criar;
- pills `Recipes` e `Recipe Books`; outros módulos globais não entram nesta entrega;
- botão `Filter` abre painel com books, alergênicos e status nutricional/custo;
- tabela desktop: seleção, tipo, nome, books, updated at e menu;
- cards compactos no mobile;
- bulk action: adicionar/remover de book e mover para trash;
- lista server-side paginada; busca e filtros na query string;
- filtro de alergênico deve ser SQL/data-layer, sem carregar todos os rollups no client;
- recipe book mostra contagem e aceita muitas memberships.

### 9.2 Workspace — modo leitura

Esquerda:

- nome, subtitle/category, batch size, yield e indicador de balança/peso final;
- ingredientes/sub-receitas agrupados por seção;
- quantidade clicável para escolher uma escala por ingrediente;
- notas e prep action em texto secundário;
- nenhuma borda de formulário.

Direita:

- busca global do app permanece no shell, fora do componente;
- abas sticky;
- capa em proporção consistente;
- abaixo da capa, seções e passos;
- botão `Prep step slideshow`;
- método, custo, nutrição e UoM não desmontam o workspace inteiro ao trocar aba.

### 9.3 Workspace — modo edição

- `Edit` troca para `Done`; `Done` salva atomicamente;
- cabeçalho, yield, seções, linhas e passos ficam editáveis;
- adicionar ingredient, sub-recipe, header e note;
- reorder com pointer e teclado;
- upload/remoção de mídia por passo;
- erros aparecem junto ao campo e em summary no topo;
- salvar bloqueado se existir conflito, upload pendente ou linha inválida;
- excluir receita continua soft delete com confirmação.

### 9.4 Slideshow

- modal/rota full-screen com uma etapa por vez;
- imagem ou vídeo grande, texto e `n de total`;
- próximo/anterior por botão, setas, swipe e teclado;
- respeitar `prefers-reduced-motion`;
- esconder toda informação financeira;
- manter tela acordada quando a API estiver disponível, com opt-in;
- fallback textual para passo sem mídia.

### 9.5 Cost

- manager-only no server e no client;
- lista expansível com Expand all/Collapse all;
- sub-receita expande sua árvore até o limite atual;
- custos incompletos mostram motivo, não total parcial enganoso;
- resumo: total yield, total cost e cost por unidade de yield;
- calculadora de porção mostra portion size, cost, sell price, food cost % e profit;
- edição de preço/custo dispara audit event.

### 9.6 Nutrition

- status de completude no topo;
- tabela de ingredientes com source match, edible %, peso nutricional e ação de editar;
- modal `Update Ingredient Nutrition` com busca Common/Branded no USDA e opção custom;
- allergens e may contain separados;
- preview do rótulo atualiza após save/match;
- botão print com estado disabled/draft/final;
- atribuição USDA discreta, mas visível.

### 9.7 UoM Equivalency

- mostrar equivalência peso = volume = each;
- busca de equivalência existente é apenas sugestão; usuário confirma antes de salvar;
- toggle `standard` bloqueia edição manual enquanto ativo;
- prep actions exibem yield %, equivalências e ações edit/delete;
- recipe line sem equivalência mostra CTA direto para o ingrediente correspondente.

## 10. Server Actions e data layer

Criar uma facade de workspace em vez de chamar dezenas de actions independentes:

```ts
getRecipeWorkspace(tx, orgId, recipeId, role)
saveRecipeWorkspace(tx, orgId, recipeId, expectedVersion, draft, actor)
```

O save:

1. valida o payload Zod por role;
2. trava a receita `FOR UPDATE`;
3. compara `expectedVersion`;
4. valida ingredientes ativos, sub-receitas, cycles e media ownership;
5. aplica header, seções, linhas, componentes e método;
6. incrementa version;
7. grava um audit event resumido;
8. retorna o DTO atualizado;
9. revalida recipe, ancestors, dashboard, menus, productions e tasks já cobertos hoje.

Actions específicas continuam apropriadas para:

- upload/confirm/delete de mídia;
- busca/refresh USDA;
- edição de perfil nutricional de ingrediente;
- mudanças de preço financeiro;
- recipe books e filtros;
- soft delete/restore/purge.

Evitar payload gigante sem limite. Definir máximos: seções, linhas, passos, caracteres e
mídias por receita; validar tamanho antes de abrir transação.

## 11. Migração e compatibilidade

### Release A — fundação aditiva

- criar tabelas/colunas/índices/RLS;
- adicionar `version = 1` às receitas;
- não alterar o editor ativo;
- backfill de yield e books em job idempotente;
- testar rollback lógico.

### Backfills

- cada folder atual vira um recipe book;
- cada `folder_id` vira uma entry;
- `yield_quantity = yield_portions`, `yield_unit = serving` quando não houver descrição
  mais específica;
- `notes` permanece e também aparece como bloco legado no método até o usuário editar;
- cada receita atual recebe uma seção de ingredientes default apenas na leitura; criar
  linha física somente quando necessário;
- `selling_price_cents` vira a portion option default;
- alergênicos, custos, presets e componentes permanecem como estão;
- nutrição/mídia começam vazias, nunca inventadas.

### Release B — dual read

- feature flag `recipes_workspace_v2` por organização;
- loader novo prefere estruturas v2 e adapta dados legados;
- editor antigo continua disponível para rollback;
- telemetria compara erros e latência, nunca valores financeiros brutos.

### Release C — dual write controlado

- novos saves escrevem estruturas v2 e campos legados necessários para consumidores
  ainda não migrados;
- atualizar menus, production explosion, documentos, kitchen scale, imports, search,
  trash e dashboard para os novos contratos;
- provar que custo/estoque antes e depois são equivalentes em fixtures congeladas.

### Release D — default on

- ativar por cohort;
- monitorar conflict rate, upload failures, incomplete cost/nutrition e save latency;
- remover flag só após pelo menos uma release estável;
- remoção das tabelas/colunas legadas fica para migration separada e reversível.

## 12. RBAC, segurança e auditoria

- `kitchen` nunca recebe `priceCents`, supplier, purchase cost, selling price, margin,
  cost tree ou nutrition source API key;
- todas as buscas USDA passam pelo servidor; `FDC_API_KEY` nunca vai ao client;
- URLs de mídia são curtas, assinadas e vinculadas ao tenant;
- validar magic bytes, dimensões, tamanho e tipo; não confiar em extensão/MIME do browser;
- rate limit por organização para upload, confirm e USDA search;
- CSP deve permitir apenas o host de mídia configurado;
- texto de passos/captions é renderizado como texto, sem HTML arbitrário;
- filenames nunca formam storage keys;
- auditoria obrigatória: save estrutural, alergênicos, nutrição customizada, refresh USDA,
  mídia delete, equivalências, prep yields e qualquer preço;
- purge de receita precisa limpar dependências e enfileirar remoção de mídia;
- testes RLS cobrem SELECT/INSERT/UPDATE/DELETE e retag cross-org de toda tabela nova.

## 13. Performance

Metas iniciais em dados realistas:

- biblioteca: primeira resposta p95 < 800 ms para 5.000 receitas/tenant;
- workspace sem URLs de mídia: p95 < 900 ms;
- troca de aba local < 100 ms;
- escala/recalculo client-side < 50 ms para 200 linhas;
- save de workspace p95 < 1,5 s sem upload;
- slideshow pré-carrega apenas mídia atual + próxima;
- USDA search debounced, cancelável e cacheada;
- cost/nutrition trees usam batch loaders, nunca N+1;
- profundidade recursiva continua limitada e protegida contra ciclo.

Não incluir binários ou base64 no DTO do workspace. Entregar thumbnails responsivos e
lazy load. A tabela de biblioteca usa paginação por cursor ou page server-side.

## 14. Acessibilidade e responsividade

- desktop >= 1280 px: split pane;
- 768–1279 px: colunas redimensionadas, painel direito com largura mínima útil;
- mobile < 768 px: summary/inputs e tabs em fluxo vertical; sem split horizontal;
- tabs seguem ARIA Tabs;
- drag-and-drop tem botões move up/down;
- inputs têm labels, erros ligados por `aria-describedby` e focus no primeiro erro;
- slideshow funciona sem mouse;
- caption/alt text obrigatório para mídia informativa;
- contraste AA com temas light/dark;
- zoom 200% sem perda de ação;
- respeitar reduced motion.

## 15. Estratégia de testes

### Unitários

- escala por factor/yield/ingrediente;
- conversão intra e interdimensão;
- prep yield sem dupla aplicação;
- custo por linha, lote, yield unit e porção;
- food cost %, profit e preço sugerido;
- nutrição direta, volume/count, sub-receita e serving;
- propagação de missing nutrient;
- arredondamento do label separado da precisão interna;
- allergen rollup e subset por jurisdição;
- media validators e storage key builder.

### Data/PGlite

- migration/backfill idempotente;
- recipe books many-to-many;
- linhas duplicadas do mesmo ingrediente;
- reorder mesclado e atomicidade;
- save com version correta e conflito;
- cycle/depth de sub-receita;
- cascade/restrict/soft delete/purge;
- perfil nutricional e equivalência cross-org recusados;
- RLS completa para tabelas novas.

### Postgres real

- dois saves concorrentes do workspace;
- reorder concorrente;
- save enquanto preço/equivalência muda;
- confirm/delete de mídia concorrente;
- criação de membership duplicada;
- locks de árvore de sub-receita.

### RBAC

- kitchen DTO não contém chaves financeiras;
- actions financeiras retornam `FORBIDDEN` antes do DB;
- slideshow e método funcionam para kitchen;
- nutrition/allergen operacional segue a política definida;
- media URL de outro tenant retorna 404/forbidden sem leak.

### E2E/Playwright

- criar receita, editar, adicionar seções/linhas/sub-receita e salvar;
- dirty-navigation guard;
- escalar 1x -> 6x e por ingrediente sem persistir;
- upload de imagem, slideshow e exclusão;
- cost expand/collapse e calculadora;
- mapear ingrediente USDA, custom nutrition e incomplete state;
- imprimir label draft/final;
- recipe books e filtro por alergênico;
- manager vs kitchen;
- mobile e teclado.

### Regressão visual

Snapshots em 1440x900, 1024x768 e 390x844 para:

- library;
- view/method;
- edit/method;
- cost expanded;
- nutrition + label;
- UoM;
- slideshow;
- empty/loading/error states.

## 16. Fases executáveis

### Fase 0 — contratos e baseline (2–3 dias)

- congelar fixtures de custo/escala/estoque de receitas existentes;
- aprovar wireframe PrepProfit baseado nos screenshots;
- definir limites de mídia e padrão de label;
- criar feature flag e métricas;
- documentar DTOs e invariantes.

Saída: contrato aprovado; nenhuma mudança visível.

### Fase 1 — schema, books e versionamento (4–6 dias)

- migrations/RLS/FKs/índices;
- backfills idempotentes;
- data layer de books;
- version/optimistic concurrency;
- testes de tenancy e migration.

Saída: fundação pronta, editor antigo intacto.

### Fase 2 — workspace, leitura/edição e escala (6–9 dias)

- DTO e facade;
- split layout, tabs e mode;
- lista mesclada com seções/notas;
- save atômico;
- escala por lote/yield/ingrediente;
- responsividade e visual regression base.

Saída: experiência principal utilizável sem mídia/nutrição.

### Fase 3 — método, mídia e slideshow (7–10 dias)

- seções/passos/reorder;
- adapter de storage e upload seguro;
- capa e mídia de passo;
- slideshow;
- cleanup, audit e testes.

Saída: receita visual operacional.

### Fase 4 — UoM e prep actions (5–7 dias)

- modelo e UI de equivalências;
- conversões puras;
- prep actions/yield;
- integração em recipe lines, custo e import;
- missing-equivalency states.

Saída: base física confiável para cost/nutrition.

### Fase 5 — cost parity (4–6 dias)

- painel expansível e supplier details;
- resumo por yield unit;
- portion options e food cost calculator;
- RBAC/audit;
- regressão financeira.

Saída: custo equivalente aos screenshots sem vazar dinheiro.

### Fase 6 — nutrição e label (8–12 dias)

- integração USDA server-side;
- snapshot/custom profile;
- cálculo recursivo e completeness;
- allergen presentation;
- label preview/print/PDF;
- revisão regulatória do texto e do layout.

Saída: nutrição estimada e label imprimível com proveniência.

### Fase 7 — library parity e rollout (5–8 dias)

- tabela/filtros/bulk actions/books;
- filtro por alergênico e status;
- atualização de consumidores legados;
- cohort rollout, observabilidade e remoção do fallback quando seguro.

Saída: Recipes 2.0 como experiência padrão.

## 17. Matriz de rastreabilidade dos screenshots

Esta matriz deve virar a checklist de visual QA. “Equivalente” significa o estado da
feature no PrepProfit, sem o pop-up de onboarding sobreposto.

| Referência | Estado equivalente obrigatório |
|---|---|
| `Recipes/1.png` | biblioteca em tabela, contexto da organização ativa e recipes associáveis a vários books/locais; não criar o owner switcher da Meez |
| `Recipes/2.png` | aba/lista de Recipe Books com contagem de receitas e many-to-many |
| `Recipes/3.png` | modo edição em split view, ingredients à esquerda e passos com mídia à direita |
| `Recipes/4.png` | modo leitura, batch/yield, capa, tabs e CTA de slideshow |
| `Recipes/5.png` | slideshow full-screen com mídia, instrução, paginação e close |
| `Recipes/6.png` | escala de lote recalculando yield e todas as quantidades |
| `Recipes/7.png` | escala iniciada pela edição de uma quantidade de ingrediente no modo leitura |
| `Recipes cost/1.png` | linha enriquecida com ingredient/prep information e dependência de dados de unidade |
| `Recipes cost/2.png` | detalhe de ingrediente com prep actions, yield e UoM equivalency |
| `Recipes cost/3.png` | aba Cost com árvore expansível e custo por linha |
| `Recipes cost/4.png` | linha de custo expandida com purchase item, supplier, purchase unit/date e edição autorizada |
| `Recipes cost/5.png` | total yield, total cost, cost por unidade e food cost calculator |
| `Nutrition and label/1.png` | preview de Nutrition Facts e print label |
| `Nutrition and label/2.png` | recálculo nutricional após adicionar/trocar ingrediente |
| `Nutrition and label/3.png` | allergens e may contain separados no rollup da receita |
| `Nutrition and label/4.png` | edição manual de allergens/may contain no ingrediente |
| `Nutrition and label/5.png` | busca USDA com Common/Branded e custom nutrition fallback |
| `Nutrition and label/6.png` | filtro de biblioteca por alergênico com contagem e busca |

Cada linha só pode ser marcada como concluída depois de ter: screenshot Playwright no
breakpoint aplicável, teste do comportamento e aprovação visual de produto.

## 18. Definition of Done

A entrega só está concluída quando:

- todos os 18 screenshots possuem um estado equivalente documentado no PrepProfit;
- manager e kitchen foram testados com inspeção de payload, não apenas ocultação CSS;
- custo, escala, produção e estoque mantêm os fixtures de regressão;
- receita com sub-receita atualiza custo, nutrição e alergênicos do pai corretamente;
- linhas sem preço/nutrição/equivalência mostram estado incompleto honesto;
- save concorrente nunca perde alteração silenciosamente;
- uploads são privados, validados e limpos;
- label tem serving size, fonte, completeness e disclaimer corretos;
- RLS de todas as novas tabelas passou em leitura e escrita;
- lint, typecheck, testes, build e Playwright passam;
- visual regression foi aprovada nos três breakpoints;
- migration/backfill foi ensaiado em cópia de produção e possui rollback operacional;
- documentação, env vars, runbook de storage/USDA e custos operacionais foram atualizados.

## 19. Riscos que não podem ser ignorados

1. **Rótulo legal:** uma aparência parecida com Nutrition Facts não garante
   conformidade. A FDA informa que imagens educacionais não bastam para cumprir 21 CFR
   101.9. Tratar como estimativa até revisão especializada.
2. **Dados incompletos:** USDA e branded foods podem omitir nutrientes. Nunca converter
   ausência em zero.
3. **Unidades:** volume/count sem densidade ou peso por peça não permite nutrição por
   peso. Bloquear/explicar.
4. **Cascata:** alterar sub-receita afeta pais, menus, produção, tarefas, alergênicos,
   custo e nutrição. Revalidation precisa ser centralizada.
5. **Mídia:** storage, egress e vídeo têm custo operacional. Instrumentar bytes, falhas
   e objetos órfãos.
6. **Big bang:** substituir editor, schema e cálculos em uma release não é aceitável.
7. **Performance:** resolver árvores linha a linha gera N+1. Usar batch loaders.
8. **Propriedade intelectual:** reproduzir fluxo é válido como referência de produto;
   não copiar assets, textos, imagens ou identidade da Meez.

## 20. Referências oficiais para a fase nutricional

- [USDA FoodData Central API Guide](https://fdc.nal.usda.gov/api-guide/)
- [FDA — Changes to the Nutrition Facts Label](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/changes-nutrition-facts-label)
- [FDA — Food allergies and the nine major allergens](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies)
- [FDA — Nutrition Facts label images are educational, not compliance artifacts](https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/nutrition-facts-label-images-download)

## 21. Ordem recomendada para o dev começar

O primeiro pull request não deve mexer no layout. Deve entregar somente:

1. feature flag;
2. schema aditivo + RLS + migrations;
3. backfill idempotente de version/yield/books;
4. DTO `RecipeWorkspaceDTO` com payload distinto para manager/kitchen;
5. fixtures de regressão de custo/escala/estoque;
6. testes de migration, tenancy e optimistic concurrency.

Somente depois disso deve começar o novo workspace. Essa ordem preserva o produto
atual e cria um ponto seguro de rollback durante toda a reconstrução.
