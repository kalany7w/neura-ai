# Welcome Flow + Auto-Routing + Lead Detail Enriquecido — Design

**Data**: 2026-05-26
**Autor**: Kalan + Claude (brainstorming sessão dede3b5b)
**Status**: Design aprovado, pronto pra `/gsd:plan-phase`

## Contexto

Hoje quando um cliente manda primeira mensagem pra um inbox de Neura, ele cai numa conversa nova que vai pro funil default da inbox sem classificação automática. Atendente humano precisa abrir, ler, classificar manual, mover de funil se for o caso.

Vamos automatizar a entrada:

1. **Cliente manda primeira mensagem** → bot ("Agente IA") responde com menu de opções (Compra / Manutenção / Reparação / etc).
2. **Cliente escolhe uma opção** → sistema aplica tag automático + cria card no funil correto.
3. **Atendente abre a conversa** → vê histórico completo + painel lateral tipo Kommo (atributos, etiquetas, embudo atual, dados do contato, ações rápidas).

Resultado esperado: classificação automática reduz tempo de qualificação do agente, conversas chegam pré-organizadas no kanban correto, painel lateral mostra contexto sem fazer scroll ou abrir modais.

## Decisões de produto (confirmadas com Kalan)

| # | Pergunta | Decisão |
|---|---|---|
| 1 | Cliente já conhecido volta a escrever — re-disparar welcome? | Não. Welcome dispara uma vez por contato. Check via `Contact.welcomeRespondedAt`. |
| 2 | Cliente responde algo fora das opções | 1ª vez: re-enviar prompt com prefixo "Não entendi". 2ª vez: aplicar tag default + soltar pra humano. |
| 3 | Cliente já tem card e novo tag rotearia pra outro funil | Criar card paralelo no novo funil. Nunca mover card existente. |
| 4 | Sender do welcome | "Agente IA" — novo `sender_type` enum, avatar configurável por workspace. |
| 5 | Formato do menu | Híbrido: tentar `listMessage` interativo do Baileys. Fallback automático pra texto plano numerado após N minutos sem resposta. |
| 6 | Cliente responde com áudio | Transcrever com Whisper (`OPENAI_API_KEY` já configurada) antes de matchear opções. |

## Arquitetura de alto nivel

```
[Cliente WhatsApp] --(primeira msg)--> [waworker/Baileys]
                                              |
                                              v
                                       [api: services/welcome-flow.ts]
                                              |
                                              | 1. Checa se Contact.welcomeRespondedAt IS NULL
                                              | 2. Lê WelcomeFlow da inbox
                                              | 3. Marca Conversation.isAwaitingWelcomeChoice = true
                                              | 4. Enfileira envio do listMessage via BullMQ
                                              v
                                       [waworker: envia listMessage via Baileys]
                                              |
                                              v
                                       [Cliente recebe menu interativo]
                                              |
                                              v (cliente escolhe / responde / fica em silêncio)
                                              |
   ┌──────────────────────────────────────────┼──────────────────────────────────────────┐
   v                                          v                                          v
[buttonReply chega]                  [texto/áudio chega]                        [timeout sem resposta]
   |                                          |                                          |
   v                                          v                                          v
[welcome-parser:                     [welcome-parser:                          [welcome-flow:
 match.exact via                      transcribe se áudio,                      reenvia em texto plano
 selectedDisplayText]                 match.number / keywords /                 (1 vez), depois rede)
                                      fuzzy via OpenAI]
   |                                          |                                          |
   └─────────────┬────────────────────────────┘                                          │
                 v                                                                       │
        [Option matched ou attempt=2]                                                    │
                 |                                                                       │
                 v                                                                       │
        [auto-routing.ts:                                                                │
         applyTagWithRouting]                                                            │
                 |                                                                       │
                 v                                                                       │
        [Aplica Label + cria Card no                                                     │
         (targetFunnel, targetStage)                                                     │
         se ainda não existe]                                                            │
                 |                                                                       │
                 v                                                                       │
        [WS broadcast:                                                                   │
         card.created,                                                                   │
         conversation.label_applied,                                                     │
         conversation.welcome_completed]                                                  │
                                                                                         │
                                                              [fallback após 2 attempts]<┘
                                                                       |
                                                                       v
                                                              [Aplica fallbackLabel,
                                                               isAwaitingWelcomeChoice = false,
                                                               conversa fica disponível pra
                                                               agente humano sem rota específica]
```

## Mudanças de schema (Prisma)

### Novos models

```prisma
model WelcomeFlow {
  id                      String   @id @default(cuid())
  workspaceId             String
  inboxId                 String   @unique  // 1 flow por inbox
  prompt                  String   @db.Text  // texto do menu (suporta placeholders {{contact.name}})
  fallbackLabelId         String?            // tag default se nenhuma opção matchear após maxAttempts
  fallbackFunnelId        String?            // funil default pro fallback (opcional)
  fallbackStageId         String?            // stage default pro fallback (opcional)
  fallbackTimeoutMinutes  Int      @default(2)  // 0 = nunca cai pra texto plano
  maxAttempts             Int      @default(2)  // quantas tentativas antes de fallback humano
  enabled                 Boolean  @default(true)
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  workspace      Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  inbox          Inbox           @relation(fields: [inboxId], references: [id], onDelete: Cascade)
  fallbackLabel  Label?          @relation("WelcomeFlowFallbackLabel", fields: [fallbackLabelId], references: [id], onDelete: SetNull)
  fallbackFunnel Funnel?         @relation("WelcomeFlowFallbackFunnel", fields: [fallbackFunnelId], references: [id], onDelete: SetNull)
  fallbackStage  Stage?          @relation("WelcomeFlowFallbackStage", fields: [fallbackStageId], references: [id], onDelete: SetNull)
  options        WelcomeOption[]

  @@index([workspaceId])
  @@map("welcome_flows")
}

model WelcomeOption {
  id              String   @id @default(cuid())
  flowId          String
  position        Int                 // ordem no menu (1, 2, 3...). Único por flow.
  label           String              // texto exibido ao cliente (ex: "Compra")
  description     String?             // subtexto opcional pra listMessage (ex: "Quero comprar um produto")
  matchKeywords   String[]            // palavras que também matcheam fora do número (ex: ["comprar", "quero comprar", "interessado"])
  targetLabelId   String              // tag aplicada quando matchea
  targetFunnelId  String?             // funil pro qual criar card (nullable: só aplica tag, sem card novo)
  targetStageId   String?             // stage inicial dentro do funil
  createdAt       DateTime @default(now())

  flow         WelcomeFlow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  targetLabel  Label       @relation("WelcomeOptionLabel", fields: [targetLabelId], references: [id], onDelete: Restrict)
  targetFunnel Funnel?     @relation("WelcomeOptionFunnel", fields: [targetFunnelId], references: [id], onDelete: SetNull)
  targetStage  Stage?      @relation("WelcomeOptionStage", fields: [targetStageId], references: [id], onDelete: SetNull)

  @@unique([flowId, position])
  @@index([flowId])
  @@map("welcome_options")
}
```

### Models existentes — colunas novas

```prisma
// Contact
model Contact {
  // ...existente
  welcomeRespondedAt DateTime?  // null = nunca respondeu welcome. Check antes de disparar.
}

// Conversation
model Conversation {
  // ...existente
  isAwaitingWelcomeChoice Boolean @default(false)
  welcomeAttempts         Int     @default(0)
  welcomeFallbackSent     Boolean @default(false)  // pra não mandar texto plano múltiplas vezes
  welcomeSentAt           DateTime?  // pra calcular timeout
}

// Label
model Label {
  // ...existente
  routesToFunnelId String?  // se setado, aplicar este tag cria/move card pra (funnel, stage)
  routesToStageId  String?
  routesToFunnel Funnel? @relation("LabelRoutesToFunnel", fields: [routesToFunnelId], references: [id], onDelete: SetNull)
  routesToStage  Stage?  @relation("LabelRoutesToStage", fields: [routesToStageId], references: [id], onDelete: SetNull)
}

// Workspace
model Workspace {
  // ...existente — adicionar em settings JSON ou coluna dedicada:
  // aiAgentName     String   @default("Agente IA")
  // aiAgentAvatarUrl String?
}
```

### Enum extensão

```prisma
// Adicionar em MessageType ou criar enum novo MessageSenderType:
enum MessageSender {
  CUSTOMER   // mensagem que veio do cliente
  AGENT      // mensagem mandada por agente humano
  AI_AGENT   // mensagem mandada pelo bot (welcome flow, auto-resolve, sugestões aceitas)
  SYSTEM     // notificação interna (ex: "Conversa atribuída a X")
}

// Message ganha:
model Message {
  // ...existente
  senderType MessageSender @default(CUSTOMER)
  // sender pode continuar nullable pra CUSTOMER, mas AI_AGENT/SYSTEM não tem userId
}
```

## Serviços backend

### `apps/api/src/services/welcome-flow.ts` (novo)

Responsabilidades:
- `shouldTriggerWelcome(conversation, contact)`: retorna boolean. Checa: contact.welcomeRespondedAt IS NULL, flow da inbox está enabled, conversa não está awaiting já.
- `triggerWelcome(conversation)`: marca `isAwaitingWelcomeChoice = true`, `welcomeSentAt = now`, enfileira job BullMQ no waworker pra enviar `listMessage`.
- `retryWelcomeAsText(conversation)`: se passou `fallbackTimeoutMinutes`, enfileira reenvio em texto plano numerado. Marca `welcomeFallbackSent = true`.
- `markWelcomeFailed(conversation)`: aplica fallbackLabel, marca `isAwaitingWelcomeChoice = false`, registra audit log.
- `markWelcomeCompleted(conversation, option)`: chama auto-routing, marca `contact.welcomeRespondedAt = now`, `conversation.isAwaitingWelcomeChoice = false`.

### `apps/api/src/services/welcome-parser.ts` (novo)

Responsabilidades:
- `parseReply(conversation, message)`: detecta a opção escolhida.
  - Se `message.type === 'BUTTON_REPLY'` (vem com `selectedDisplayText` ou `selectedRowId` do Baileys): match exato com `WelcomeOption.label` ou `WelcomeOption.id`.
  - Se `message.type === 'AUDIO'`: chama `transcribeAudio(message)` do serviço existente, parseia a transcrição.
  - Se `message.type === 'TEXT'`:
    1. Tenta matchear número (`"1"`, `"2"`, `"1."`) contra `WelcomeOption.position`.
    2. Tenta matchear texto normalizado contra `WelcomeOption.label` (case-insensitive).
    3. Tenta matchear contra qualquer `WelcomeOption.matchKeywords` (substring match).
    4. Fallback: chama OpenAI `gpt-4o-mini` com prompt curto "Cliente disse X, opções são [...]. Qual escolheu? Retorne só o número ou 'nenhuma'."
- `incrementAttempt(conversation)`: incrementa `welcomeAttempts`. Se `>= maxAttempts`, chama `markWelcomeFailed`.

### `apps/api/src/services/auto-routing.ts` (novo)

Responsabilidades:
- `applyTagWithRouting(conversationId, labelId, source)`: 
  - Aplica `ConversationLabel`.
  - Se a label tem `routesToFunnelId`:
    - Verifica se já existe Card ativo (não won/lost) dessa conversa nesse funil. Se sim, no-op (idempotente).
    - Se não, cria Card no funnel/stage configurado.
  - Audit log: `card.auto_routed` com `triggered_by` = `source` (`'welcome_flow'` | `'manual_tag'` | `'rule'`).
  - WS broadcast: `conversation.label_applied`, `card.created` se card criado.

### `apps/api/src/services/welcome-scheduler.ts` (novo)

Worker periódico (cron BullMQ a cada 30s):
- Busca conversas com `isAwaitingWelcomeChoice = true` e `welcomeFallbackSent = false` cujo `welcomeSentAt` é mais antigo que `fallbackTimeoutMinutes`.
- Pra cada uma, chama `welcome-flow.retryWelcomeAsText`.

### `apps/waworker/src/queue/welcome.ts` (novo)

Handler BullMQ no waworker pra enviar o listMessage via Baileys:
- Recebe `{ conversationId, options, prompt }`.
- Monta payload `interactiveMessage` ou `listMessage` da Baileys API.
- Envia. Se falhar com error específico de "interactive não suportado", retorna erro pro api, que cai em fallback texto plano imediato.

## Endpoints API (Hono routes)

### `apps/api/src/routes/welcome-flows.ts` (novo)

```
GET    /api/inboxes/:inboxId/welcome-flow         -> read (com options)
POST   /api/inboxes/:inboxId/welcome-flow         -> create
PUT    /api/inboxes/:inboxId/welcome-flow         -> update (prompt, fallback config)
DELETE /api/inboxes/:inboxId/welcome-flow         -> disable (não delete, soft via enabled=false)

POST   /api/welcome-flows/:flowId/options         -> add option
PUT    /api/welcome-flows/:flowId/options/:id     -> update option
DELETE /api/welcome-flows/:flowId/options/:id     -> remove option

POST   /api/welcome-flows/:flowId/test            -> envia welcome pra um número de teste (phone no body)
```

Permissões: admin + supervisor podem ler/escrever. Agent só lê.

### Atualizações em routes existentes

- `routes/labels.ts`: adicionar campos `routesToFunnelId`, `routesToStageId` no create/update.
- `routes/conversations.ts`: incluir `welcomeAttempts`, `isAwaitingWelcomeChoice` no GET pra UI poder mostrar estado.
- `routes/inbound.ts` ou wherever a primeira mensagem do cliente é processada: hook `shouldTriggerWelcome` → `triggerWelcome` se aplicável.
- `routes/messages.ts` (no handler de inbound): se `conversation.isAwaitingWelcomeChoice`, rotear pro `welcome-parser` antes do flow normal.

## UI Frontend (Next.js)

### Página nova: `apps/web/src/app/(app)/settings/welcome-flows/page.tsx`

Lista de inboxes do workspace com:
- Nome da inbox + número.
- Status do welcome flow: ativo (verde) / inativo (cinza) / não configurado (laranja).
- Quantidade de opções.
- Botão "Editar" → vai pra `/settings/welcome-flows/[inboxId]`.

### Página nova: `apps/web/src/app/(app)/settings/welcome-flows/[inboxId]/page.tsx`

Editor com:
- Toggle "Ativo" geral.
- Textarea do prompt (com preview de como vai sair em WhatsApp, suporta `{{contact.name}}` se nome existir).
- Lista de opções drag-drop (`@dnd-kit`):
  - Campo `label` (texto exibido).
  - Campo `description` (opcional).
  - Multi-tag `matchKeywords`.
  - Select `targetLabel` (carrega `Label[]` do workspace).
  - Select `targetFunnel` + `targetStage` (cascata).
- Sessão "Fallback":
  - Select `fallbackLabel` (tag default se ninguém matchea).
  - Select `fallbackFunnel` + `fallbackStage`.
  - Input numérico `fallbackTimeoutMinutes` (default 2, mostrar tooltip explicando).
  - Input numérico `maxAttempts` (default 2).
- Botão "Enviar teste pra meu número": input phone + envia preview real.
- Botão "Salvar" (com `isSubmitting`).

### Atualização: `apps/web/src/app/(app)/settings/labels/page.tsx`

Adicionar no form de criar/editar label:
- Select opcional "Funil destino" (`routesToFunnelId`).
- Select opcional "Etapa inicial" (`routesToStageId`, cascata do funil).

Indicador visual na lista: chip pequeno "→ Vendas / Lead" se a label tem routing configurado.

### Atualização: `apps/web/src/components/inbox/conversation-side-panel.tsx`

Refactor pra layout estilo Kommo:
- Header: avatar (com badge "Agente IA" se aplicável), nome, telefone clicável, status badge (CALIENTE/TIBIO/FRIO derivado do SLA).
- Seção colapsável **Embudo**: nome do funil + stage atual + select pra mover stage inline.
- Seção colapsável **Atributos**: render automático de todos `CustomAttributeDef` do workspace com valores editáveis inline.
- Seção colapsável **Etiquetas**: chips clicáveis (toggle add/remove direto).
- Seção colapsável **Contato**: nome, telefone, email, outros campos editáveis.
- Seção colapsável **Produtos** (se card tem): editar inline.
- Botão **Resumir** chama `ai-summarize` existente e mostra summary no modal.
- Botões inferiores: "Cerrar conversación", "Marque resuelto", "Snooze" (quando Fase 8).

Loading states com skeleton. Mutations otimistas via react-query. WS subscribe a `contact.updated`, `conversation.label_applied`, `card.moved`.

### Endpoint pro side panel: `apps/api/src/routes/conversations.ts`

Adicionar `GET /api/conversations/:id/lead-detail`:
- Retorna contact + custom attributes (def + values) + labels + card atual + funnel + stage + summary IA cached + welcome state — tudo em uma query única pra evitar round-trips.

### Atualização: Chat timeline

`apps/web/src/components/inbox/conversation-chat.tsx` (ou onde estiver):
- Separadores visuais de dia (`Hoje`, `Ontem`, `Segunda 18 de maio`).
- Botão flutuante "Ir pra última mensagem" quando scroll não está no fundo + chegou msg nova.
- Linha "Lido até aqui" entre msgs novas e antigas desde última visita.
- Carga inicial: últimos 7 dias OU últimas 100 mensagens (o que for maior).
- Mensagens com `senderType = AI_AGENT` renderizam com avatar específico (estrelas/badge) e estilo distinto.

## Edge cases tratados

| Caso | Comportamento |
|---|---|
| Cliente conhecido (welcomeRespondedAt set) volta a escrever | Welcome não dispara. Conversa vai pro funil default da inbox como hoje. |
| Cliente manda 5 mensagens seguidas antes de responder | Welcome envia só uma vez (idempotência via `isAwaitingWelcomeChoice` flag). |
| Cliente responde "1" e a opção 1 existe | Match imediato, aplica tag, cria card, marca `welcomeRespondedAt`. |
| Cliente responde "quero comprar" sem número | Match por keyword "comprar". |
| Cliente responde "olá" (texto fora) | Attempt 1: re-envia prompt com prefixo "Não entendi, escolha:". Attempt 2: aplica fallbackLabel, libera pra humano. |
| Cliente manda áudio | Transcreve com Whisper, processa transcrição como texto. |
| Cliente manda imagem ou doc durante welcome | Considera attempt sem match. Não tenta interpretar mídia. |
| `listMessage` não chega no cliente (sem button reply em N min) | Worker periódico detecta `welcomeSentAt > timeout && !welcomeFallbackSent`, reenvia em texto plano. |
| Cliente já tem card em funil X e agora matcheou opção pro funil Y | Cria card paralelo em funil Y. Card de funil X fica intocado. |
| Cliente desconecta WhatsApp no meio (msg falha) | Job BullMQ retry com backoff. Após N falhas, marca welcome como falhado, libera conversa. |
| Admin desabilita welcome flow no meio de uma conversa awaiting | Conversa fica awaiting até cliente responder ou timeout. Welcome desabilitado só afeta novas conversas. |
| Workspace tem 0 funis ou 0 labels configurados | UI bloqueia ativação do welcome flow com mensagem "Configure pelo menos 1 funil e 1 label antes". |

## Tests

### Unit
- `welcome-parser`: matchea número, texto exato, keyword, texto via OpenAI mock (não rodar OpenAI em CI).
- `auto-routing`: idempotência (chamar 2x não cria 2 cards), edge case sem `routesToFunnelId`.
- `welcome-flow.shouldTriggerWelcome`: todas as combinações de flags.

### Integration
- Conversa nova: simula primeira mensagem inbound → confirma que job BullMQ é enfileirado.
- Reply com "2" → confirma aplicação de tag + card criado no funil correto.
- Reply fora de opções 2x → confirma fallbackLabel aplicada.
- Welcome flow desabilitado: confirma que primeira msg não dispara nada.

### E2E (Playwright)
- Admin entra em `/settings/welcome-flows`, configura flow com 3 opções, salva.
- Simula recebimento de inbound (via mock waworker) → vê welcome ser enviado.
- Simula reply "1" → vê tag aplicado e card criado no kanban no funil esperado.
- Testa fallback: reply "xyz" 2x → vê fallback aplicado.

## Ordem de implementação

### Fase A — Backend do welcome flow (sem UI ainda)
**Estimativa**: 3-4 dias

1. Migration Prisma: novos models + colunas novas em models existentes.
2. `services/welcome-flow.ts` com `shouldTriggerWelcome`, `triggerWelcome`, `markWelcomeCompleted`, `markWelcomeFailed`.
3. `services/welcome-parser.ts` com parser de número/keyword/texto.
4. `services/auto-routing.ts` com `applyTagWithRouting`.
5. Hook em `routes/inbound.ts` ou onde processa msg nova.
6. Hook em `routes/messages.ts` pra rotear inbound em `isAwaitingWelcomeChoice` pro parser.
7. `services/welcome-scheduler.ts` cron BullMQ pra fallback texto plano.
8. `apps/waworker/src/queue/welcome.ts` pra envio via Baileys listMessage.
9. Audit log entries em todos os pontos.
10. WS events.
11. Testes unit + integration.

Critério de aceite Fase A: 
- Endpoint admin pode criar/editar welcome flow via curl com payload manual.
- Simulação de inbound dispara welcome via mock waworker.
- Reply de cliente é parseado e ações executadas corretamente.

### Fase B — Routes API + UI de configuração
**Estimativa**: 2-3 dias

1. `routes/welcome-flows.ts` completo (GET/POST/PUT/DELETE + test endpoint).
2. Atualização `routes/labels.ts` com campos routing.
3. Página `/settings/welcome-flows` (lista por inbox).
4. Página `/settings/welcome-flows/[inboxId]` (editor completo).
5. Atualização `/settings/labels` (campos routing no form).
6. Test mode funcional (botão "enviar teste pra meu número").

Critério de aceite Fase B:
- Admin configura welcome flow inteiro só pela UI.
- Test mode envia mensagem real pro número de teste.

### Fase C — Lead detail panel + chat timeline
**Estimativa**: 3-4 dias

1. Endpoint `GET /api/conversations/:id/lead-detail`.
2. Refactor `conversation-side-panel.tsx` com layout Kommo.
3. Mutations otimistas + WS subscriptions.
4. Separadores de dia no chat.
5. Botão "ir pra última msg" + linha "lido até aqui".
6. Carga inicial 7 dias / 100 msgs.
7. Render diferenciado de `senderType = AI_AGENT`.

Critério de aceite Fase C:
- Side panel mostra toda info do lead sem precisar abrir modal.
- Chat scroll mostra contexto histórico decente sem lentidão.
- Mensagens do bot são visualmente distinguíveis das humanas.

### Fase D — Test mode + onboarding wizard + polish
**Estimativa**: 1-2 dias

1. Onboarding wizard ao criar inbox nova: "Configurar welcome flow agora?".
2. Presets sugeridos (e-commerce, serviços, suporte técnico).
3. Validações de UI (mín 1 opção, máx 10 pra listMessage).
4. Empty states / loading states polidos.

**Total estimado**: 9-13 dias úteis.

## Constraints e não-objetivos

- Não implementar disparo em massa (Baileys baneia número).
- Não substituir lógica de `AutomationRule` existente (welcome flow é caso específico, não rule genérica).
- Não permitir mais de 10 opções por flow (limite Baileys listMessage).
- Não suportar welcome flow multilíngue na Fase A-D. Idioma é o do workspace (PT-BR). Multi-idioma fica pra fase futura.
- Não tentar reconectar conversas órfãs antigas com welcome retroativo. Welcome só dispara em conversas novas a partir do deploy desta feature.

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Baileys interactive messages podem parar de funcionar (Meta restringe) | Fallback automático a texto plano numerado já no design. |
| OpenAI down e fuzzy match falha | Cair pra fallbackLabel após attempts. Não bloquear o flow. |
| Cliente fica permanentemente em `isAwaitingWelcomeChoice` se algo der erro | Worker periódico de cleanup: após 24h em awaiting, força fallback. |
| Welcome dispara em conversa de teste interna do agente | Welcome só dispara em mensagem inbound (direção CUSTOMER), não em mensagens criadas internamente. |
| Migration adiciona colunas nullable, sem impacto em dados existentes | `welcomeRespondedAt` nullable, `welcomeAttempts` default 0, `isAwaitingWelcomeChoice` default false. Backfill desnecessário. |

## Próximos passos

1. Kalan revisa este spec.
2. Ajustes inline se necessário.
3. Commit do spec.
4. `/gsd:plan-phase` pra Fase A (backend welcome flow).
5. Execução Fase A.
6. Iterar Fases B → C → D conforme review.
