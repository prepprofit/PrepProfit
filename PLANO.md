# PLANO.md — GastroKit SaaS: roadmap executável

Instruções para o Claude Code: trabalhe um sprint por vez, na ordem.
Marque tarefas concluídas com [x]. Não inicie um sprint sem o anterior completo.

---

## Sprint 0 — Fundação multi-tenant
Objetivo: esqueleto do SaaS com isolamento de dados por organização funcionando.

- [x] Inicializar projeto Next.js 15 + TypeScript + Tailwind (ou importar base Wibox se fornecida)
- [x] Instalar e configurar Drizzle ORM apontando para Neon Postgres
- [x] Configurar Clerk com Organizations habilitado; middleware protegendo /app/*
      (código pronto; habilitar Organizations no dashboard do Clerk — ver SETUP.md)
- [x] Criar `lib/auth.ts` com `getOrgId()` (lança erro se sem org ativa)
- [x] Schema inicial Drizzle: tabelas `ingredients`, `recipes`, `recipe_ingredients`,
      todas com `organization_id` + índice composto
- [x] Habilitar Row-Level Security no Postgres como segunda camada de defesa
- [x] Seed script com dados de exemplo para 2 organizações distintas
- [x] Teste automatizado: org A nunca enxerga dados da org B
- [x] Layout base: sidebar com módulos, OrganizationSwitcher do Clerk, página vazia por módulo
- [~] Deploy na Vercel com Neon de produção; CI simples (lint + typecheck + test)
      (CI pronto em .github/workflows/ci.yml; deploy na Vercel pendente de credenciais — ver SETUP.md)

Critério de aceite: dois usuários de orgs diferentes logam e veem dados isolados.

---

## Sprint 1 — Receitas e ingredientes (módulos 1 e 3)
Objetivo: chef cadastra ingredientes, monta receitas e vê custo real.

- [ ] CRUD de ingredientes (nome, unidade, preço por unidade/kg, fornecedor opcional)
- [ ] Grid editável de ingredientes com TanStack Table (edição inline)
- [ ] CRUD de receitas: ingredientes + quantidades, rendimento (porções), % de perda
- [ ] `lib/calculations/recipeCost.ts`: custo total, custo por porção,
      custos ocultos (mão de obra, energia, embalagem) — com testes Vitest
- [ ] Preço de venda sugerido + margem com semáforo (verde/amarelo/vermelho)
- [ ] Atualização em cascata: mudou preço do ingrediente → recalcula receitas
- [ ] Inventário: registro de entrada/saída de estoque por ingrediente
- [ ] Alerta visual de estoque baixo (limite configurável por ingrediente)

Critério de aceite: criar receita com 5 ingredientes e ver custo e margem corretos.

---

## Sprint 2 — Financeiro e break-even (módulos 2 e 4)
Objetivo: responder "quanto eu realmente ganhei este mês?".

- [ ] Tabelas `transactions` (receita/despesa, categoria, data, valor em centavos)
- [ ] CRUD de transações com categorias predefinidas + customizáveis
- [ ] Dashboard mensal: receita, despesas, lucro, top produtos (Tremor)
- [ ] Dashboard anual: evolução mês a mês, comparativo
- [ ] `lib/calculations/breakEven.ts`: custos fixos + margem média → unidades
      necessárias para empatar — com testes
- [ ] Página de break-even com simulador de cenários (sliders de preço/custo)

Critério de aceite: lançar 10 transações e ver dashboards e break-even coerentes.

---

## Sprint 3 — Faturas e folha de pagamento (módulos 5 e 6)
Objetivo: completar paridade com as 5 planilhas do GastroKit.

- [ ] Tabela `invoices` + `invoice_items`; numeração sequencial por organização
- [ ] Criador de fatura: cliente, itens, impostos, total
- [ ] Geração de PDF da fatura (react-pdf) com logo da organização
- [ ] Tabelas `employees` e `shifts` (check-in/check-out, valor hora)
- [ ] Registro de turnos + cálculo automático de horas e pagamento devido
- [ ] Resumo por funcionário por período (semana/mês)

Critério de aceite: gerar PDF de fatura e fechar a folha de um funcionário no mês.

---

## Sprint 4 — Cobrança com Clerk Billing + Stripe
Objetivo: o produto aceita pagamentos.

- [ ] Habilitar Clerk Billing (B2B, planos por Organization) e conectar conta Stripe
- [ ] Criar planos Starter / Pro / Business no dashboard da Clerk com Features
- [ ] Página /pricing com <PricingTable /> do Clerk
- [ ] Gating: `has({plan})` / <Protect> nos módulos conforme CLAUDE.md
- [ ] Limites do Starter (50 receitas, 1 usuário) aplicados no servidor
- [ ] Fluxo de onboarding pós-signup: criar org → escolher plano → tour de 3 passos
- [ ] Página de billing dentro do app (gerenciar assinatura via componentes Clerk)

Critério de aceite: assinar o plano Pro com cartão de teste e desbloquear módulos.

---

## Sprint 5 — Polimento para lançamento
Objetivo: pronto para os primeiros clientes reais.

- [ ] Resend: emails de boas-vindas, recibo, alerta de estoque baixo
- [ ] Sentry configurado (client + server)
- [ ] PostHog: eventos-chave (criou receita, gerou fatura, viu break-even)
- [ ] next-intl completo: en, es, pt — zero strings hardcoded
- [ ] Landing page pública com proposta de valor + CTA para /pricing
- [ ] Revisão de acessibilidade e responsividade mobile dos módulos principais
- [ ] Checklist de produção: env vars, domínio, backups Neon, página de status

Critério de aceite: convidar 3 chefs beta e eles completarem onboarding sem ajuda.
