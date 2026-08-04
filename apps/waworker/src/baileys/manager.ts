import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis.js';
import { startSession, type SessionHandle } from './session.js';
import { clearAuthState, flushPendingAuthState } from './auth-state.js';

interface ManagedSession {
  handle: SessionHandle;
  retryCount: number;
  retryTimer?: NodeJS.Timeout;
}

/**
 * Gerencia o ciclo de vida das sessões Baileys, uma por inbox.
 *
 * As operações de uma mesma inbox são serializadas (`inFlight`) porque start e
 * stop levam segundos e antes podiam se atropelar: um stop chegando durante um
 * start era perdido (a sessão ainda não estava no mapa) e o start seguinte era
 * ignorado por "já existe sessão", deixando a inbox presa em CONNECTING com a
 * API tendo respondido 200. Toda mudança de estado agora também é escrita no
 * banco aqui — antes dependíamos do evento de close do socket, que nem sempre
 * vem quando o encerramento parte de nós.
 */
class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** Operação (start/stop) em andamento por inbox — serializa o ciclo de vida. */
  private inFlight = new Map<string, Promise<void>>();
  /** Inboxes que pediram parada; suprime o retry automático do close. */
  private stopping = new Set<string>();
  /** Retry agendado após falha de start — sem sessão viva associada ainda. */
  private pendingRetries = new Map<string, NodeJS.Timeout>();
  private readonly maxRetries = 5;
  private readonly backoffMs = [1_000, 2_000, 4_000, 8_000, 30_000];

  /** Enfileira a operação atrás do que já estiver rodando para a mesma inbox. */
  private enqueue(inboxId: string, op: () => Promise<void>): Promise<void> {
    const anterior = this.inFlight.get(inboxId) ?? Promise.resolve();
    const proxima = anterior.catch(() => {}).then(op);
    this.inFlight.set(inboxId, proxima);
    void proxima.catch(() => {}).finally(() => {
      if (this.inFlight.get(inboxId) === proxima) this.inFlight.delete(inboxId);
    });
    return proxima;
  }

  private async setStatus(
    inboxId: string,
    status: 'DISCONNECTED' | 'CONNECTING' | 'ERROR',
    motivo?: string,
  ): Promise<void> {
    const inbox = await prisma.inbox
      .update({ where: { id: inboxId }, data: { status }, select: { workspaceId: true } })
      .catch(() => null);
    if (!inbox) return;
    await publishEvent(inbox.workspaceId, 'inboxes', 'inbox.status', {
      inboxId,
      status,
      ...(motivo ? { error: motivo } : {}),
    }).catch(() => {});
  }

  async start(inboxId: string): Promise<void> {
    return this.enqueue(inboxId, async () => {
      this.stopping.delete(inboxId);
      this.cancelPendingRetry(inboxId);
      const atual = this.sessions.get(inboxId);
      if (atual) {
        // Sessão aguardando retry não é sessão viva: cancela o timer e sobe agora,
        // que é o que o usuário pediu ao clicar em Conectar.
        if (atual.retryTimer) {
          clearTimeout(atual.retryTimer);
          this.sessions.delete(inboxId);
        } else {
          logger.warn({ inboxId }, 'Session already running, skipping start');
          return;
        }
      }
      await this.attemptStart(inboxId, 0);
    });
  }

  private async attemptStart(inboxId: string, retryCount: number): Promise<void> {
    if (this.stopping.has(inboxId)) return;
    try {
      const handle = await startSession(inboxId, {
        onLoggedOut: async (id) => {
          logger.warn({ inboxId: id }, 'Inbox logged out, clearing auth');
          await clearAuthState(id);
          this.removeSession(id);
          await this.setStatus(id, 'DISCONNECTED', 'logged_out');
        },
        onClosed: (id, isLoggedOut) => {
          // Parada nossa: o close é consequência, não motivo pra reconectar.
          if (this.stopping.has(id)) return;
          if (isLoggedOut) {
            // Auth limpa em onLoggedOut; não reconecta
            this.removeSession(id);
            return;
          }
          this.scheduleRetry(id);
        },
      });

      // A inbox pode ter pedido stop enquanto o socket subia.
      if (this.stopping.has(inboxId)) {
        handle.stop();
        await flushPendingAuthState(inboxId);
        return;
      }

      this.sessions.set(inboxId, { handle, retryCount });
      logger.info({ inboxId, retryCount }, 'Session started');
    } catch (err) {
      logger.error({ err, inboxId, retryCount }, 'Failed to start session');
      if (this.stopping.has(inboxId)) return;
      if (retryCount < this.maxRetries) {
        const delay = this.backoffMs[Math.min(retryCount, this.backoffMs.length - 1)] ?? 30_000;
        // Registrado para que um stop/start posterior consiga cancelá-lo — antes
        // esse timer ficava solto e ressuscitava sessões já descartadas.
        this.pendingRetries.set(
          inboxId,
          setTimeout(() => {
            this.pendingRetries.delete(inboxId);
            void this.attemptStart(inboxId, retryCount + 1);
          }, delay),
        );
      } else {
        await this.desistir(inboxId, 'start_failed');
      }
    }
  }

  /**
   * Fim da linha das tentativas. Zera o auth state antes de liberar a inbox:
   * uma sessão interrompida no meio do handshake deixa credenciais pela metade,
   * e o Baileys passa a tentar retomá-las em vez de emitir QR — a inbox ficava
   * inconectável para sempre, sem saída pela interface. Sem credencial, o
   * próximo "Conectar" volta a gerar QR.
   */
  private async desistir(inboxId: string, motivo: string): Promise<void> {
    logger.error({ inboxId, motivo }, 'Giving up on session, clearing auth state');
    this.cancelPendingRetry(inboxId);
    this.removeSession(inboxId);
    await clearAuthState(inboxId).catch(() => {});
    await this.setStatus(inboxId, 'DISCONNECTED', motivo);
  }

  private scheduleRetry(inboxId: string): void {
    const current = this.sessions.get(inboxId);
    if (!current) return;
    const nextRetry = current.retryCount + 1;
    if (nextRetry > this.maxRetries) {
      logger.error({ inboxId }, 'Max retries exhausted, giving up');
      void this.desistir(inboxId, 'max_retries');
      return;
    }
    const delay = this.backoffMs[Math.min(nextRetry - 1, this.backoffMs.length - 1)] ?? 30_000;
    logger.info({ inboxId, nextRetry, delayMs: delay }, 'Scheduling reconnect');
    current.retryTimer = setTimeout(() => {
      this.sessions.delete(inboxId);
      void this.attemptStart(inboxId, nextRetry);
    }, delay);
  }

  async stop(inboxId: string): Promise<void> {
    return this.enqueue(inboxId, async () => {
      this.stopping.add(inboxId);
      try {
        this.cancelPendingRetry(inboxId);
        const current = this.sessions.get(inboxId);
        if (current) {
          if (current.retryTimer) clearTimeout(current.retryTimer);
          current.handle.stop();
          this.sessions.delete(inboxId);
        }
        // Flush qualquer save de auth state pendente antes de soltar
        await flushPendingAuthState(inboxId);
        // Importa lazily pra evitar circular com baileys/events
        const { clearSessionState } = await import('./events.js');
        clearSessionState(inboxId);
        // O status vinha só do evento de close do socket, que não é garantido
        // quando somos nós encerrando — a inbox ficava presa em CONNECTING.
        await this.setStatus(inboxId, 'DISCONNECTED');
        logger.info({ inboxId }, 'Session stopped');
      } finally {
        this.stopping.delete(inboxId);
      }
    });
  }

  /** stop + start sequenciais no worker (a fila garante a ordem). */
  async restart(inboxId: string): Promise<void> {
    await this.stop(inboxId);
    await this.start(inboxId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  /**
   * Encerramento do PROCESSO (deploy/restart): fecha sockets e persiste auth,
   * mas NÃO grava DISCONNECTED — o status fica CONNECTED/CONNECTING pra
   * resumeAll() da próxima instância retomar sozinho. stop() continua sendo o
   * desligamento intencional (usuário), esse sim marca DISCONNECTED.
   * Sem essa distinção, todo deploy derrubava as sessões de vez: stopAll
   * escrevia DISCONNECTED e o boot novo pulava as inboxes.
   */
  async shutdownAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((inboxId) =>
        this.enqueue(inboxId, async () => {
          this.stopping.add(inboxId);
          try {
            this.cancelPendingRetry(inboxId);
            const current = this.sessions.get(inboxId);
            if (current) {
              if (current.retryTimer) clearTimeout(current.retryTimer);
              current.handle.stop();
              this.sessions.delete(inboxId);
            }
            await flushPendingAuthState(inboxId);
            const { clearSessionState } = await import('./events.js');
            clearSessionState(inboxId);
            logger.info({ inboxId }, 'Session closed for process shutdown');
          } finally {
            this.stopping.delete(inboxId);
          }
        }),
      ),
    );
  }

  private cancelPendingRetry(inboxId: string): void {
    const timer = this.pendingRetries.get(inboxId);
    if (timer) {
      clearTimeout(timer);
      this.pendingRetries.delete(inboxId);
    }
  }

  private removeSession(inboxId: string): void {
    const current = this.sessions.get(inboxId);
    if (current?.retryTimer) clearTimeout(current.retryTimer);
    this.sessions.delete(inboxId);
  }

  get(inboxId: string): SessionHandle | undefined {
    return this.sessions.get(inboxId)?.handle;
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Restaura sessões de inboxes que estavam CONNECTED ou CONNECTING ao último shutdown.
   * ERROR entra também: inbox que caiu com credencial salva (ex.: 405 por versão WA
   * velha do Baileys, 28/07) deve voltar sozinha num deploy corrigido, sem QR novo.
   */
  async resumeAll(): Promise<void> {
    const inboxes = await prisma.inbox.findMany({
      where: {
        status: { in: ['CONNECTED', 'CONNECTING', 'AWAITING_QR', 'ERROR'] },
        waSession: { is: { encryptedAuthState: { not: null } } },
      },
      select: { id: true },
    });
    logger.info({ count: inboxes.length }, 'Resuming sessions');
    for (const inbox of inboxes) {
      this.start(inbox.id).catch((err) =>
        logger.error({ err, inboxId: inbox.id }, 'Resume failed'),
      );
    }
  }
}

export const sessionManager = new SessionManager();
