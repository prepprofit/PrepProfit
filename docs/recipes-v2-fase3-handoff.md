# Recipes 2.0 — Handoff para a Fase 3 (método, mídia e slideshow)

Estado em 2026-07-17, fim da sessão que implementou as Fases 0–2. Leia isto
junto com o plano mestre: `docs/recipes-meez-parity-senior-plan.md` (§6.3, §6.4,
§9.4 e Fase 3 em §16 são as secções relevantes agora).

## 1. O que já está feito e EM PRODUÇÃO

- **Migração 0041 aplicada ao Neon** (schema aditivo + RLS). Todas as tabelas da
  Fase 3 JÁ EXISTEM no banco: `recipe_method_sections`, `recipe_steps`,
  `recipe_step_media`, `recipe_media` (e também books, portion options, uom,
  prep actions, nutrition profiles).
- **Backfill corrido em produção**: 12 books, 125 memberships, 143 receitas com
  yield e portion option default. Idempotente (`npm run backfill:recipes-v2`).
  ATENÇÃO: o driver via Clerk só enumerou 1 das orgs — se voltar a precisar de
  backfill global, itere as orgs distintas da própria DB (ver §5 abaixo).
- **Flag `organization_settings.recipes_workspace_v2` LIGADA nas 5 orgs.** O
  workspace v2 é a experiência default; `?editor=legacy` é o rollback.
- **Facade**: `lib/data/recipe-workspace.ts` — `getRecipeWorkspace` (DTO por
  role; kitchen sem NENHUMA chave financeira, testado por deep key-scan) e
  `saveRecipeWorkspace` (FOR UPDATE + `expectedVersion` + full-replace de
  secções/linhas + audit `recipe.workspaceSave`). O DTO já devolve
  `methodSections`, `steps` (com `media: []`) e `media` — a Fase 3 só precisa
  de os popular.
- **UI**: `components/app/recipes/workspace/` — split view, `?tab=`/`?mode=` na
  URL, lista mesclada com secções/notas, escala derivada client-side, cost
  manager-only. A tab **Prep Method** já renderiza secções/passos estruturados
  (read-only) + notas legadas; nutrition/uom são placeholders.
- Testes: 1657 verdes; fixtures congeladas de custo/escala em
  `tests/recipes-v2-regression-fixtures.test.ts` (release blocker — não
  atualizar levianamente).

## 2. Âmbito da Fase 3 (plano §16, 7–10 dias)

1. **Edição de método**: secções/passos/reorder no modo edit. O contrato de
   save já existe — estender `RecipeWorkspaceStructureDraft` com
   `methodSections`/`steps` (mesmo padrão full-replace + tempId dos
   ingredientes; validação pré-write; mesma transação/version).
2. **Storage adapter** `RecipeMediaStorage` (plan §6.4): bucket privado
   S3-compatible; chave `org/{orgId}/recipes/{recipeId}/{mediaId}` gerada no
   servidor (filename NUNCA forma a chave); upload direto por URL assinada
   curta; download por URL assinada/proxy. **Decisão em aberto para o humano:
   qual bucket** (Vercel Blob agora suporta private storage; alternativa
   R2/S3). Env vars novas → documentar em SETUP.md e Vercel.
3. **Rotas**: `POST /api/recipes/[id]/media/upload-url` e `/media/confirm`
   (plan §5). Confirm valida magic bytes/dimensões/tamanho (imagens
   JPEG/PNG/WebP; vídeo MP4/WebM), grava `recipe_media.status='ready'`.
   Rate limit por org (infra em `lib/rate-limit`). Audit upload/delete
   (adicionar actions ao union `AuditAction` em `lib/data/audit.ts` — padrão:
   metadata sem conteúdo).
4. **Capa + mídia de passo**: `recipes.cover_media_id` (validar ownership no
   save — não há FK por circularidade, ver comentário no schema) e
   `recipe_step_media` (link table; uma mídia pode ser capa E estar num passo).
5. **Slideshow** `/recipes/[id]/slideshow` (plan §9.4): full-screen, um passo
   por vez, teclado/swipe, `prefers-reduced-motion`, SEM dados financeiros
   (kitchen-safe por construção — usar o DTO kitchen).
6. **Cleanup**: cron que remove `recipe_media` `pending` velhos (padrão dos
   crons existentes em `app/api/cron/…` + `lib/cron-auth.ts`); soft delete +
   remoção assíncrona idempotente no bucket; purge de receita enfileira
   remoção de mídia (ver `lib/data/recipe-purge.ts`).

## 3. Invariantes a não violar (repetidos porque custam caro)

- Mídia: nunca blobs no Postgres, nunca upload público/cross-tenant, nunca
  URL permanente; CSP só para o host de mídia configurado.
- Passos/captions renderizam como TEXTO (já é assim na tab method).
- Kitchen nunca recebe chaves financeiras (o teste deep-scan em
  `tests/recipe-workspace.test.ts` deve continuar a passar e deve ganhar as
  novas superfícies).
- Save sempre via facade com `expectedVersion`; nada de actions avulsas a
  mexer em método/passos.
- Fixtures congeladas de custo/escala não podem mudar.

## 4. Convenções do repo (para não redescobrir)

- PGlite nos testes via `tests/helpers/db.ts` (aplica migrations + RLS reais;
  role `tenant_app` para exercitar RLS).
- RLS gerada de `businessTables` (lib/db/rls.ts) — tabela nova = adicionar lá.
- `withOrg`/`runInOrg` para todo acesso; FKs compostas `(org_id, id)`.
- Strings de UI via next-intl (`lib/i18n/messages/en.json`,
  `recipes.workspace.*`); erros de action via `ActionErrorCode` +
  `actionErrors.*`.
- `npm run typecheck` tem strict-null com noUncheckedIndexedAccess — cuidado
  com destructuring de arrays.
- Migração: editar `lib/db/schema.ts` → `npx drizzle-kit generate` →
  `npm run db:migrate` (journal-guard incluído). A Fase 3 NÃO precisa de
  migração nova (schema já existe), exceto se surgir necessidade imprevista.
- Commits pequenos por slice; suite completa (`npm test`) antes de cada commit.

## 5. Snippets úteis

Backfill por org da DB (o driver Clerk pode não ver todas as orgs):

```ts
const orgs = await sql`select distinct organization_id from recipes`;
for (const { organization_id } of orgs) {
  await withOrg(organization_id, (tx) => backfillRecipesV2ForOrg(tx, organization_id));
}
```

Ligar/desligar a flag:

```sql
update organization_settings set recipes_workspace_v2 = true;  -- ou false p/ rollback
```

## 6. Ordem sugerida de slices para a Fase 3

1. Save de método (draft + facade + testes PGlite) — sem mídia ainda.
2. UI de edição de método (secções/passos/reorder com botões, como a lista de
   ingredientes).
3. Adapter de storage + rotas upload-url/confirm + validação de bytes + testes.
4. Capa + mídia de passo na UI (upload, remover, exibir na tab method).
5. Slideshow.
6. Cron de cleanup + audit + testes RBAC/RLS das novas superfícies.
