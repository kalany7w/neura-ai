import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { encrypt } from '../services/crypto.js';
import {
  getMe,
  setWebhook,
  deleteWebhook,
} from '../services/telegram-client.js';
import { decrypt } from '../services/crypto.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

export const inboxesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createInboxSchema = z.object({
  name: z.string().min(1).max(80),
});

// POST /api/inboxes — cria inbox (admin)
inboxesRouter.post('/', requireAuth, requireWorkspace, requirePermission('inbox.create'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createInboxSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const workspaceId = c.get('workspaceId') as string;
  const actorId = c.get('userId');

  const inbox = await prisma.inbox.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      type: 'WHATSAPP',
      status: 'DISCONNECTED',
    },
  });
  await audit({
    workspaceId,
    actorId,
    action: 'inbox.created',
    resource: `Inbox:${inbox.id}`,
    metadata: { name: inbox.name },
  });
  return c.json({ inbox }, 201);
});

// GET /api/inboxes — lista inboxes do workspace
inboxesRouter.get('/', requireAuth, requireWorkspace, requirePermission('inbox.list'), async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const includeWelcomeFlow = c.req.query('includeWelcomeFlow') === 'true';

  const inboxes = await prisma.inbox.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      waSession: {
        select: {
          phoneNumber: true,
          qrCode: true,
          qrExpiresAt: true,
          lastConnectedAt: true,
        },
      },
      ...(includeWelcomeFlow
        ? {
            welcomeFlow: {
              select: {
                id: true,
                enabled: true,
                _count: { select: { options: true } },
              },
            },
          }
        : {}),
    },
  });

  if (!includeWelcomeFlow) return c.json({ inboxes });

  // Mapa pra flatten _count → optionsCount, mantendo todos os demais campos.
  const mapped = inboxes.map((i) => {
    const wf = (i as typeof i & {
      welcomeFlow?: { id: string; enabled: boolean; _count: { options: number } } | null;
    }).welcomeFlow;
    return {
      ...i,
      welcomeFlow: wf
        ? { id: wf.id, enabled: wf.enabled, optionsCount: wf._count.options }
        : null,
    };
  });
  return c.json({ inboxes: mapped });
});

// GET /api/inboxes/:id — detalhe + QR atual
inboxesRouter.get(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.list'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const inbox = await prisma.inbox.findFirst({
      where: { id: c.req.param('id'), workspaceId },
      include: { waSession: true },
    });
    if (!inbox) return c.json({ error: 'not_found' }, 404);
    return c.json({ inbox });
  },
);

// PATCH /api/inboxes/:id — atualiza nome e settings (round-robin, business hours, mensagens auto)
const inboxSettingsSchema = z
  .object({
    roundRobinEnabled: z.boolean().optional(),
    businessHours: z
      .object({
        enabled: z.boolean(),
        start: z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:MM'),
        end: z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:MM'),
        days: z.array(z.number().int().min(0).max(6)),
      })
      .optional(),
    greetingMessage: z.string().max(2000).nullable().optional(),
    outOfHoursMessage: z.string().max(2000).nullable().optional(),
    autoResolveAfterDays: z.number().int().min(0).max(365).nullable().optional(),
  })
  .strict();

const patchInboxSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  settings: inboxSettingsSchema.optional(),
});

inboxesRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = patchInboxSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.settings !== undefined) {
      // Merge com settings existentes
      const current = (existing.settings as Record<string, unknown>) ?? {};
      data.settings = { ...current, ...parsed.data.settings };
    }
    const inbox = await prisma.inbox.update({ where: { id }, data });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbox.updated',
      resource: `Inbox:${id}`,
    });
    return c.json({ inbox });
  },
);

// POST /api/inboxes/:id/reconnect — força stop + start (limpa cache do worker)
inboxesRouter.post(
  '/:id/reconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    const { redis } = await import('../redis.js');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.stop', inboxId: id }),
    );
    // Pequeno delay pra worker processar stop antes do start
    setTimeout(() => {
      redis
        .publish(
          'worker:commands',
          JSON.stringify({ cmd: 'session.start', inboxId: id }),
        )
        .catch(() => {});
    }, 1500);
    return c.json({ ok: true });
  },
);

// POST /api/inboxes/:id/disconnect — para sessão
inboxesRouter.post(
  '/:id/disconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    const { redis } = await import('../redis.js');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.stop', inboxId: id }),
    );
    return c.json({ ok: true });
  },
);

// DELETE /api/inboxes/:id — remove inbox (cascade conversations)
inboxesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.delete'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    // Para sessão antes de deletar
    const { redis } = await import('../redis.js');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.stop', inboxId: id }),
    );
    await prisma.inbox.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId,
      action: 'inbox.deleted',
      resource: `Inbox:${id}`,
    });
    return c.json({ ok: true });
  },
);

// ============================================================
// TELEGRAM — conectar / desconectar
// ============================================================

const telegramConnectSchema = z.object({
  name: z.string().min(1).max(80),
  botToken: z.string().min(20).max(80).regex(/^\d+:[A-Za-z0-9_-]+$/, 'Token inválido (formato: 123456:ABC-xyz)'),
});

// POST /api/inboxes/telegram/connect — cria inbox tipo TELEGRAM e configura webhook
inboxesRouter.post(
  '/telegram/connect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = telegramConnectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');

    // Valida bot token via getMe
    let botInfo;
    try {
      botInfo = await getMe(parsed.data.botToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Token inválido';
      return c.json({ error: 'invalid_bot_token', message: msg }, 400);
    }

    // Slug aleatório pra URL do webhook (anti-enumeração + secret_token extra)
    const webhookSlug = randomBytes(16).toString('hex');
    const secretToken = randomBytes(24).toString('hex');

    // Cria inbox antes de configurar webhook (rollback se webhook falhar)
    const inbox = await prisma.inbox.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        type: 'TELEGRAM',
        status: 'CONNECTING',
        channelConfig: {
          botTokenEncrypted: encrypt(parsed.data.botToken),
          botUsername: botInfo.username ?? null,
          botId: botInfo.id,
          webhookSlug,
          secretToken,
        },
      },
    });

    // Configura webhook no Telegram
    const baseUrl = env.PUBLIC_API_URL || env.APP_URL || '';
    if (!baseUrl) {
      await prisma.inbox.delete({ where: { id: inbox.id } });
      return c.json({ error: 'public_url_not_configured' }, 500);
    }
    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook/${webhookSlug}`;
    try {
      await setWebhook({
        botToken: parsed.data.botToken,
        url: webhookUrl,
        secretToken,
      });
      await prisma.inbox.update({
        where: { id: inbox.id },
        data: { status: 'CONNECTED' },
      });
    } catch (err) {
      logger.error({ err, inboxId: inbox.id }, 'Telegram setWebhook failed');
      await prisma.inbox.update({
        where: { id: inbox.id },
        data: { status: 'ERROR' },
      });
      const msg = err instanceof Error ? err.message : 'webhook failed';
      return c.json({ error: 'webhook_setup_failed', message: msg }, 500);
    }

    await audit({
      workspaceId,
      actorId,
      action: 'inbox.telegram_connected',
      resource: `Inbox:${inbox.id}`,
      metadata: { botUsername: botInfo.username },
    });

    return c.json({
      inbox: {
        id: inbox.id,
        name: inbox.name,
        type: inbox.type,
        status: 'CONNECTED',
        botUsername: botInfo.username,
        botName: botInfo.first_name,
      },
    }, 201);
  },
);

// POST /api/inboxes/:id/telegram/disconnect — remove webhook + marca DISCONNECTED
inboxesRouter.post(
  '/:id/telegram/disconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'TELEGRAM') return c.json({ error: 'not_found' }, 404);

    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const tokenEnc = cfg.botTokenEncrypted as string | undefined;
    if (tokenEnc) {
      try {
        const token = decrypt(tokenEnc);
        await deleteWebhook(token);
      } catch (err) {
        logger.warn({ err, inboxId: id }, 'Telegram deleteWebhook failed (continuing)');
      }
    }
    await prisma.inbox.update({
      where: { id },
      data: { status: 'DISCONNECTED' },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbox.telegram_disconnected',
      resource: `Inbox:${id}`,
    });
    return c.json({ ok: true });
  },
);

// ============================================================
// EMAIL — conectar / desconectar (Onda 4.5)
// ============================================================
// Não precisa "conectar" no provedor — o agente cadastra o endereço from + o
// URL do webhook inbound. O Resend (ou Postmark/SES) deve ser configurado pra
// chamar nosso webhook quando email chegar. Retornamos o URL + secret pra
// paste no painel do provedor.

const emailConnectSchema = z.object({
  name: z.string().min(1).max(80),
  // Endereço from completo: ex "suporte@empresa.com". Validação básica.
  fromAddress: z
    .string()
    .email('email inválido')
    .max(120)
    .transform((s) => s.toLowerCase()),
  // Nome humano que aparece no From — ex "Suporte Acme".
  fromName: z.string().min(1).max(80).optional(),
});

inboxesRouter.post(
  '/email/connect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = emailConnectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');

    // Slug aleatório pra URL do webhook (anti-enumeração) + secret HMAC opcional
    const inboundSlug = randomBytes(16).toString('hex');
    const inboundSecret = randomBytes(24).toString('hex');

    const inbox = await prisma.inbox.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        type: 'EMAIL',
        // EMAIL inbox fica CONNECTED imediatamente — não há handshake com provedor.
        // O fluxo só funciona quando o user configura o webhook no Resend/Postmark/SES.
        status: 'CONNECTED',
        channelConfig: {
          fromAddress: parsed.data.fromAddress,
          fromName: parsed.data.fromName ?? parsed.data.name,
          inboundSlug,
          inboundSecret,
        },
      },
    });

    await audit({
      workspaceId,
      actorId,
      action: 'inbox.email_connected',
      resource: `Inbox:${inbox.id}`,
      metadata: { fromAddress: parsed.data.fromAddress },
    });

    const baseUrl = env.PUBLIC_API_URL || env.APP_URL || '';
    const webhookUrl = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/api/inbound/email/${inboundSlug}`
      : `/api/inbound/email/${inboundSlug}`;

    return c.json(
      {
        inbox: {
          id: inbox.id,
          name: inbox.name,
          type: inbox.type,
          status: inbox.status,
          fromAddress: parsed.data.fromAddress,
          fromName: parsed.data.fromName ?? parsed.data.name,
        },
        webhook: {
          url: webhookUrl,
          secret: inboundSecret,
          slug: inboundSlug,
        },
      },
      201,
    );
  },
);

// POST /api/inboxes/:id/email/disconnect — só marca DISCONNECTED.
// Não consegue desconfigurar webhook no provedor (não temos credentials dele).
inboxesRouter.post(
  '/:id/email/disconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'EMAIL') return c.json({ error: 'not_found' }, 404);
    await prisma.inbox.update({
      where: { id },
      data: { status: 'DISCONNECTED' },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbox.email_disconnected',
      resource: `Inbox:${id}`,
    });
    return c.json({ ok: true });
  },
);

// GET /api/inboxes/:id/email/webhook — retorna URL + secret pra paste no provedor.
// ADMIN+SUPERVISOR (pra setup) — não expõe via lista pública pra evitar leak.
inboxesRouter.get(
  '/:id/email/webhook',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'EMAIL') return c.json({ error: 'not_found' }, 404);
    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const slug = cfg.inboundSlug as string | undefined;
    const secret = cfg.inboundSecret as string | undefined;
    if (!slug || !secret) return c.json({ error: 'not_configured' }, 500);
    const baseUrl = env.PUBLIC_API_URL || env.APP_URL || '';
    return c.json({
      url: baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/api/inbound/email/${slug}`
        : `/api/inbound/email/${slug}`,
      secret,
      slug,
      fromAddress: cfg.fromAddress,
      fromName: cfg.fromName,
    });
  },
);

// ============================================================
// WEBCHAT — conectar / desconectar (Onda 6A)
// ============================================================
// Cria inbox tipo WEBCHAT com widgetSlug random. UI mostra <script> pra paste
// no site do cliente. Visitantes anônimos conectam via /api/webchat/<slug>/*.

const webchatConnectSchema = z.object({
  name: z.string().min(1).max(80),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'cor hex inválida')
    .default('#6366f1'),
  title: z.string().min(1).max(60).default('Atendimento'),
  placeholder: z.string().min(1).max(80).default('Digite sua mensagem…'),
  welcomeMessage: z.string().max(500).optional(),
});

function buildWidgetScript(widgetSlug: string, baseUrl: string): string {
  const src = `${baseUrl.replace(/\/$/, '')}/widget.js`;
  return `<script async defer src="${src}" data-neura-widget="${widgetSlug}" data-neura-api="${baseUrl.replace(/\/$/, '')}"></script>`;
}

inboxesRouter.post(
  '/webchat/connect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = webchatConnectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const widgetSlug = randomBytes(16).toString('hex');

    const inbox = await prisma.inbox.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        type: 'WEBCHAT',
        status: 'CONNECTED',
        channelConfig: {
          widgetSlug,
          primaryColor: parsed.data.primaryColor,
          title: parsed.data.title,
          placeholder: parsed.data.placeholder,
          welcomeMessage: parsed.data.welcomeMessage?.trim() || null,
        },
      },
    });

    await audit({
      workspaceId,
      actorId,
      action: 'inbox.webchat_connected',
      resource: `Inbox:${inbox.id}`,
      metadata: { widgetSlug },
    });

    const baseUrl =
      env.PUBLIC_API_URL || env.APP_URL || '';
    const appBase = env.APP_URL || baseUrl;

    return c.json(
      {
        inbox: {
          id: inbox.id,
          name: inbox.name,
          type: inbox.type,
          status: inbox.status,
        },
        widget: {
          slug: widgetSlug,
          // O script é servido pelo app web (apps/web/public/widget.js) — usa APP_URL.
          script: buildWidgetScript(widgetSlug, appBase),
          apiBaseUrl: baseUrl,
          primaryColor: parsed.data.primaryColor,
        },
      },
      201,
    );
  },
);

// PATCH /api/inboxes/:id/webchat/config — atualiza tema/welcome (ADMIN+SUPERVISOR).
inboxesRouter.patch(
  '/:id/webchat/config',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = webchatConnectSchema
      .partial({ name: true })
      .extend({
        // Permite atualizar individual sem precisar enviar nome de novo
        name: z.string().min(1).max(80).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'WEBCHAT') return c.json({ error: 'not_found' }, 404);
    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const updated = await prisma.inbox.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        channelConfig: {
          ...cfg,
          ...(parsed.data.primaryColor ? { primaryColor: parsed.data.primaryColor } : {}),
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.placeholder ? { placeholder: parsed.data.placeholder } : {}),
          ...(parsed.data.welcomeMessage !== undefined
            ? { welcomeMessage: parsed.data.welcomeMessage?.trim() || null }
            : {}),
        },
      },
    });
    return c.json({ inbox: updated });
  },
);

// GET /api/inboxes/:id/webchat/snippet — retorna script tag pra paste no site.
inboxesRouter.get(
  '/:id/webchat/snippet',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'WEBCHAT') return c.json({ error: 'not_found' }, 404);
    const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
    const slug = cfg.widgetSlug as string | undefined;
    if (!slug) return c.json({ error: 'not_configured' }, 500);
    const baseUrl = env.PUBLIC_API_URL || env.APP_URL || '';
    const appBase = env.APP_URL || baseUrl;
    return c.json({
      slug,
      script: buildWidgetScript(slug, appBase),
      apiBaseUrl: baseUrl,
      primaryColor: cfg.primaryColor ?? '#6366f1',
      title: cfg.title ?? 'Atendimento',
      placeholder: cfg.placeholder ?? 'Digite sua mensagem…',
      welcomeMessage: cfg.welcomeMessage ?? null,
    });
  },
);

// POST /api/inboxes/:id/webchat/disconnect — desativa widget.
inboxesRouter.post(
  '/:id/webchat/disconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.create'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox || inbox.type !== 'WEBCHAT') return c.json({ error: 'not_found' }, 404);
    await prisma.inbox.update({
      where: { id },
      data: { status: 'DISCONNECTED' },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbox.webchat_disconnected',
      resource: `Inbox:${id}`,
    });
    return c.json({ ok: true });
  },
);

// POST /api/inboxes/:id/connect — pede pra waworker iniciar sessão (publish em Redis).
// IMPORTANTE: registrada DEPOIS das rotas estáticas /{canal}/connect (telegram/email/
// webchat). No Hono a 1ª rota registrada que casa vence; '/:id/connect' casaria com
// '/email/connect' (id="email") e shadowava as estáticas → 404 not_found. Manter por último.
inboxesRouter.post(
  '/:id/connect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    // Publica comando pro worker iniciar sessão
    const { redis } = await import('../redis.js');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.start', inboxId: id }),
    );
    return c.json({ ok: true, status: 'requested' });
  },
);
