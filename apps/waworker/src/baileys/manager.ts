import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { sendAlert } from '../alert.js';
import { startSession, type SessionHandle } from './session.js';
import { clearAuthState, flushPendingAuthState } from './auth-state.js';

interface ManagedSession {
  handle: SessionHandle;
  retryCount: number;
  retryTimer?: NodeJS.Timeout;
}

class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly maxRetries = 5;
  private readonly backoffMs = [1_000, 2_000, 4_000, 8_000, 30_000];

  async start(inboxId: string): Promise<void> {
    if (this.sessions.has(inboxId)) {
      logger.warn({ inboxId }, 'Session already running, skipping start');
      return;
    }
    await this.attemptStart(inboxId, 0);
  }

  private async attemptStart(inboxId: string, retryCount: number): Promise<void> {
    try {
      const handle = await startSession(inboxId, {
        onLoggedOut: async (id) => {
          logger.warn({ inboxId: id }, 'Inbox logged out, clearing auth');
          await clearAuthState(id);
          this.removeSession(id);
          void sendAlert('warn', 'Inbox WhatsApp deslogado — precisa reconectar (novo QR)', {
            inboxId: id,
          });
        },
        onClosed: (id, isLoggedOut) => {
          if (isLoggedOut) {
            // Auth limpa em onLoggedOut; não reconecta
            this.removeSession(id);
            return;
          }
          this.scheduleRetry(id);
        },
      });

      this.sessions.set(inboxId, { handle, retryCount });
      logger.info({ inboxId, retryCount }, 'Session started');
    } catch (err) {
      logger.error({ err, inboxId, retryCount }, 'Failed to start session');
      if (retryCount < this.maxRetries) {
        const delay = this.backoffMs[Math.min(retryCount, this.backoffMs.length - 1)] ?? 30_000;
        setTimeout(() => this.attemptStart(inboxId, retryCount + 1), delay);
      } else {
        await prisma.inbox
          .update({ where: { id: inboxId }, data: { status: 'ERROR' } })
          .catch(() => {});
        void sendAlert('error', 'Sessão Baileys falhou ao iniciar (retries esgotados)', {
          inboxId,
          retries: retryCount,
        });
      }
    }
  }

  private scheduleRetry(inboxId: string): void {
    const current = this.sessions.get(inboxId);
    if (!current) return;
    const nextRetry = current.retryCount + 1;
    if (nextRetry > this.maxRetries) {
      logger.error({ inboxId }, 'Max retries exhausted, giving up');
      this.removeSession(inboxId);
      prisma.inbox
        .update({ where: { id: inboxId }, data: { status: 'ERROR' } })
        .catch(() => {});
      void sendAlert('error', 'Sessão Baileys caiu e esgotou os retries de reconexão', {
        inboxId,
        maxRetries: this.maxRetries,
      });
      return;
    }
    const delay = this.backoffMs[Math.min(nextRetry - 1, this.backoffMs.length - 1)] ?? 30_000;
    logger.info({ inboxId, nextRetry, delayMs: delay }, 'Scheduling reconnect');
    current.retryTimer = setTimeout(() => {
      this.sessions.delete(inboxId);
      this.attemptStart(inboxId, nextRetry);
    }, delay);
  }

  async stop(inboxId: string): Promise<void> {
    const current = this.sessions.get(inboxId);
    if (!current) return;
    if (current.retryTimer) clearTimeout(current.retryTimer);
    current.handle.stop();
    this.sessions.delete(inboxId);
    // Flush qualquer save de auth state pendente antes de soltar
    await flushPendingAuthState(inboxId);
    // Importa lazily pra evitar circular com baileys/events
    const { clearSessionState } = await import('./events.js');
    clearSessionState(inboxId);
    logger.info({ inboxId }, 'Session stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
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

  /** Snapshot leve pro endpoint /health do worker. */
  healthSnapshot(): { activeSessions: number; sessionIds: string[] } {
    return { activeSessions: this.sessions.size, sessionIds: [...this.sessions.keys()] };
  }

  /**
   * Restaura sessões de inboxes que estavam CONNECTED ou CONNECTING ao último shutdown.
   */
  async resumeAll(): Promise<void> {
    const inboxes = await prisma.inbox.findMany({
      where: {
        status: { in: ['CONNECTED', 'CONNECTING', 'AWAITING_QR'] },
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
