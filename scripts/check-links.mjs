// Checagem de links (rodado pelo GitHub Actions toda madrugada).
// Lê os itens do Supabase, testa cada `link_referencia` e grava data/link-errors.json.
// O arquivo é REGERADO a cada execução: link que voltou a funcionar some do log
// e, portanto, o aviso desaparece automaticamente no site.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';
const OUT = process.env.LOG_PATH || 'data/link-errors.json';
const TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const UA = 'Mozilla/5.0 (compatible; GuiaAtividadesLinkChecker/1.0)';
// Respostas "inconclusivas": o site existe, mas bloqueia robôs. Não contam como erro.
const INCONCLUSIVE = new Set([401, 403, 405, 429, 999]);

if (!SUPABASE_URL || !KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_ANON_KEY (Secrets do repositório).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchItems() {
  const headers = { apikey: KEY, 'Range-Unit': 'items' };
  if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`; // chaves antigas (JWT)
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const url = `${SUPABASE_URL}/rest/v1/atividades?select=tag_id,nome_principal,link_referencia&order=tag_id`;
    const r = await fetch(url, { headers: { ...headers, Range: `${from}-${from + size - 1}` } });
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
    for (const e of old.errors || []) previous[`${e.tag_id}|${e.url}`] = e.desde;
  } catch {}

  const now = new Date().toISOString();
  const errors = [];
  for (const { it, url } of pairs) {
    const res = verdict.get(url);
    if (!isBroken(res)) continue;
    errors.push({
      tag_id: it.tag_id,
      nome: it.nome_principal,
      url,
      motivo: reason(res),
      desde: previous[`${it.tag_id}|${url}`] || now,
    });
  }

  const payload = { generated_at: now, checked: unique.length, broken: errors.length, errors };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Concluído: ${errors.length} link(s) com problema.`);
  errors.forEach((e) => console.log(` - [${e.tag_id}] ${e.nome}: ${e.url} (${e.motivo})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
