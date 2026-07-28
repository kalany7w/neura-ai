import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { logger } from '../logger.js';

export const importRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

/**
 * Importador CSV para migrar dados de outros CRMs (Kommo, Pipedrive, HubSpot).
 *
 * Fluxo: o cliente parseia o CSV no browser (papaparse), exibe preview + mapping
 * wizard, e manda batches de rows mapeadas pra este endpoint. Idempotente via
 * (workspaceId, externalId) — re-rodar não duplica.
 *
 * Não recebe arquivo binário: o frontend já fez o parse e envia JSON estructurado.
 * Isso simplifica o backend e mantém limites de body controlados.
 */

// Normaliza telefone pra E.164 +. Aceita formatos comuns:
// "+595994303419" → "+595994303419"
// "595994303419" → "+595994303419"
// "(595) 994-303419" → "+595994303419"
// "0994303419" → null (sem código de país — não dá pra adivinhar)
// "" / null → null
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) {
    return /^\+\d{8,15}$/.test(cleaned) ? cleaned : null;
  }
  // Heurística: se começa com dígito e tem 10-15 chars, assume que já tem cód de país
  // mas sem o +. Adiciona. Senão (8-9 dígitos = nº local), retorna null.
  if (/^\d{10,15}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}


function parseValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Kommo CSV em ES/PT-BR pode vir "1.234,56" ou "1,234.56". Estratégia: remove
  // tudo que não é dígito/vírgula/ponto/menos, depois decide qual é separador
  // decimal pelo último caractere não-numérico antes do dígito final.
  const cleaned = raw.replace(/[^\d.,\-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) {
    // "1.234,56" → vírgula é decimal
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // "1,234.56" → ponto é decimal
    normalized = cleaned.replace(/,/g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ============================ CONTACTS ============================

const contactRowSchema = z.object({
  externalId: z.string().max(120).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(80)).default([]),
  customAttrs: z.record(z.unknown()).default({}),
});

const contactsImportSchema = z.object({
  source: z.string().max(40).default('csv'), // ex: 'kommo'
  rows: z.array(contactRowSchema).min(1).max(2000),
});

/**
 * POST /api/import/contacts
 * Body: { source, rows: [{ externalId, name, phone, email, tags[], customAttrs{} }] }
 *
 * Comportamento por row:
 *  - Se tem externalId → upsert by (workspaceId, externalId).
 *  - Senão, tenta dedup by phone → email → cria novo.
 *  - Tags: cria labels que não existem (scope CONTACT, cor cinza), associa ContactLabel.
 *  - customAttrs: salva em Contact.customAttrs JSON (não cria CustomAttributeDef
 *    automaticamente — admin define no /settings/custom-attributes se quiser
 *    renderizar no side panel).
 */
importRouter.post(
  '/contacts',
  requireAuth,
  requireWorkspace,
  requirePermission('label.manage'), // só admin/supervisor importa
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const body = await c.req.json().catch(() => null);
    const parsed = contactsImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }

    const stats = { created: 0, updated: 0, skipped: 0, labelsCreated: 0, errors: [] as Array<{ row: number; reason: string }> };
    // Cache de labels do workspace (carrega 1x, evita roundtrip por tag)
    const allLabels = await prisma.label.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const labelByLowerName = new Map(allLabels.map((l) => [l.name.toLowerCase(), l]));

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const row = parsed.data.rows[i]!;
      try {
        const phone = normalizePhone(row.phone);
        const email = normalizeEmail(row.email);
        const externalId = row.externalId?.trim() || null;

        // Precisa de PELO MENOS um identificador (externalId, phone ou email).
        if (!externalId && !phone && !email) {
          stats.skipped++;
          stats.errors.push({ row: i + 1, reason: 'no_identifier' });
          continue;
        }

        // Resolve contato existente — prioridade: externalId > phone > email.
        let contact: { id: string } | null = null;
        if (externalId) {
          contact = await prisma.contact.findUnique({
            where: { workspaceId_externalId: { workspaceId, externalId } },
            select: { id: true },
          });
        }
        if (!contact && phone) {
          contact = await prisma.contact.findUnique({
            where: { workspaceId_phoneNumber: { workspaceId, phoneNumber: phone } },
            select: { id: true },
          });
        }
        if (!contact && email) {
          contact = await prisma.contact.findUnique({
            where: { workspaceId_email: { workspaceId, email } },
            select: { id: true },
          });
        }

        const data = {
          name: row.name?.trim() || null,
          phoneNumber: phone,
          email,
          externalId,
          // Prisma JSON: caster pra never (mesmo padrão dos outros routes).
          ...(Object.keys(row.customAttrs).length && {
            customAttrs: row.customAttrs as never,
          }),
        };

        if (contact) {
          await prisma.contact.update({ where: { id: contact.id }, data });
          stats.updated++;
        } else {
          contact = await prisma.contact.create({
            data: { workspaceId, ...data },
            select: { id: true },
          });
          stats.created++;
        }

        // Tags → Labels + ContactLabel
        for (const tagName of row.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          let label = labelByLowerName.get(trimmed.toLowerCase());
          if (!label) {
            const created = await prisma.label.create({
              data: { workspaceId, name: trimmed, color: '#94a3b8', scope: 'CONTACT' },
            });
            label = created;
            labelByLowerName.set(trimmed.toLowerCase(), created);
            stats.labelsCreated++;
          }
          await prisma.contactLabel
            .upsert({
              where: { contactId_labelId: { contactId: contact.id, labelId: label.id } },
              create: { contactId: contact.id, labelId: label.id },
              update: {},
            })
            .catch(() => null);
        }
      } catch (err) {
        logger.error({ err, rowIndex: i, row }, 'import.contact_row_failed');
        stats.skipped++;
        stats.errors.push({
          row: i + 1,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'import.contacts',
      metadata: { source: parsed.data.source, ...stats, errors: stats.errors.slice(0, 20) },
    });

    return c.json({ ok: true, stats });
  },
);

// ============================ LEADS / CARDS ============================

const leadRowSchema = z.object({
  externalId: z.string().max(120).nullable().optional(),
  title: z.string().max(200),
  value: z.union([z.number(), z.string()]).nullable().optional(),
  currency: z.string().length(3).optional(),
  stageName: z.string().max(120).nullable().optional(), // texto livre — mapeia por nome
  responsibleName: z.string().max(120).nullable().optional(), // texto livre — match com member.user.name/email
  responsibleEmail: z.string().max(200).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  contactEmail: z.string().max(200).nullable().optional(),
  contactExternalId: z.string().max(120).nullable().optional(),
  tags: z.array(z.string().max(80)).default([]),
  customAttrs: z.record(z.unknown()).default({}),
});

const leadsImportSchema = z.object({
  source: z.string().max(40).default('csv'),
  funnelId: z.string().min(1), // destino: TODOS os leads vão pra este funil
  defaultStageId: z.string().min(1), // se stageName não casa com nenhum stage do funnel
  rows: z.array(leadRowSchema).min(1).max(2000),
});

/**
 * POST /api/import/leads
 * Body: { source, funnelId, defaultStageId, rows: [...] }
 *
 * - Resolve stage por nome dentro do funnel (case-insensitive). Sem match → defaultStageId.
 * - Resolve contato por externalId/phone/email → vincula em Card.conversationId? Não:
 *   o vínculo Card-Conversation só faz sentido se a conversa WhatsApp existir.
 *   Por enquanto, deixa conversationId=null. Quando o cliente mandar msg via WA, o
 *   evento inbound vai casar pelo phone e vincular a conversa ao card existente.
 *   (Esse linking automático já existe no waworker via Contact.phoneNumber match.)
 * - Tags: aplica em CardLabel.
 * - assignedAgentId: tenta match por responsibleEmail → Membership.user.email.
 */
importRouter.post(
  '/leads',
  requireAuth,
  requireWorkspace,
  requirePermission('funnel.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const body = await c.req.json().catch(() => null);
    const parsed = leadsImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }

    // Valida funnel + stages destino
    const funnel = await prisma.funnel.findFirst({
      where: { id: parsed.data.funnelId, workspaceId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!funnel) return c.json({ error: 'funnel_not_found' }, 404);
    const stageByLowerName = new Map(
      funnel.stages.map((s) => [s.name.toLowerCase(), s]),
    );
    const defaultStage = funnel.stages.find((s) => s.id === parsed.data.defaultStageId);
    if (!defaultStage) return c.json({ error: 'default_stage_not_in_funnel' }, 400);

    // Cache de members (resolução de assignedAgentId por email)
    const members = await prisma.membership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    const userByEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.user.id]));
    const userByName = new Map<string, string>();
    for (const m of members) {
      if (m.user.name) userByName.set(m.user.name.toLowerCase(), m.user.id);
    }

    // Cache labels do workspace
    const allLabels = await prisma.label.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
    });
    const labelByLowerName = new Map(allLabels.map((l) => [l.name.toLowerCase(), l]));

    const stats = {
      created: 0,
      updated: 0,
      skipped: 0,
      labelsCreated: 0,
      errors: [] as Array<{ row: number; reason: string }>,
    };

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const row = parsed.data.rows[i]!;
      try {
        if (!row.title?.trim()) {
          stats.skipped++;
          stats.errors.push({ row: i + 1, reason: 'missing_title' });
          continue;
        }
        const externalId = row.externalId?.trim() || null;
        const stage = row.stageName
          ? stageByLowerName.get(row.stageName.toLowerCase()) ?? defaultStage
          : defaultStage;
        const value =
          typeof row.value === 'number'
            ? row.value
            : row.value
              ? parseValue(row.value)
              : null;

        // Assigned agent: prioridade email > name
        let assignedAgentId: string | null = null;
        const respEmail = normalizeEmail(row.responsibleEmail);
        if (respEmail) assignedAgentId = userByEmail.get(respEmail) ?? null;
        if (!assignedAgentId && row.responsibleName?.trim()) {
          assignedAgentId = userByName.get(row.responsibleName.trim().toLowerCase()) ?? null;
        }

        // Contact link: resolve mas NÃO vincula conversationId (só quando msg WA chegar)
        // OBS: salvamos o phone no card.customAttrs.importedContactPhone pra debug.
        // Card.conversationId fica null por design.

        const customAttrsPayload =
          Object.keys(row.customAttrs).length || row.contactPhone || row.contactEmail
            ? ({
                ...row.customAttrs,
                ...(row.contactPhone && { _importedContactPhone: row.contactPhone }),
                ...(row.contactEmail && { _importedContactEmail: row.contactEmail }),
              } as never)
            : undefined;
        const data = {
          title: row.title.trim(),
          value: value !== null ? value : undefined,
          currency: row.currency || undefined,
          assignedAgentId,
          stageId: stage.id,
          externalId,
          ...(customAttrsPayload !== undefined && { customAttrs: customAttrsPayload }),
        };

        let card: { id: string } | null = null;
        if (externalId) {
          card = await prisma.card.findUnique({
            where: { workspaceId_externalId: { workspaceId, externalId } },
            select: { id: true },
          });
        }

        if (card) {
          await prisma.card.update({ where: { id: card.id }, data });
          stats.updated++;
        } else {
          // Position: append no fim do stage
          const max = await prisma.card.aggregate({
            where: { stageId: stage.id },
            _max: { position: true },
          });
          card = await prisma.card.create({
            data: {
              workspaceId,
              funnelId: funnel.id,
              ...data,
              position: (max._max.position ?? -1) + 1,
            },
            select: { id: true },
          });
          stats.created++;
        }

        // Tags → CardLabel
        for (const tagName of row.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          let label = labelByLowerName.get(trimmed.toLowerCase());
          if (!label) {
            const created = await prisma.label.create({
              data: {
                workspaceId,
                name: trimmed,
                color: '#94a3b8',
                scope: 'BOTH',
                // Vincula ao funnel destino — escopo multi-empresa.
                routesToFunnelId: funnel.id,
              },
            });
            label = created;
            labelByLowerName.set(trimmed.toLowerCase(), created);
            stats.labelsCreated++;
          }
          await prisma.cardLabel
            .upsert({
              where: { cardId_labelId: { cardId: card.id, labelId: label.id } },
              create: { cardId: card.id, labelId: label.id },
              update: {},
            })
            .catch(() => null);
        }
      } catch (err) {
        logger.error({ err, rowIndex: i, row }, 'import.lead_row_failed');
        stats.skipped++;
        stats.errors.push({
          row: i + 1,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'import.leads',
      metadata: {
        source: parsed.data.source,
        funnelId: funnel.id,
        ...stats,
        errors: stats.errors.slice(0, 20),
      },
    });

    return c.json({ ok: true, stats });
  },
);
