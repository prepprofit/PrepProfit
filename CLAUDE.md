# GastroKit SaaS — Regras do Projeto

## O que é este projeto
SaaS multi-tenant de gestão financeira para chefs e donos de negócios de comida
(restaurantes, padarias, confeitarias). Substitui o kit de planilhas "GastroKit"
por um web app por assinatura. Base de código inicial: projeto Wibox (Next.js).

## Stack (não mudar sem aprovação explícita)
- Next.js 15 (App Router) + React 19 + TypeScript estrito
- PostgreSQL no Neon + Drizzle ORM
- Clerk (auth + Organizations) e Clerk Billing conectado ao Stripe
- Tailwind CSS + shadcn/ui + Tremor (dashboards)
- TanStack Table (grids editáveis), react-pdf (faturas)
- Resend (emails), next-intl (i18n: en, es, pt)
- Deploy: Vercel

## REGRA Nº 1 — Multi-tenancy (inegociável)
- TODA tabela de dados de negócio tem coluna `organization_id` (texto, vem do Clerk).
- TODA query (select, insert, update, delete) filtra por `organization_id`.
- Nunca confiar em `organization_id` vindo do client. Sempre obter via
  `auth()` do Clerk no servidor (Server Action ou Route Handler).
- Criar helper `getOrgId()` em `lib/auth.ts` e usá-lo em todo acesso a dados.
- Se uma query não tiver filtro de org, isso é um bug de segurança: parar e corrigir.

## Regras de código
- Server Actions para mutações; sem rotas de API desnecessárias.
- Validação com Zod em toda entrada de usuário (servidor, não só client).
- Valores monetários: armazenar como integer em centavos. Nunca float.
- Cálculos de custo/margem/break-even em funções puras em `lib/calculations/`
  com testes unitários (Vitest). Esses cálculos são o coração do produto.
- Componentes: shadcn/ui primeiro; criar custom só quando necessário.
- Sem `any`. Sem `@ts-ignore`. Tipos derivados do schema Drizzle.
- Strings de UI sempre via next-intl, nunca hardcoded.

## Módulos do produto (paridade com as planilhas GastroKit)
1. Calculadora de custo de receitas (ingredientes → custo total, por porção, margem)
2. Painel financeiro: receitas, despesas, dashboard mensal/anual
3. Inventário de ingredientes e receitas (entradas/saídas, alerta de estoque baixo)
4. Calculadora de ponto de equilíbrio (com simulações de cenário)
5. Folha de pagamento: turnos, horas, pagamentos por funcionário
6. Gerador de faturas em PDF

## Planos de assinatura (gating via Clerk `has()`)
- Starter: 1 usuário, até 50 receitas, módulos 1–3
- Pro: 5 usuários, receitas ilimitadas, módulos 1–4 + faturas
- Business: usuários ilimitados, todos os módulos incl. folha de pagamento

## Workflow
- Seguir o PLANO.md sprint por sprint. Não pular etapas.
- Antes de cada sprint: entrar em plan mode, propor o plano, aguardar aprovação.
- Ao concluir uma tarefa: marcar no PLANO.md como [x].
- Commits pequenos e frequentes com mensagens em inglês (conventional commits).
- Rodar `npm run lint && npm run typecheck && npm test` antes de cada commit.
- Nunca commitar secrets. `.env.local` está no .gitignore.

## Comandos
- dev: `npm run dev`
- build: `npm run build`
- testes: `npm test`
- migrations: `npx drizzle-kit generate` e `npx drizzle-kit migrate`
