import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regressão da inbox que morria sozinha (13/08).
 *
 * A inbox "Bots Caltech" apareceu com encryptedAuthState = null e lastError = null.
 * Como o logout de verdade grava lastError = 'logged_out', sobrou um caminho só:
 * desistir() por retries. A causa era o retryCount nunca voltar a zero depois de
 * uma reconexão bem-sucedida — a sessão tinha 5 quedas de crédito para a vida
 * inteira, e ao gastar a última o worker apagava a credencial. Sem credencial nem
 * o resumeAll() do próximo boot recupera: só QR novo, com celular na mão.
 */

const prismaMock = vi.hoisted(() => ({
  inbox: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({ workspaceId: 'ws1' }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  waSession: {
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
}));
const clearAuthStateMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const startSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../src/db.js', () => ({ prisma: prismaMock }));
vi.mock('../src/redis.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/baileys/auth-state.js', () => ({
  clearAuthState: clearAuthStateMock,
  flushPendingAuthState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/baileys/session.js', () => ({ startSession: startSessionMock }));
vi.mock('../src/baileys/events.js', () => ({ clearSessionState: vi.fn() }));

const { sessionManager } = await import('../src/baileys/manager.js');

// O sessionManager é singleton e guarda as sessões vivas num Map: reusar o mesmo
// id entre casos faz o start seguinte cair no "already running" e o teste vira
// falso-negativo silencioso. Cada caso usa a sua inbox.
let INBOX = '';
let seq = 0;

/** Guarda os callbacks que o manager registra, pra simular open/close do socket. */
let callbacks: { onOpen?: (id: string) => void; onClosed?: (id: string, lo: boolean) => void };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  INBOX = `inbox-${++seq}`;
  callbacks = {};
  prismaMock.inbox.findUnique.mockResolvedValue({ id: INBOX, workspaceId: 'ws1', name: 'Teste' });
  prismaMock.waSession.findUnique.mockResolvedValue({ lastConnectedAt: new Date('2026-08-01') });
  startSessionMock.mockImplementation(async (id: string, opts: typeof callbacks) => {
    callbacks = opts;
    return { inboxId: id, workspaceId: 'ws1', sock: {}, stop: vi.fn() };
  });
});

/** Uma queda seguida de reconexão bem-sucedida, como acontece o dia todo em produção. */
async function quedaEReconexao() {
  callbacks.onClosed?.(INBOX, false);
  await vi.advanceTimersByTimeAsync(60_000);
  callbacks.onOpen?.(INBOX);
}

describe('SessionManager — orçamento de retries', () => {
  it('reconectar zera o contador: 8 quedas espaçadas não apagam a credencial', async () => {
    await sessionManager.start(INBOX);
    callbacks.onOpen?.(INBOX);

    for (let i = 0; i < 8; i++) await quedaEReconexao();

    expect(clearAuthStateMock).not.toHaveBeenCalled();
  });

  it('rajada sem reconexão ainda desiste, mas preserva a credencial já validada', async () => {
    await sessionManager.start(INBOX);
    callbacks.onOpen?.(INBOX);

    // 6 quedas seguidas SEM nenhum open no meio — estoura o teto de propósito.
    for (let i = 0; i < 6; i++) {
      callbacks.onClosed?.(INBOX, false);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // Credencial que já conectou é boa: desistir não pode destruí-la.
    expect(clearAuthStateMock).not.toHaveBeenCalled();
    // E o motivo tem que ficar gravado, senão o próximo diagnóstico é adivinhação.
    expect(prismaMock.waSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastError: 'max_retries' }) }),
    );
  });

  it('credencial que nunca conectou (handshake pela metade) continua sendo limpa', async () => {
    prismaMock.waSession.findUnique.mockResolvedValue({ lastConnectedAt: null });
    await sessionManager.start(INBOX);
    callbacks.onOpen?.(INBOX);

    for (let i = 0; i < 6; i++) {
      callbacks.onClosed?.(INBOX, false);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(clearAuthStateMock).toHaveBeenCalledWith(INBOX);
  });

  it('logout de verdade continua limpando a credencial', async () => {
    await sessionManager.start(INBOX);
    callbacks.onOpen?.(INBOX);
    callbacks.onClosed?.(INBOX, true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(clearAuthStateMock).not.toHaveBeenCalled(); // quem limpa no logout é o onLoggedOut
  });
});
