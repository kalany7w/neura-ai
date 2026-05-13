import { describe, it, expect } from 'vitest';
import { can, assertCan, PermissionDeniedError } from '../src/permissions';

describe('permissions', () => {
  it('admin can manage workspace', () => {
    expect(can('ADMIN', 'workspace.delete')).toBe(true);
    expect(can('ADMIN', 'member.invite')).toBe(true);
    expect(can('ADMIN', 'custom_attr.manage')).toBe(true);
  });

  it('supervisor can manage labels but not workspace delete', () => {
    expect(can('SUPERVISOR', 'label.manage')).toBe(true);
    expect(can('SUPERVISOR', 'workspace.delete')).toBe(false);
    expect(can('SUPERVISOR', 'custom_attr.manage')).toBe(false);
  });

  it('agent can send messages but not invite members', () => {
    expect(can('AGENT', 'conversation.send_message')).toBe(true);
    expect(can('AGENT', 'member.invite')).toBe(false);
    expect(can('AGENT', 'workspace.delete')).toBe(false);
  });

  it('agent can read own assigned, not all', () => {
    expect(can('AGENT', 'conversation.read_assigned')).toBe(true);
    expect(can('AGENT', 'conversation.read_all')).toBe(false);
  });

  it('supervisor can read all conversations', () => {
    expect(can('SUPERVISOR', 'conversation.read_all')).toBe(true);
  });

  it('assertCan throws PermissionDeniedError on denied', () => {
    expect(() => assertCan('AGENT', 'workspace.delete')).toThrow(PermissionDeniedError);
  });

  it('assertCan does not throw on allowed', () => {
    expect(() => assertCan('ADMIN', 'workspace.delete')).not.toThrow();
  });
});
