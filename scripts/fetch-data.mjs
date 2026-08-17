// AIWO data pipeline v2 — full-catalog mode
// Run by .github/workflows/update-data.yml twice a day.
//
// Strategy: instead of manually curating a handful of products (which goes
// stale every time a vendor renames/retires a model), we mirror OpenRouter's
// ENTIRE public model catalog every run. Whatever is live there is live here.
// Nothing to hardcode, nothing to go stale.
//
// Sources used:
//  - OpenRouter Models API   (public, no auth)  -> the full catalog: pricing,
//    context window, provider, release date, and — where available — the
//    model's Hugging Face repo id
//  - Hugging Face Models API (public, no auth)  -> real download counts for
//    every model OpenRouter tags with a hugging_face_id (open-weight models)
//
// If a number can't be sourced, we store `null` and the UI shows
// "No public data" instead of inventing something.

import { readFile, writeFile } from 'node:fs/promises';

const HISTORY_LIMIT = 30;
const OUTPUT_PATH = new URL('../data.json', import.meta.url);
const PINNED_PATH = new URL('../data/pinned.json', import.meta.url);
const HF_CONCURRENCY = 8; // be polite to the free public HF API

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function formatContext(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatPrice(perToken) {
  const n = Number(perToken);
  if (!Number.isFinite(n) || n <= 0) return n === 0 ? '$0' : null;
  const per1M = n * 1_000_000;
  return `$${per1M.toFixed(per1M < 1 ? 3 : 2).replace(/\.?0+$/, '')}`;
}

// Fetch a list of items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchHfDownloads(hfId) {
  const json = await safeFetchJson(`https://huggingface.co/api/models/${hfId}`);
  if (!json || typeof json.downloads !== 'number') return null;
  return {
    metric: 'hf_downloads',
    value: json.downloads,
    sourceLabel: 'HF downloads (30d)',
    sourceUrl: `https://huggingface.co/${hfId}`
  };
}

function pushHistory(existingHistory, value) {
  const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
  history.push({ ts: new Date().toISOString(), value });
  return history.slice(-HISTORY_LIMIT);
}

function percentChange(history) {
  if (!history || history.length < 2) return null;
  const first = history[0].value;
  const last = history[history.length - 1].value;
  if (!first) return null;
  return Number((((last - first) / first) * 100).toFixed(1));
}

async function main() {
  const catalog = await safeFetchJson('https://openrouter.ai/api/v1/models');
  const rawModels = catalog?.data || [];
  console.log(`[openrouter] fetched ${rawModels.length} models`);
  if (rawModels.length === 0) {
    console.error('[fatal] OpenRouter returned no models — aborting so we keep last good data.json');
    process.exit(1);
  }

  let previous = { products: [] };
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf-8'));
  } catch {
    console.log('[info] no existing data.json yet — starting fresh');
  }
  const previousById = new Map((previous.products || []).map((p) => [p.id, p]));

  let pinned = [];
  try {
    pinned = JSON.parse(await readFile(PINNED_PATH, 'utf-8'));
  } catch {
    // optional file — fine if it doesn't exist
  }
  const pinnedById = new Map(pinned.map((p) => [p.id, p]));

  // Only open-weight models carry a hugging_face_id — that subset is what we
  // enrich with real download counts.
  const hfCandidates = rawModels.filter((m) => m.hugging_face_id);
  console.log(`[huggingface] ${hfCandidates.length} models have a Hugging Face id — fetching downloads`);
  const hfResults = await mapLimit(hfCandidates, HF_CONCURRENCY, async (m) => {
    const r = await fetchHfDownloads(m.hugging_face_id);
    return [m.id, r];
  });
  const hfById = new Map(hfResults);

  const products = rawModels.map((m) => {
    const prev = previousById.get(m.id);
    const provider = m.id.split('/')[0];
    const adoption = hfById.get(m.id) || null;
    const history = adoption ? pushHistory(prev?.history, adoption.value) : (prev?.history || []);
    const changePct = percentChange(history);
    const pin = pinnedById.get(m.id);

    return {
      id: m.id,
      name: m.name || m.id,
      provider,
      badge: pin?.badge || null,
      description: (m.description || '').slice(0, 400) || null,
      createdAt: m.created ? new Date(m.created * 1000).toISOString() : null,
      hfId: m.hugging_face_id || null,
      tech: {
        contextWindow: formatContext(m.context_length),
        costInput1M: formatPrice(m.pricing?.prompt),
        costOutput1M: formatPrice(m.pricing?.completion)
      },
      adoption: adoption
        ? { metric: adoption.metric, value: adoption.value, sourceLabel: adoption.sourceLabel, sourceUrl: adoption.sourceUrl }
        : null,
      history,
      changePct,
      openrouterUrl: `https://openrouter.ai/${m.id}`
    };
  });

  const providerCounts = new Map();
  for (const p of products) providerCounts.set(p.provider, (providerCounts.get(p.provider) || 0) + 1);
  const providers = [...providerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const output = {
    generatedAt: new Date().toISOString(),
    totalModels: products.length,
    openWeightModels: hfCandidates.length,
    providers,
    products
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output) + '\n', 'utf-8');
  console.log(`[done] wrote data.json with ${products.length} models (${hfCandidates.length} open-weight)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
