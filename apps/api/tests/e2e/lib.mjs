import { createHmac, randomBytes } from 'node:crypto';

// Alvo e credenciais vem do ambiente — nada de segredo versionado.
// Ver README.md nesta pasta.
export const API = process.env.QA_API_URL ?? 'http://localhost:7301';
// O Origin das requisições sai daqui e a API valida contra TRUSTED_ORIGINS. Quando
// só a URL da API é informada, deriva a do app trocando o subdomínio — apontar a
// API para produção e o Origin para localhost rende 403 INVALID_ORIGIN.
export const APP =
  process.env.QA_APP_URL ??
  (process.env.QA_API_URL
    ? process.env.QA_API_URL.replace('//api.', '//app.')
    : 'http://localhost:7302');
export const QA_EMAIL = process.env.QA_EMAIL ?? '';
export const QA_PASS = process.env.QA_PASS ?? '';

if (!QA_EMAIL || !QA_PASS) {
  console.error(
    [
      'Faltam QA_EMAIL e QA_PASS no ambiente.',
      'Exemplo: QA_API_URL=https://api.exemplo.net QA_EMAIL=... QA_PASS=... node run.mjs',
    ].join('\n'),
  );
  process.exit(2);
}

let cookieJar = new Map();

function absorbCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

export function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function clearCookies() { cookieJar = new Map(); }

/** req(method, path, body?, {bearer, headers, raw, noAuth}) */
export async function req(method, path, body, opts = {}) {
  const headers = {
    Origin: APP,
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  if (body !== undefined && !(body instanceof Buffer) && !opts.rawBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  else if (!opts.noAuth) {
    const ck = cookieHeader();
    if (ck) headers.Cookie = ck;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (opts.rawBody ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  absorbCookies(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

export async function login(email = QA_EMAIL, password = QA_PASS) {
  clearCookies();
  const r = await req('POST', '/api/auth/sign-in/email', { email, password });
  if (r.status !== 200) throw new Error(`login falhou ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}

// ---- resultado dos testes ----
export const results = [];
let currentSection = 'geral';
export function section(name) { currentSection = name; }

export async function t(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ section: currentSection, name, ok: true, ms: Date.now() - started, detail: detail ?? null });
    process.stdout.write('.');
  } catch (err) {
    results.push({
      section: currentSection, name, ok: false, ms: Date.now() - started,
      error: err?.message ?? String(err),
    });
    process.stdout.write('F');
  }
}

export function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function expectStatus(r, want, ctx = '') {
  const wants = Array.isArray(want) ? want : [want];
  if (!wants.includes(r.status)) {
    throw new Error(`${ctx} esperava ${wants.join('|')}, veio ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r;
}

export function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export const rnd = (n = 8) => randomBytes(n).toString('hex');

export function report() {
  const fail = results.filter((r) => !r.ok);
  const bySection = {};
  for (const r of results) {
    bySection[r.section] ??= { ok: 0, fail: 0 };
    bySection[r.section][r.ok ? 'ok' : 'fail']++;
  }
  console.log('\n\n=== RESUMO ===');
  for (const [s, v] of Object.entries(bySection)) {
    console.log(`${v.fail ? 'FALHA' : ' ok  '} | ${s}: ${v.ok} ok, ${v.fail} falhas`);
  }
  console.log(`\nTOTAL: ${results.length} testes, ${fail.length} falhas\n`);
  if (fail.length) {
    console.log('=== FALHAS ===');
    for (const f of fail) console.log(`\n[${f.section}] ${f.name}\n  → ${f.error}`);
  }
  return { total: results.length, failed: fail.length, results };
}
