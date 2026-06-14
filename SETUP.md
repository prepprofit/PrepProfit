# SETUP — GastroKit (Sprint 0)

Guia para colocar a fundação multi-tenant rodando. Os testes automatizados
(`npm test`) **não** precisam de nada disto — usam um Postgres em memória.
Os passos abaixo são para rodar o app de verdade e validar o critério de aceite
com dois logins reais.

## 0. Pré-requisitos
- Node 22+
- `npm install` já executado

## 1. Banco de dados — Neon
1. Crie uma conta em https://neon.tech e um projeto Postgres.
2. Em **Connection Details**, copie a **connection string com pooling**
   (contém `-pooler` no host). O Pool é necessário para as transações que
   ativam o RLS.
3. Você vai colá-la em `DATABASE_URL` (passo 3).

## 2. Autenticação — Clerk (com Organizations)
1. Crie uma conta em https://clerk.com e uma aplicação.
2. **Organizations**: no menu **Organizations Settings**, ative
   *Enable organizations*. (O app exige uma organização ativa — o middleware
   redireciona para `/select-organization` quem entrar sem org.)
3. Em **API Keys**, copie:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (começa com `pk_`)
   - `CLERK_SECRET_KEY` (começa com `sk_`)

## 3. Variáveis de ambiente
```bash
cp .env.example .env.local
```
Preencha `.env.local` com a `DATABASE_URL` (Neon) e as chaves do Clerk.
`.env.local` está no `.gitignore` — nunca comite segredos.

## 4. Migrations + RLS
```bash
npm run db:migrate
```
Cria as tabelas (`ingredients`, `recipes`, `recipe_ingredients`) e aplica as
policies de Row-Level Security (isolamento por `organization_id`).

## 5. Seed de duas organizações (opcional, para a demo do critério de aceite)
Os dados são escritos por organização. Para vê-los no app, os ids precisam casar
com os ids reais das suas organizações no Clerk:
1. Rode `npm run dev`, faça login, crie **duas** organizações
   (ex.: "Padaria A" e "Confeitaria B") no OrganizationSwitcher.
2. Pegue o id de cada org (formato `org_...`) — visível no dashboard do Clerk
   (Organizations) ou na URL ao selecioná-las.
3. Rode o seed apontando para esses ids:
   ```bash
   SEED_ORG_A=org_xxxxA SEED_ORG_B=org_xxxxB npm run seed
   ```
   (No PowerShell: `$env:SEED_ORG_A="org_xxxxA"; $env:SEED_ORG_B="org_xxxxB"; npm run seed`)

## 6. Rodar
```bash
npm run dev
```
Abra http://localhost:3000.

## 7. Validar o critério de aceite (isolamento entre organizações)
- Faça login e troque entre as duas organizações no **OrganizationSwitcher** do
  topo. Cada organização só enxerga os próprios ingredientes/receitas.
- Para um teste com **dois usuários** distintos: convide um segundo usuário (ou
  use outro navegador/conta) para a Org B; ele nunca verá os dados da Org A.
- O isolamento já é garantido automaticamente em `npm test`
  (`tests/isolation.test.ts`), nas duas camadas: filtro por `organization_id`
  na aplicação **e** RLS no banco.

## 8. Deploy na Vercel
1. Importe o repositório `Napster13Nord/PrepProfit` em https://vercel.com.
2. Em **Environment Variables**, adicione as mesmas chaves do `.env.local`
   (`DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
   e as URLs do Clerk).
3. Build command padrão (`next build`) já funciona.
4. **Antes do primeiro deploy de produção**, rode as migrations contra o Neon de
   produção: `npm run db:migrate` (com a `DATABASE_URL` de produção).
5. (Opcional) Configure o Neon de produção como um projeto/branch separado do de
   desenvolvimento.

## Comandos úteis
| Ação | Comando |
|------|---------|
| Dev | `npm run dev` |
| Lint + types + testes | `npm run lint && npm run typecheck && npm test` |
| Gerar migration | `npm run db:generate` |
| Aplicar migrations + RLS | `npm run db:migrate` |
| Seed (2 orgs) | `npm run seed` |
