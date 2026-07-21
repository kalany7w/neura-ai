/**
 * Proteção SSRF para URLs fornecidas por tenants (webhooks salientes, testes de webhook).
 *
 * Um admin/supervisor de um workspace pode cadastrar a URL de destino de um webhook.
 * Sem guarda, ele poderia apontar pra `http://169.254.169.254/…` (metadata do cloud),
 * `http://localhost:…` ou hosts internos da VPS e exfiltrar respostas/segredos.
 *
 * Uso:
 *  - `assertHostnameAllowed(url)`  → validação síncrona barata no cadastro (scheme + host literal)
 *  - `await assertPublicUrl(url)`  → resolve DNS e rejeita se QUALQUER IP for privado (antes do fetch)
 */

import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Retorna true se o IPv4 (a.b.c.d) cai num range privado/reservado. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // formato inesperado → bloqueia por segurança
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (inclui 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (IETF) / 192.0.2.0/24 (TEST-NET)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reservado
  return false;
}

/**
 * Extrai o IPv4 embutido num IPv6 mapeado/traduzido: IPv4-mapped `::ffff:…` (na
 * forma decimal `::ffff:a.b.c.d` OU hex `::ffff:XXXX:YYYY` — que é como `new URL()`
 * normaliza a decimal) e NAT64 `64:ff9b::…`. Retorna null se não houver IPv4 embutido.
 * Sem isso, `http://[::ffff:10.0.0.1]/` (normalizado pra `::ffff:a00:1`) furava o guard.
 */
function embeddedIPv4(lowerV6: string): string | null {
  const dec = lowerV6.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dec) return dec[1]!;
  const hex = lowerV6.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Retorna true se o IPv6 cai num range privado/reservado. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4 embutido (mapped ::ffff:… decimal/hex, ou NAT64 64:ff9b::…) → checa o IPv4
  const embedded = embeddedIPv4(lower);
  if (embedded) return isPrivateIPv4(embedded);
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('2001:db8')) return true; // documentação
  return false;
}

function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // não é IP válido → bloqueia
}

/**
 * Validação síncrona no cadastro: só http/https e nada de host obviamente interno.
 * Não resolve DNS (isso é feito no fire-time por `assertPublicUrl`).
 */
export function assertHostnameAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('URL inválida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('Só http(s) é permitido');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new SsrfBlockedError('Host interno não permitido');
  }
  // Se o host já é um IP literal, valida na hora.
  if (isIP(host) && isPrivateIp(host)) {
    throw new SsrfBlockedError('IP privado/reservado não permitido');
  }
  return url;
}

/**
 * Validação no fire-time: resolve o hostname e rejeita se QUALQUER endereço for privado.
 * Reduz o risco de DNS rebinding (host público no cadastro, privado no fetch).
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const url = assertHostnameAllowed(rawUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) return; // já validado em assertHostnameAllowed
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError('Não foi possível resolver o host');
  }
  if (addrs.length === 0) throw new SsrfBlockedError('Host sem endereços');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new SsrfBlockedError('Host resolve pra IP privado/reservado');
    }
  }
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * Dispatcher undici cujo lookup RE-VALIDA os IPs no momento da conexão. Fecha o
 * TOCTOU de DNS rebinding: `assertPublicUrl` valida, mas o fetch resolvia DNS de
 * novo por conta própria — um registro de TTL curto podia flipar pra IP privado
 * entre as duas resoluções. Com este dispatcher, TODA conexão do fetch de
 * webhook resolve pelo nosso validador.
 */
export const ssrfSafeDispatcher = new Agent({
  connect: {
    lookup(hostname: string, options: { all?: boolean }, callback: LookupCb): void {
      dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = addresses as Array<{ address: string; family: number }>;
        if (list.length === 0) {
          return callback(new SsrfBlockedError('Host sem endereços'));
        }
        for (const a of list) {
          if (isPrivateIp(a.address)) {
            return callback(new SsrfBlockedError('Host resolve pra IP privado/reservado'));
          }
        }
        if (options.all) return callback(null, list);
        const first = list[0]!;
        return callback(null, first.address, first.family);
      });
    },
  },
});

/** fetch (undici) preso ao dispatcher acima — usar em TODO fetch de URL de tenant. */
export const ssrfSafeFetch: typeof undiciFetch = (input, init) =>
  undiciFetch(input, { ...init, dispatcher: ssrfSafeDispatcher });
