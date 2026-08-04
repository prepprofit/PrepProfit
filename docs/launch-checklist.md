# Launch Checklist — PrepProfit

Estado em 2026-07-07. Itens já concluídos no fim; o que resta está agrupado por criticidade.

## 🔴 Críticos (podem virar incidente)

- [ ] **Rotacionar a senha do Neon (prod)** — a senha foi colada em chats várias vezes.
      Neon Console → branch prod → Reset password → atualizar `DATABASE_URL` no Vercel
      (Production) → redeploy → atualizar `.env.local`.
- [ ] **Testar restore de backup do Neon** — confirmar point-in-time recovery ativo no
      plano atual e fazer um restore real para um branch temporário (backup nunca
      restaurado não é backup).
- [ ] **E2E de checkout real em prod** — signup novo → reverse trial ativo (banner,
      features Business liberadas) → assinar Solo/Pro com cartão real → upgrade →
      downgrade → cancelar → conferir que os limites (`PLAN_LIMITS`) mudam de acordo.
      Incluir: trial expirado cai para Free; pagamento recusado / past-due.

## 🟠 Importantes (antes de tráfego real)

- [ ] **QA de emails** — rodar `npx tsx scripts/send-test-emails.tsx` e conferir todos
      os templates em Gmail + Outlook + mobile; verificar que não caem em spam
      (SPF/DKIM/DMARC do prepprofit.com já verificados no Resend, mas confirmar DMARC).
- [ ] **Crons em prod** — Vercel → Settings → Cron Jobs: confirmar os 5 registrados
      (purge-trash, cfo-report, process-email-outbox, ai-cost-report, trial-reminder)
      e com última execução verde. (Código conferido 2026-07-07: todos têm rota.)
- [ ] **Alertas do Sentry** — criar alert rule (email) para novo issue / pico de erros
      em prod; hoje ninguém é avisado sem abrir o dashboard.
- [ ] **Uptime monitoring externo** — UptimeRobot/BetterStack gratuito apontando para
      a landing e para uma rota autenticável (esperar 200/redirect).
- [ ] **Onboarding limpo** — criar org nova real (sem seed) e passar: empty states de
      todos os módulos, primeiro ingrediente/receita, primeira invoice, foto-extração.
- [ ] **Flows dashboard blocks (§8)** — publicar os blocks no dashboard da Flows
      (pendência do plano flows-onboarding).
- [ ] **Downgrade path** — org com dados acima do limite Free após fim do trial:
      UI degrada bem? Mensagens de limite corretas?
- [ ] **Mobile real** — abrir landing + app num telefone de verdade (donos de
      restaurante usam mobile).

## 🟡 Legal / compliance

- [ ] Termos de Serviço e Política de Privacidade publicados e linkados no footer/signup.
- [ ] **Cookie consent / GDPR** — PostHog com session replay na UE; avaliar banner de
      consentimento ou configurar PostHog para respeitar consent antes do replay.
- [ ] DPA disponível se clientes B2B pedirem (Neon/Vercel/Clerk/Resend/PostHog têm os deles).

## 🟢 Suporte / operação

- [ ] **Ativar Crisp** — setar `NEXT_PUBLIC_CRISP_WEBSITE_ID` no Vercel (o widget já
      está no layout e é no-op sem a var). Decidir se entra no launch.
- [ ] Email de suporte monitorado (info@prepprofit.com ou dedicado) + processo mínimo
      de incidente (quem faz o quê se o site cair).
- [ ] **Quotas dos fornecedores** — conferir limites do plano atual: Resend (envios/mês),
      Gemini (extraction), Neon (compute/storage), Vercel (functions). O que acontece
      num pico de signups?

## ✅ Já feito (não repetir)

- [x] Auditoria de segurança (2026-07-05) — código limpo, CSP enforcing, Clerk live keys.
- [x] Auditoria/otimização de performance dashboard (2026-07-07).
- [x] `npm audit --omit=dev` — 0 vulnerabilidades (reconferido 2026-07-07).
- [x] Sentry em prod, PostHog LIVE com replay, Resend domínio verificado.
- [x] Webhook Clerk prod (incl. `organization.created`) smoke-testado.
- [x] Crons: 5/5 com rota no código (conferido 2026-07-07).
