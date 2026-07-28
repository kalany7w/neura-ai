# Suíte end-to-end

Estes scripts batem numa instância **de verdade** (API + banco + Redis), com uma conta real, e
exercitam o produto do jeito que um cliente usa. Não são testes unitários e não rodam no CI comum —
o CI não tem uma instância completa com canais conectados.

Nasceram do QA de 28/07/2026, que encontrou cinco defeitos que a suíte unitária não pegava. Cada
um deles virou caso de teste aqui, e é por isso que a pasta existe: para que não voltem.

## Como rodar

Precisa de uma conta na instância alvo e de um workspace descartável — os scripts **escrevem**
(criam contatos, inboxes, conversas, políticas). Nunca aponte para o workspace de um cliente.

```bash
export QA_API_URL=https://api.exemplo.net
export QA_APP_URL=https://app.exemplo.net
export QA_EMAIL=conta-de-teste@exemplo.com
export QA_PASS='senha-da-conta'
node run.mjs
```

| Script | O que cobre | Observação |
|---|---|---|
| `run.mjs` | 158 casos por toda a API: contatos, kanban, templates, base de conhecimento, automações, SLA, CSAT, calendário, relatórios, chaves de API, webhooks, limites de validação, isolamento entre workspaces | O mais completo; roda em ~3 min |
| `rbac.mjs` | Convite por e-mail ponta a ponta e os bloqueios de permissão de um agente com sessão real | Exige um segundo e-mail em `QA_EMAIL_AGENT` e o token do convite como argumento |
| `fase3.mjs` | Redefinição de senha, WebSocket e isolamento direto entre agentes | Recebe a senha do agente como argumento |
| `regressao.mjs` | Os cinco defeitos de 28/07 — rode este depois de todo deploy | O mais curto e o mais importante |

## Os defeitos que este código guarda

1. **Webchat com e-mail repetido devolvia 500.** Dois visitantes informando o mesmo e-mail
   colidiam no unique `(workspaceId, email)` e o widget morria. `regressao.mjs` cobre inclusive a
   rajada concorrente.
2. **Sessão de WhatsApp travava sem QR.** Conectar, desconectar e conectar de novo prendia a inbox
   em `CONNECTING`, depois `ERROR`, sem volta nem pelo botão Reconectar.
3. **Editar política de SLA descartava a configuração salva** (era `useState` onde devia ser
   `useEffect`) — coberto na parte de interface, em `regressao-ui.mjs` no scratchpad do QA.
4. **Som de notificação nunca tocou** — a política de segurança do navegador bloqueava a fonte e o
   arquivo era silêncio; não dá para cobrir por script, verifique no navegador.
5. **A interface era inutilizável no celular** — idem, verificação visual.

## Aviso

`run.mjs` cria bastante coisa e não limpa tudo (é de propósito: dá para inspecionar o resultado
depois). Use um workspace de QA dedicado e apague quando quiser.
