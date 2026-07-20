import { describe, it, expect } from 'vitest';
import { GUARDED_MODELS, LIST_OPS, hasWorkspaceScope } from '../src/tenant-scope.js';

describe('hasWorkspaceScope', () => {
  it('detecta scope direto', () => {
    expect(hasWorkspaceScope({ workspaceId: 'ws_1' })).toBe(true);
    expect(hasWorkspaceScope({ workspaceId: 'ws_1', status: 'open' })).toBe(true);
  });

  it('detecta scope via relação aninhada', () => {
    expect(hasWorkspaceScope({ conversation: { workspaceId: 'ws_1' } })).toBe(true);
    expect(hasWorkspaceScope({ card: { funnel: { workspaceId: 'ws_1' } } })).toBe(true);
  });

  it('detecta scope dentro de AND/OR (arrays)', () => {
    expect(hasWorkspaceScope({ AND: [{ status: 'open' }, { workspaceId: 'ws_1' }] })).toBe(true);
    expect(hasWorkspaceScope({ OR: [{ workspaceId: 'ws_1' }, { workspaceId: 'ws_2' }] })).toBe(
      true,
    );
  });

  it('detecta scope via filtro do Prisma (workspaceId: { in: [...] })', () => {
    expect(hasWorkspaceScope({ workspaceId: { in: ['ws_1', 'ws_2'] } })).toBe(true);
  });

  it('retorna false quando NÃO há scope', () => {
    expect(hasWorkspaceScope({ status: 'open' })).toBe(false);
    expect(hasWorkspaceScope({ AND: [{ status: 'open' }, { assigneeId: 'u_1' }] })).toBe(false);
    expect(hasWorkspaceScope({ contact: { name: 'x' } })).toBe(false);
  });

  it('trata where ausente/vazio como sem scope', () => {
    expect(hasWorkspaceScope(undefined)).toBe(false);
    expect(hasWorkspaceScope(null)).toBe(false);
    expect(hasWorkspaceScope({})).toBe(false);
    expect(hasWorkspaceScope('workspaceId')).toBe(false); // string não conta
  });

  it('não confunde uma coluna com nome parecido', () => {
    expect(hasWorkspaceScope({ workspaceIdHash: 'x' })).toBe(false);
  });
});

describe('conjuntos do guard', () => {
  it('GUARDED_MODELS cobre os modelos tenant e exclui os fora de escopo', () => {
    for (const m of ['Conversation', 'Contact', 'Card', 'Webhook', 'Inbox']) {
      expect(GUARDED_MODELS.has(m)).toBe(true);
    }
    for (const m of ['Membership', 'Invite', 'ApiKey', 'WaAuthKey', 'User', 'Workspace']) {
      expect(GUARDED_MODELS.has(m)).toBe(false);
    }
  });

  it('LIST_OPS cobre operações multi-registro e exclui as single', () => {
    for (const op of ['findMany', 'updateMany', 'deleteMany', 'count', 'aggregate', 'groupBy']) {
      expect(LIST_OPS.has(op)).toBe(true);
    }
    for (const op of ['findUnique', 'create', 'update', 'delete', 'upsert']) {
      expect(LIST_OPS.has(op)).toBe(false);
    }
  });
});
