# Auditoria de Segurança — 2026-07-05

Escopo: repositório inteiro (middleware, route handlers, headers, SQL, uploads, webhooks, cron, segredos).

## Veredicto

O **código** está sólido — RLS forçado por org, RBAC server-side antes de qualquer dado,
cron autenticado com comparação constant-time, uploads validados pelos bytes (não pelo mime
declarado), `sql.raw` só em CHECK constraints estáticas, zero `dangerouslySetInnerHTML`,
webhook Clerk verificado por assinatura Svix, rate limiting antes do trabalho de org.
Nenhuma vulnerabilidade nova de código encontrada.

O risco real de ser hackeado hoje está em **3 itens operacionais** (fora do código) + 1 bug funcional novo.

## Achados

### 1. CRÍTICO — Senha do Neon (prod) exposta em chats, nunca rotacionada

A connection string do Postgres de produção foi colada em sessões de chat várias vezes
(registrado repetidamente desde junho). Quem tiver essa string tem acesso TOTAL ao banco —
RLS não protege contra o dono da conexão. A senha legada do Wibox também foi exposta.

**Como arrumar (5 min):** Neon Console → projeto PrepProfit → Roles → Reset password →
atualizar `DATABASE_URL` no Vercel (env de produção) → redeploy. Repetir para o projeto Wibox legado.

### 2. ~~ALTO — Chaves Clerk de dev em prod~~ RESOLVIDO

Verificado em 2026-07-05: prod serve `pk_live_...` (instância clerk.prepprofit.com).
O cutover dev→live já foi feito. Nenhuma ação.

### 3. MÉDIO — CSP ainda em Report-Only

`next.config.ts:51` envia `Content-Security-Policy-Report-Only`: violações são logadas,
nunca bloqueadas. Um XSS (se algum dia existir) roda sem freio. Os outros headers
(nosniff, frame-ancestors, HSTS) já estão ativos.

**Como arrumar:** depois de alguns dias sem violações no console em prod, trocar a key
para `Content-Security-Policy` (uma linha). `unsafe-inline`/`unsafe-eval` ficam até o
CSP com nonce do Next — aceitável, ainda é melhor que nada.

### 4. BAIXO (funcional, não segurança) — `/ingest` bloqueado pelo middleware

O proxy PostHog novo (`/ingest/*`, commit `eb38628`) não está em `isPublicRoute` no
`middleware.ts`, então `auth.protect()` derruba as chamadas de visitantes anônimos da
landing — exatamente o tráfego de marketing que o proxy existe para capturar.

**Como arrumar:** adicionar `'/ingest(.*)'` ao `isPublicRoute`. O destino do rewrite é
fixo (só PostHog EU), então abrir a rota não cria proxy aberto.

## Verificado e OK (sem ação)

- Multi-tenancy: `getOrgId()` server-side em todos os 20 route handlers; `withOrg` + FORCE RLS em toda escrita.
- Cron: `CRON_SECRET` com `timingSafeEqual`; rate-limited; sem carve-out de RLS.
- Upload de imagem AI: RBAC → rate limit → limite de tamanho pré-buffer → validação por bytes; imagem descartada, nunca persistida.
- Sem `.env` comitado (só `.env.example`); sem injeção SQL (Drizzle parametrizado); sem XSS em emails/UI.
- Clickjacking/MIME/referrer/HSTS headers ativos.

## Ordem de execução

1. Rotacionar senha Neon (hoje).
2. Cutover Clerk live keys (antes do launch).
3. Promover CSP para enforcing (após observar prod).
4. Liberar `/ingest` no middleware (1 linha, quando quiser os dados de marketing).
