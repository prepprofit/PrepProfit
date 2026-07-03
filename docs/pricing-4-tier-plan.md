# Plano: reestruturação de precificação para 4 tiers + reverse trial

**Status:** proposta para revisão do dev senior — NÃO implementado ainda.
**Autor:** owner + Claude Code
**Data:** 2026-07-02
**Escopo:** adicionar o tier **Solo** (hoje são 3: Free/Pro/Business → passam a 4), reajustar
a matriz de features/limites/cotas de AI, e introduzir um **reverse trial** de 14 dias
(todo org novo nasce com acesso total e cai para Free se não fizer upgrade).

> Ler junto com `CLAUDE.md` §"Subscription plans - live mapping" e `lib/entitlements.ts`
> (a fonte de verdade atual dos caps). Nada aqui muda a stack.

---

## 1. Decisões de produto e premissas

| # | Decisão | Valor |
|---|---|---|
| D1 | Nº de planos | 4: **Free** (forever) / **Solo** / **Pro** / **Business** |
| D2 | Preços | €0 / **€19** / €29 / €79 por mês |
| D3 | Moeda/catálogos | **Prod cobra EUR**. O `clerk/billing.json` versionado pode continuar em **USD placeholder** para o gateway dev; os valores numéricos são 1:1 com EUR prod. |
| D4 | Diferença Solo↔Pro | **seats + módulos financeiros**: Solo = 1 seat + break-even; Pro = 5 seats + invoices |
| D5 | Trial dos pagos | **Aberto** — ver Decisão Aberta A. Recomendação: o reverse trial é o único trial. |
| D6 | Cotas de AI | escada crescente Free→Business; AI continua **universal** (não é feature do Clerk) |
| D7 | Reverse trial | org novo = **acesso total (nível Business) por 14 dias**, depois cai para os limites do Free |

---

## 2. Matriz final dos planos

### 2.1 Módulos (Clerk *features* — booleano, `requireFeature()`)

| Módulo | Free | Solo €19 | Pro €29 | Business €79 |
|---|:--:|:--:|:--:|:--:|
| Operacional (receitas, ingredientes, estoque, fornecedores, menus, produções, tasks, allergens, POs) | ✅ | ✅ | ✅ | ✅ |
| `break_even` | — | ✅ | ✅ | ✅ |
| `invoices` (faturamento + vendas/fechamento diário hoje `invoices`-gated) | — | — | ✅ | ✅ |
| `payroll` | — | — | — | ✅ |
| `advanced_documents` (P&L PDF/XLSX, financials print) | — | — | — | ✅ |

> Mudança relevante: **`break_even` desce de Pro para Solo+**. Ninguém perde acesso (só amplia).
> Herança é explícita no `billing.json` (cada plano lista as features que concede).

### 2.2 Caps numéricos e seats

| Cap | Free | Solo | Pro | Business |
|---|:--:|:--:|:--:|:--:|
| Receitas | 10 | ∞ | ∞ | ∞ |
| Seats | 1 | 1 | 5 | ∞ |

Importante: **receitas** são cap app-side em `PLAN_LIMITS`. **Seats não podem ficar só em
`PLAN_LIMITS`**, porque hoje esse valor é usado para display/consistência e não bloqueia convite
ou membership no app. Para seat cap real em B2B, configurar os limits nos **Organization Plans**
do Clerk (Free/Solo = 1, Pro = 5, Business = ilimitado) e smoke-testar convite/join acima do cap.
Se o Clerk/add-on atual não suportar Business ilimitado, decidir entre cap explícito (ex.: 20) ou
custom guard de convite. Não vender seats como enforcement app-side sem esse teste.

### 2.3 Cotas mensais de AI (app-side, contadas por org/mês-calendário)

Todas essas moram em mapas `Record<PlanTier, number>` em `lib/entitlements.ts`. São ajustáveis
sem deploy da lógica de gating.

| Feature de AI (mapa) | Free | Solo | Pro | Business |
|---|:--:|:--:|:--:|:--:|
| Extração de receita por foto (`AI_EXTRACTION_MONTHLY_LIMIT`) | 10 | 40 | 100 | 500 |
| Leitor de fatura de fornecedor (`SUPPLIER_INVOICE_MONTHLY_LIMIT`) | 3 | 12 | 30 | 200 |
| Explicação de vazamento de margem (`PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT`) | 10 | 40 | 100 | 500 |
| Resumo de fechamento diário (`DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT`) | 0 | 0¹ | 30 | 500 |
| Resumo de plano de prep/compra (`PREP_PLAN_SUMMARY_MONTHLY_LIMIT`) | 0 | 15 | 30 | 500 |
| Relatório semanal do CFO (`WEEKLY_CFO_REPORT_MONTHLY_LIMIT`) | 2 | 4 | 8 | 30 |

¹ O fechamento diário depende do módulo de **vendas**, que hoje é `invoices`-gated
(`app/(app)/sales/actions.ts`). Como o Solo não tem `invoices`, ele não posta um fechamento →
cota 0 é consistente, não punição. **Ver Decisão Aberta C.**

> Durante o **reverse trial** (§4) o org é tratado como Business, então ganha as cotas de AI da
> coluna Business. É o comportamento desejado (degustação completa).

---

## 3. Onde o código é tocado

Ordenado por slice. Cada slice = 1 commit convencional pequeno. Gate antes de merge:
`npm run lint && npm run typecheck && npm test && npm run build`.

**Pre-flight obrigatório:** Clerk Billing ainda é uma superfície experimental. Antes de mexer em
Billing/reverse trial, pin/confirmar as versões de `@clerk/nextjs` (e `clerk-js`, se aparecer no
lock) e validar que Billing está habilitado no Clerk dev na aba **Organization Plans**. Plano criado
na aba User Plans não aparece em `<PricingTable for="organization" />`.

### Slice 1 — Núcleo de entitlements (código puro, reversível, sem tocar em prod)

- **`lib/entitlements.ts`**
  - Adicionar `'solo'` ao union `PlanTier`. Isso faz o **TypeScript exigir** o preenchimento
    de TODOS os `Record<PlanTier, …>` (é a rede de segurança — nenhum mapa fica esquecido):
    `PLAN_LIMITS`, `AI_EXTRACTION_MONTHLY_LIMIT`, `SUPPLIER_INVOICE_MONTHLY_LIMIT`,
    `PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT`, `DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT`,
    `PREP_PLAN_SUMMARY_MONTHLY_LIMIT`, `WEEKLY_CFO_REPORT_MONTHLY_LIMIT`.
  - `getPlanTier()`: inserir o degrau `solo` na ordem correta (checar `business` → `pro` →
    `solo` → `starter`) e exigir `orgId` antes de qualquer plan check, para não cair em assinatura
    pessoal por acidente. Continua **fail-closed** (qualquer erro → `starter`).
- **`lib/data/subscriptions.ts`**
  - `planSlugToTier()`: mapear o slug `'solo'`.
  - `TIER_RANK`: passar para `{ starter: 0, solo: 1, pro: 2, business: 3 }` (usado por
    `comparePlanTiers`/`classifyPlanChange`/`resolvePlanTier`).
- **Testes:** `tests/entitlements.test.ts`, `tests/subscriptions.test.ts`,
  `tests/billing-catalogue.test.ts`.

### Slice 2 — Catálogo Clerk/Stripe (config; dev primeiro)

- **`clerk/billing.json`**: adicionar o plano `solo` como **Organization Plan** (`amount: 1900`,
  `payer_type: "org"`, `is_recurring: true`, `publicly_visible: true`,
  `features: ["break_even"]`, trial conforme Decisão Aberta A). Manter o padrão já documentado:
  dev config pode ficar em `currency: "usd"` placeholder; prod é configurado em EUR. Ajustar o Pro
  para listar `break_even` explicitamente junto de `invoices`.
- **Seat limits no Clerk:** configurar cap de membros nos org plans (Solo=1, Pro=5, Business=
  ilimitado ou o máximo aceito pelo plano Clerk atual). Se o export/patch do `billing.json` tiver
  campo específico para seat limit, puxar via `clerk config pull --keys billing` depois de criar no
  dashboard para evitar adivinhar schema.
- **Clerk dev**: criar o plano `solo` (via `clerk` CLI ou dashboard) com o slug `solo` e a feature
  `break_even`. Validar que `has({ plan: 'solo' })` e `has({ feature: 'break_even' })` respondem
  certo em uma sessão de teste. Se a versão atual do Clerk exigir prefixo de org plan (ex. `org:solo`),
  padronizar essa sintaxe em todos os plan checks antes de seguir.
- Clerk Billing é backed por Stripe e re-emite os eventos, então **não há webhook Stripe
  separado** — o endpoint `app/api/webhooks/clerk/route.ts` já cobre tudo.

### Slice 3 — Reverse trial (código + 1 config no Clerk)

Objetivo: org novo = acesso nível Business por 14 dias, sem cartão; depois cai para Free.

- **Origem do `trialEndsAt`**: no webhook `organization.created`
  (`app/api/webhooks/clerk/route.ts`, já roda `withOrg` e semeia defaults), gravar
  `trialEndsAt = evt.data.created_at + 14 dias` (não "hora de processamento") no
  **`publicMetadata` do org** via `clerkClient().organizations.updateOrganizationMetadata(...)`.
  Essa escrita deve acontecer antes do welcome e-mail; se falhar, retornar 500 para Svix retry.
- **Exposição sem I/O no caminho quente**: customizar o **session token** do Clerk para incluir
  a claim (ex.: `{"org_trial_ends_at": "{{org.public_metadata.trial_ends_at}}"}`), para que
  `auth().sessionClaims` traga o valor. Assim `getPlanTier()` continua **sem leitura de DB**.
- **Helper de entitlement efetivo**: não basta mexer em `getPlanTier()`. Hoje módulos pagos passam
  por `canUseFeature()`/`requireFeature()`, que leem `has({ feature })`; uma org em reverse trial
  não tem assinatura Business real no Clerk, então `has({ feature })` continuaria `false`. Criar um
  helper comum (ex.: `getEffectiveEntitlementState()`) que resolve `tier`, `source` (`paid` /
  `trial` / `comped` / `free`) e `trialEndsAt`.
- **Override em `getPlanTier()` e `canUseFeature()`**: se o tier real resolvido é `starter` **e**
  `now < trialEndsAt` → tier efetivo `business` e todas as `Feature` da união são permitidas. Se o
  org já tem qualquer plano pago, o plano real prevalece (não sobrescreve). Comped continua tendo
  prioridade (Business + todas as features).
- **Fail-safe**: orgs criados ANTES do feature não têm a claim → nenhum trial retroativo
  (correto). Claim ausente/inválida → sem trial. `trialEndsAt` é imutável, então não há
  problema de staleness depois que a claim entra no token.
- **Race de primeira sessão**: `organization.created` é async; o primeiro JWT pode nascer antes do
  metadata existir. Smoke-test obrigatório: criar org nova e verificar se a sessão já recebe a
  claim. Se não receber, escolher mitigação antes de prod (forçar reload de sessão no onboarding,
  fallback DB apenas na primeira tela, ou aceitar que o trial aparece após refresh).
- **Testes:** `getPlanTier` = business dentro da janela, `canUseFeature('invoices'|'payroll')`
  permite durante trial, starter depois, plano pago real vence, claim ausente/malformada → sem
  trial, no-org → starter/false.

> **Comunicação do "penhasco"** (dias 10/12/14): o downgrade é **silencioso** — não há evento
> Clerk quando o tempo expira. Reminder por e-mail exige um **cron** que varre orgs com trial a
> expirar, reusando o dispatcher React Email já existente. Proposto como **Slice 6 (opcional)**.

### Slice 4 — UI de preços (4 colunas)

- **`components/marketing/pricing-section.tsx`**: `PLAN_KEYS` →
  `['free','solo','pro','business']`. Rever `filled`/`popular` (hoje `filled=free`,
  `popular=pro`).
- **`components/marketing/pricing-cards.tsx`**: o grid é `lg:grid-cols-3` hardcoded (linha ~89) →
  precisa virar 4 colunas responsivas (ex.: `sm:grid-cols-2 xl:grid-cols-4`). Rever espaçamento
  do card `popular` (`lg:-mt-4`) com 4 cards.
- **`app/(app)/pricing/page.tsx`** e **`app/(app)/billing/page.tsx`**: revisar layout/labels. O
  checkout in-app usa o `<PricingTable>` do Clerk, que **renderiza os planos automaticamente** a
  partir do Clerk — pega o Solo sozinho. A pricing-section de marketing é hand-rolled → precisa
  do card Solo manual.
- **Billing/trial display:** se `getPlanTier()` passar a retornar Business durante reverse trial,
  `/billing` não pode dizer simplesmente "Current plan: Business" como se fosse assinatura paga.
  Expor `source/trialEndsAt` no helper e mostrar algo como "Business trial" + data de término; o
  plano pago real continua vindo do mirror/Clerk.
- **Onboarding/marketing copy:** atualizar textos que hoje dizem "Starter by default",
  "Continue on Starter" e "paid plans include a 14-day trial". Com reverse trial, a narrativa é
  "14 dias com tudo, depois Free se não escolher um plano".
- **i18n**: `lib/i18n/messages/en.json` é o **único** locale hoje. Adicionar o bloco
  `marketing.pricing.solo.*` (name/tagline/price/priceYear/cta/f1..f4) e o label de plano em
  `notifications.plans.solo` e `billing.tier.solo`. **Ver Decisão Aberta D (preço anual).**

### Slice 5 — Testes de enforcement + docs

- **`tests/entitlement-enforcement.test.ts`**: cobrir Solo → tem `break_even`, **não** tem
  `invoices`/`payroll`/`advanced_documents`; caps (seats=1, recipes=∞).
- **`tests/entitlements.test.ts`**: cotas de AI do Solo (a tabela §2.3).
- **`tests/billing-catalogue.test.ts`**: catálogo deve conter Solo, feature nesting, preço, trial
  toggle aceito em A, e paridade com copy pública.
- **`tests/clerk-webhook-route.test.ts`**: `organization.created` grava `trial_ends_at` a partir
  do timestamp do evento e continua idempotente em retry.
- Atualizar `CLAUDE.md` §"Subscription plans - live mapping" e `PLANO.md`.

### Slice 6 — (opcional) Cron de aviso de fim de trial

- Novo cron (padrão dos crons existentes em `app/api/cron/*`) que, X dias antes do
  `trialEndsAt`, enfileira/dispara um e-mail "seu trial termina em N dias" via React Email.
  Rate-limit + idempotência como os outros crons.
- Se `trialEndsAt` ficar **só** no Clerk publicMetadata, o cron precisa paginar orgs no Clerk e
  filtrar client-side. Para um reminder confiável e barato, preferir um mirror em
  `organization_settings` ou tabela pequena de trial lifecycle (sem usar isso como autoridade de
  gating).

### Slice 7 — Rollout de produção (com aval do owner)

- Criar o plano `solo` no **Clerk prod** com preço **€19** real (EUR) + feature `break_even` +
  trial conforme Decisão A + seat limit conforme §2.2.
- Aplicar a customização do **session token** no Clerk prod (mesma do dev, Slice 3).
- Deploy + smoke test: checkout Solo, verificação do reverse trial em org novo, e o mirror
  (`subscriptions`) refletindo o plano. Smoke extra: convite acima do cap, trial com invoices/payroll
  liberados, expiração do trial voltando para Free, e sessão atualizada após checkout.

---

## 4. Arquitetura do reverse trial (detalhe para revisão)

```
organization.created (webhook, já existe)
  └─ set publicMetadata.trial_ends_at = evt.data.created_at + 14d   (novo)

request-time:
  getEffectiveEntitlementState():
    if comped(org)                      -> { tier: 'business', source: 'comped' }
    realTier = has(business|pro|solo?)  -> resolve plano pago real
    if realTier == 'starter' && now < claims.org_trial_ends_at
                                        -> { tier: 'business', source: 'trial' }
    return { tier: realTier, source: realTier == 'starter' ? 'free' : 'paid' }

  getPlanTier()                         -> state.tier
  canUseFeature(feature):
    if state.source in ['comped','trial'] -> true
    else                                  -> Clerk has({ feature })
```

Propriedades:
- **Zero I/O extra** no gating (lê a claim do JWT, não o DB).
- **Fail-closed** preservado: sem claim / claim inválida / erro → cai no realTier (starter).
- **Não empilha** com plano pago: assinou → realTier ≠ starter → override não dispara.
- **Sem evento na expiração** → downgrade é por tempo; reminder depende do Slice 6.
- **Feature gates cobertos**: reverse trial precisa passar por `canUseFeature()`, não só por
  `getPlanTier()`, senão o usuário vê cota Business mas continua bloqueado em invoices/payroll.

Comportamento na expiração (padrão freemium, esperado — não é bug):
- Módulos e cotas travam na hora.
- Dados acima do cap do Free **não somem** (o cap é checado na criação): as receitas continuam
  legíveis, mas não cria a 11ª até voltar abaixo de 10; membros convidados ficam, mas não
  adiciona a 2ª seat. É o incentivo natural de upgrade.

---

## 5. Decisões abertas (para o dev senior bater o martelo)

- **A. Trial dos planos pagos.** Com o reverse trial já dando 14 dias de tudo, manter +14 dias de
  trial ao assinar Solo/Pro/Business = ~28 dias grátis. **Recomendação: remover o trial dos pagos**
  (`free_trial_enabled: false`) e usar o reverse trial como único teste. Alternativas: manter os
  dois, ou trial curto (7d).
- **B. Storage do `trialEndsAt`.** Recomendado para gating: `publicMetadata` do org + session claim
  (zero I/O). Se o reminder de expiração for obrigatório, adicionar mirror em DB para cron/idempotência
  e manter a claim como fonte do request-time gating. Se a race da primeira sessão for inaceitável,
  considerar fallback DB só no onboarding/billing.
- **C. Vendas/fechamento diário no Solo.** Solo fica sem `invoices` → sem módulo de vendas → sem
  fechamento diário (cota 0). Confirmar que é o desejado, ou dar vendas ao Solo (muda a §2.1/§2.3).
- **D. Preço anual.** A UI atual usa "2 months free" (`€29 → €290`, `€79 → €790`). Confirmar se
  Solo segue o mesmo padrão (`€19 → €190`) e manter o texto do toggle em paridade.
- **E. Abuso do reverse trial.** Criar org → 14 dias → deletar → recriar. Risco baixo no início;
  mitigação (ex.: marcar por criador/e-mail) pode ficar para depois. Aceitar o risco por ora?
- **F. Business com seats ilimitados.** Confirmar se o plano/add-on atual do Clerk permite
  Organization Plan com seat limit ilimitado; se não, escolher cap explícito antes de vender
  "unlimited users".

---

## 6. Riscos e invariantes a preservar

- `getPlanTier()` é **fail-closed**; qualquer regressão que resolva um pago para `starter`
  quebra acesso pago silenciosamente → coberto por teste.
- Reverse trial precisa ser **efetivo para tier e feature gates** (`getPlanTier` +
  `canUseFeature`). Se só o tier for sobrescrito, o trial vira "Business nas cotas, Free nos
  módulos", que é o pior dos dois mundos.
- O mirror `subscriptions` **nunca concede acesso** (só display/observabilidade); o gating lê
  Clerk vivo. O reverse trial reforça isso: a autoridade é `auth()`, não o DB.
- Multi-tenancy intocada: nenhuma query nova sem `organization_id`; o `trialEndsAt` é metadata do
  org (Clerk), não dado de tenant no Postgres.
- `<PricingTable>` do Clerk reflete os planos automaticamente; a pricing-section de marketing é
  manual e precisa ser mantida em paridade.
- `clerk/billing.json` dev pode continuar USD placeholder; prod é EUR. Não trocar moeda do arquivo
  versionado sem validar o gateway dev e atualizar `billing-catalogue.test.ts`.
- Seats só são enforcement real se Clerk Organization Plan seat limits (ou um guard próprio de
  convite) estiverem configurados e testados.

---

## 7. Ordem de execução sugerida

1. Slice 1 (código puro) — pode começar assim que aprovado; nada em prod.
2. Slice 2 + 3 (Clerk dev + reverse trial) — com o owner acompanhando.
3. Slice 4 + 5 (UI + testes/docs).
4. Slice 6 (cron de aviso) — opcional, pode ser fast-follow.
5. Slice 7 (prod) — só com aval explícito do owner.
