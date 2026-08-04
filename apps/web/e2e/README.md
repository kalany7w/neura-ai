# E2E (Playwright)

Testes end-to-end do app web. Dois níveis, separados por tag:

- **`@smoke`** — páginas públicas + gate de auth do middleware. Só precisa do
  **web** rodando (sem api/db). É o que roda no CI (`e2e-smoke`).
- **`@fullstack`** — fluxos que batem na API (signup→app, login inválido). Precisa
  do **stack completo** (api + postgres + redis) e `NODE_ENV != production`
  (aí `autoSignIn=true` e não exige verificar email). Pulados por padrão.

## Setup (uma vez)

```bash
pnpm --filter @neura/web test:e2e:install   # baixa o Chromium do Playwright
```

## Rodar

### Smoke (só web)

Contra o web já buildado + `next start`:

```bash
pnpm --filter @neura/web build
pnpm --filter @neura/web start &            # porta 7302
E2E_BASE_URL=http://localhost:7302 pnpm --filter @neura/web test:e2e:smoke
```

Localmente, sem servidor externo, dá pra deixar o Playwright subir o `next dev`:

```bash
E2E_WEB_CMD='pnpm dev' pnpm --filter @neura/web test:e2e:smoke
```

> No Windows, se o Playwright não achar `pnpm` ao subir o webServer, suba o dev
> server à mão e use `E2E_BASE_URL` (como no bloco acima).

### Fullstack (stack completo)

Suba api + web + postgres + redis (ex.: `docker compose -f docker-compose.dev.yml up`

- `pnpm dev`) com `NODE_ENV=test` (ou development) e:

```bash
E2E_FULLSTACK=1 E2E_BASE_URL=http://localhost:7302 pnpm --filter @neura/web test:e2e
```

## Variáveis

| Var               | Efeito                                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`    | URL do app a testar. Se setada, o Playwright NÃO sobe servidor.                       |
| `E2E_WEB_CMD`     | Comando pra subir o web quando `E2E_BASE_URL` não está setada (default `pnpm start`). |
| `E2E_FULLSTACK=1` | Habilita os testes `@fullstack` (senão são pulados).                                  |

## Próximos testes sugeridos

- `@fullstack`: enviar mensagem numa conversa (precisa mockar/conectar uma sessão
  WhatsApp — hoje não automatizável sem um número de teste dedicado).
- Mover card no kanban entre 2 abas e conferir o realtime (WS) refletindo.
- Aplicar etiqueta / atribuir agente e verificar update sem refresh.
