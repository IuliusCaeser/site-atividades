// Checagem de links (rodado pelo GitHub Actions toda madrugada).
// Lê os itens do Supabase, testa cada `link_referencia` e grava data/link-errors.json.
// O arquivo é REGERADO a cada execução: link que voltou a funcionar some do log
// e, portanto, o aviso desaparece automaticamente no site.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';
const TOKEN = process.env.LINK_CHECK_TOKEN || '';
const OUT = process.env.LOG_PATH || 'data/link-errors.json';
const TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const UA = 'Mozilla/5.0 (compatible; GuiaAtividadesLinkChecker/1.0)';
// Respostas "inconclusivas": o site existe, mas bloqueia robôs. Não contam como erro.
const INCONCLUSIVE = new Set([401, 403, 405, 429, 999]);

if (!SUPABASE_URL || !KEY || !TOKEN) {
  console.error('Defina SUPABASE_URL, SUPABASE_ANON_KEY e LINK_CHECK_TOKEN (Secrets do repositório).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchItems() {
  // `atividades` não é pública: lemos via função protegida por token.
  const headers = { apikey: KEY, 'content-type': 'application/json' };
  if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`;
  const out = [], size = 1000;
  for (let offset = 0; ; offset += size) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/links_para_checagem?limit=${size}&offset=${offset}`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ p_token: TOKEN }) });
    if (!r.ok) throw new Error(`Supabase respondeu ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

function extractUrls(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\s;|]+/)
    .map((s) => s.trim())
    .filter((s) => s && !['tag_na', '-1', '-'].includes(s.toLowerCase()))
    .map((s) => (/^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+/.test(s) ? `https://${s}` : null))
    .filter(Boolean)
    .filter((s) => { try { new URL(s); return true; } catch { return false; } });
}

async function probe(url, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    try { await r.body?.cancel(); } catch {}
    return { status: r.status };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'tempo esgotado' : (e.cause?.code || e.message || 'erro de rede') };
  } finally {
    clearTimeout(timer);
  }
}

async function check(url) {
  let res = await probe(url, 'HEAD');
  if (res.error || res.status >= 400) res = await probe(url, 'GET'); // vários sites recusam HEAD
  if (res.error) { await sleep(2000); res = await probe(url, 'GET'); } // uma nova tentativa
  return res;
}

const isBroken = (res) => (res.error ? true : INCONCLUSIVE.has(res.status) ? false : res.status >= 400);
const urlKey = (url) => createHash('sha256').update(url).digest('hex').slice(0, 10);
const reason = (res) => (res.error ? `Falha: ${res.error}` : `HTTP ${res.status}`);

async function pool(list, worker, n) {
  const results = new Array(list.length);
  let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < list.length) { const i = idx++; results[i] = await worker(list[i]); }
  }));
  return results;
}

async function main() {
  const items = await fetchItems(); // se falhar, o job falha e o log anterior é mantido
  const pairs = [];
  for (const it of items) for (const url of extractUrls(it.link_referencia)) pairs.push({ it, url });

  const unique = [...new Set(pairs.map((p) => p.url))];
  console.log(`${items.length} atividades · ${unique.length} links únicos para testar`);
  const verdict = new Map();
  await pool(unique, async (url) => { verdict.set(url, await check(url)); }, CONCURRENCY);

  let previous = {};
  try {
    const old = JSON.parse(await readFile(OUT, 'utf8'));
    for (const e of old.errors || []) previous[`${e.tag_id}|${e.link_key}`] = e.desde;
  } catch {}

  const now = new Date().toISOString();
  const errors = [];
  for (const { it, url } of pairs) {
    const res = verdict.get(url);
    if (!isBroken(res)) continue;
    // repo público: o log não leva nome nem URL (o site já os tem após o login)
    const link_key = urlKey(url);
    errors.push({ tag_id: it.tag_id, link_key, motivo: reason(res), desde: previous[`${it.tag_id}|${link_key}`] || now });
  }

  const payload = { generated_at: now, checked: unique.length, broken: errors.length, errors };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Concluído: ${errors.length} link(s) com problema.`);
  errors.forEach((e) => console.log(` - [${e.tag_id}] (${e.motivo})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
