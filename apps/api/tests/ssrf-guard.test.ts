import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do DNS: assertPublicUrl resolve o hostname e checa o IP. Pra hostnames
// (não-literais) controlamos o retorno aqui; IPs literais nem chamam o lookup.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  assertHostnameAllowed,
  assertPublicUrl,
  SsrfBlockedError,
} from '../src/services/ssrf-guard.js';

describe('assertHostnameAllowed', () => {
  const blocked = [
    'http://localhost/hook',
    'http://app.localhost/hook',
    'http://svc.internal/hook',
    'http://127.0.0.1/x',
    'http://0.0.0.0/x',
    'http://10.0.0.5/x',
    'http://172.16.3.4/x',
    'http://172.31.255.1/x',
    'http://192.168.1.10/x',
    'http://169.254.169.254/latest/meta-data', // metadata do cloud
    'http://100.64.0.1/x', // CGNAT
    'http://198.18.0.1/x', // benchmark
    'http://[::1]/x', // loopback v6
    'http://[fc00::1]/x', // ULA v6
    'http://[fe80::1]/x', // link-local v6
    'http://[2001:db8::1]/x', // documentação v6
    'http://[::ffff:10.0.0.1]/x', // IPv4-mapped privado (normaliza pra ::ffff:a00:1)
    'http://[::ffff:169.254.169.254]/x', // IPv4-mapped metadata do cloud
    'http://[::ffff:192.168.0.1]/x', // IPv4-mapped LAN
    'http://[64:ff9b::10.0.0.1]/x', // NAT64 embutindo IP privado
    'ftp://example.com/x', // esquema não-http
    'redis://10.0.0.1:6379', // esquema não-http
  ];
  for (const url of blocked) {
    it(`bloqueia ${url}`, () => {
      expect(() => assertHostnameAllowed(url)).toThrow(SsrfBlockedError);
    });
  }

  const allowed = [
    'https://example.com/hook',
    'http://8.8.8.8/x',
    'https://1.1.1.1/x',
    'https://api.stripe.com/v1/webhooks',
    'http://172.15.0.1/x', // fora do range 172.16-31
    'http://172.32.0.1/x',
    'http://[2606:4700:4700::1111]/x', // IPv6 público (Cloudflare DNS)
    'http://[::ffff:8.8.8.8]/x', // IPv4-mapped de IP público → permitido
  ];
  for (const url of allowed) {
    it(`permite ${url}`, () => {
      expect(() => assertHostnameAllowed(url)).not.toThrow();
    });
  }

  it('rejeita URL inválida', () => {
    expect(() => assertHostnameAllowed('not a url')).toThrow(SsrfBlockedError);
  });
});

describe('assertPublicUrl', () => {
  beforeEach(() => lookupMock.mockReset());

  it('IP público literal passa sem resolver DNS', async () => {
    await expect(assertPublicUrl('http://8.8.8.8/x')).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('IP privado literal é bloqueado sem resolver DNS', async () => {
    await expect(assertPublicUrl('http://10.0.0.1/x')).rejects.toThrow(SsrfBlockedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('hostname que resolve pra IP privado é bloqueado (anti DNS-rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    await expect(assertPublicUrl('https://evil.example.com/x')).rejects.toThrow(SsrfBlockedError);
  });

  it('hostname que resolve pra IP público passa', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicUrl('https://example.com/x')).resolves.toBeUndefined();
  });

  it('bloqueia se QUALQUER endereço resolvido for privado', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertPublicUrl('https://mixed.example.com/x')).rejects.toThrow(SsrfBlockedError);
  });

  it('bloqueia se o DNS não retornar endereços', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertPublicUrl('https://empty.example.com/x')).rejects.toThrow(SsrfBlockedError);
  });

  it('bloqueia se o DNS retornar algo que não é IP (fail-closed)', async () => {
    lookupMock.mockResolvedValue([{ address: 'not-an-ip', family: 4 }]);
    await expect(assertPublicUrl('https://weird.example.com/x')).rejects.toThrow(SsrfBlockedError);
  });
});
