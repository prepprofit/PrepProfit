<div align="center">
  <img src="public/logo_final.jpg" alt="PrepProfit" width="80" height="80" style="border-radius:12px" />

  <h1>PrepProfit</h1>

  <p><strong>Gestão financeira multi-tenant para chefs e negócios de comida.</strong><br/>
  O kit de planilhas <em>GastroKit</em> reimaginado como um SaaS por assinatura.</p>

  <p>
    <img alt="CI" src="https://github.com/Napster13Nord/PrepProfit/actions/workflows/ci.yml/badge.svg" />
    <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-black?logo=next.js" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
    <img alt="License" src="https://img.shields.io/badge/license-proprietary-lightgrey" />
  </p>
</div>

---

## Visão geral

PrepProfit substitui o kit de planilhas (Excel/Google Sheets) do **GastroKit** por
um web app por assinatura, multi-tenant, feito para a realidade de restaurantes,
padarias e confeitarias. Cada organização tem seus dados **completamente isolados**;
os cálculos de custo, margem e ponto de equilíbrio — o coração do produto — vivem em
funções puras e testadas.

## Módulos do produto

| # | Módulo | Descrição |
|---|--------|-----------|
| 1 | **Receitas** | Custo de receita (ingredientes → custo total, por porção, margem) |
| 2 | **Financeiro** | Receitas, despesas e dashboard mensal/anual |
| 3 | **Inventário** | Entradas/saídas de estoque e alerta de estoque baixo |
| 4 | **Ponto de equilíbrio** | Break-even com simulação de cenários |
| 5 | **Folha de pagamento** | Turnos, horas e pagamentos por funcionário |
| 6 | **Faturas** | Geração de faturas em PDF |

Os planos de assinatura (Starter / Pro / Business) liberam os módulos via Clerk Billing.

## Stack

- **Next.js 15** (App Router) · **React 19** · **TypeScript** estrito
- **PostgreSQL** (Neon) + **Drizzle ORM**
- **Clerk** (auth + Organizations) e **Clerk Billing** sobre **Stripe**
- **Tailwind CSS v4** + **shadcn/ui** (+ Tremor para dashboards)
- **next-intl** (pt, en, es) · **Zod** (validação no servidor)
- **Vitest** + **PGlite** (testes de banco sem dependências externas)
- Deploy na **Vercel**

## Arquitetura multi-tenant (a regra nº 1)

Isolamento por organização em **duas camadas independentes**:

1. **Camada de aplicação (primária)** — o `organization_id` **sempre** vem do Clerk no
   servidor (`getOrgId()` em [`lib/auth.ts`](lib/auth.ts)); nunca do client. Todo acesso
   a dados passa por helpers em [`lib/data/`](lib/data) que injetam o `organization_id`
   no `WHERE`/`INSERT`.
2. **Camada de banco (defesa em profundidade)** — **Row-Level Security** com `FORCE` em
   cada tabela ([`lib/db/rls.ts`](lib/db/rls.ts)). A policy só expõe linhas cuja
   `organization_id` casa com a GUC `app.current_org_id`, definida por transação em
   [`runInOrg()`](lib/db/tenant.ts). Sem contexto de organização, **nenhuma linha passa**
   (seguro por padrão).

> Valores monetários são sempre `integer` em centavos — nunca float.

## Estrutura do projeto

```
app/
  (marketing)/        Landing page pública
  (app)/              Shell autenticado (sidebar + OrganizationSwitcher) + módulos
  sign-in, sign-up    Páginas do Clerk
  select-organization Seleção/criação de organização
components/
  ui/                 Primitivos shadcn/ui (button, card, …)
  app/                Sidebar, placeholders de módulo
lib/
  auth.ts             getOrgId(), roles
  db/                 schema (Drizzle), RLS, cliente Neon, runInOrg()
  data/               Acesso a dados — sempre escopado por organização
  i18n/               Configuração + catálogos pt/en/es
drizzle/              Migrations geradas
scripts/              migrate.ts (schema + RLS), seed.ts (2 organizações)
tests/                isolation.test.ts — prova o isolamento entre orgs
```

## Começando

```bash
npm install
npm test          # roda já, sem credenciais (Postgres em memória via PGlite)
```

Para rodar o app de verdade, configure Neon e Clerk e preencha o `.env.local` —
o passo a passo completo está em **[SETUP.md](SETUP.md)**.

```bash
cp .env.example .env.local   # preencha DATABASE_URL e as chaves do Clerk
npm run db:migrate           # cria tabelas + aplica RLS
npm run seed                 # (opcional) popula 2 organizações de exemplo
npm run dev                  # http://localhost:3000
```

## Scripts

| Comando | O que faz |
|---------|-----------|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Testes (Vitest + PGlite) |
| `npm run db:generate` | Gera migration a partir do schema |
| `npm run db:migrate` | Aplica migrations + policies de RLS |
| `npm run seed` | Popula duas organizações com dados isolados |

## Testes

O isolamento multi-tenant é verificado automaticamente em
[`tests/isolation.test.ts`](tests/isolation.test.ts): um Postgres em memória (PGlite)
recebe as **mesmas** migrations e policies de produção, e o teste prova — nas duas
camadas — que a organização A jamais enxerga dados da B. Não exige banco externo, então
roda no CI sem segredos.

## Deploy

Importe o repositório na **Vercel**, defina as variáveis de ambiente (ver
[SETUP.md](SETUP.md)) e rode `npm run db:migrate` contra o Neon de produção antes do
primeiro deploy. A integração contínua (lint + typecheck + test) roda em cada push via
[GitHub Actions](.github/workflows/ci.yml).

## Roadmap

O desenvolvimento segue o **[PLANO.md](PLANO.md)**, sprint por sprint:

- [x] **Sprint 0** — Fundação multi-tenant (schema, RLS, auth, shell, isolamento testado)
- [ ] **Sprint 1** — Receitas e ingredientes (CRUD, custo real, margem)
- [ ] **Sprint 2** — Financeiro e ponto de equilíbrio
- [ ] **Sprint 3** — Faturas e folha de pagamento
- [ ] **Sprint 4** — Cobrança (Clerk Billing + Stripe)
- [ ] **Sprint 5** — Polimento para lançamento

---

<div align="center"><sub>Convenções e regras do projeto em <a href="CLAUDE.md">CLAUDE.md</a> · Design system em <a href="DESIGN.md">DESIGN.md</a></sub></div>
