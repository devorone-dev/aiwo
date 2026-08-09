// AIWO data pipeline
// Run by .github/workflows/update-data.yml twice a day.
// Pulls only from real, publicly documented sources — never fabricates numbers.
//
// Sources used:
//  - OpenRouter Models API   (public, no auth)        -> live pricing + context window
//  - GitHub REST API         (auth via Actions token)  -> stars (open-source adoption signal)
//  - Hugging Face Models API (public, no auth)          -> downloads (open-weight adoption signal)
//  - Cloudflare Radar API    (optional, needs a free
//                             CLOUDFLARE_API_TOKEN secret) -> domain popularity rank,
//                             the closest free proxy we have for consumer-app products
//                             that aren't on GitHub/HuggingFace/OpenRouter.
//
// If a source is unavailable or a product has no matching source, we store `null`
// and the UI shows "No public data" instead of inventing a number.

import { readFile, writeFile } from 'node:fs/promises';

const HISTORY_LIMIT = 30; // keep last 30 snapshots (~15 days at 2/day)
const CONFIG_PATH = new URL('../data/products.config.json', import.meta.url);
const OUTPUT_PATH = new URL('../data.json', import.meta.url);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      console.warn(`[warn] ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[warn] ${url} -> ${err.message}`);
    return null;
  }
}

// ---- OpenRouter: fetch the whole catalog once, then look products up locally ----
async function loadOpenRouterCatalog() {
  const json = await safeFetchJson('https://openrouter.ai/api/v1/models');
  const list = json?.data || [];
  const byId = new Map(list.map((m) => [m.id, m]));
  console.log(`[openrouter] loaded ${byId.size} models`);
  return byId;
}

function openRouterPricing(model) {
  if (!model) return null;
  const promptPer1M = Number(model.pricing?.prompt) * 1_000_000;
  const completionPer1M = Number(model.pricing?.completion) * 1_000_000;
  return {
    costInput1M: Number.isFinite(promptPer1M) ? `$${promptPer1M.toFixed(3).replace(/\.?0+$/, '')}` : null,
    costOutput1M: Number.isFinite(completionPer1M) ? `$${completionPer1M.toFixed(3).replace(/\.?0+$/, '')}` : null,
    contextWindow: model.context_length ? formatContext(model.context_length) : null
  };
}

// Model slugs get renamed/retired over time. `candidates` may be a single
// string or an array of strings to try in order. We first check the bulk
// catalog (fast, one request total), then fall back to the single-model
// endpoint, which OpenRouter resolves aliases and redirects through — this
// catches renamed/legacy slugs the bulk list snapshot might not include.
async function resolveOpenRouterModel(candidates, catalog) {
  const ids = Array.isArray(candidates) ? candidates : [candidates];
  for (const id of ids) {
    if (!id) continue;
    if (catalog.has(id)) return catalog.get(id);
    const single = await safeFetchJson(`https://openrouter.ai/api/v1/model/${id}`);
    if (single?.data) {
      console.log(`[openrouter] resolved "${id}" via alias lookup -> ${single.data.id}`);
      return single.data;
    }
  }
  console.warn(`[openrouter] no match for any of: ${ids.join(', ')}`);
  return null;
}

function formatContext(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// ---- GitHub: stars as an open-source adoption signal ----
async function fetchGithubStars(repo) {
  const json = await safeFetchJson(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
    }
  });
  if (!json || typeof json.stargazers_count !== 'number') return null;
  return {
    metric: 'github_stars',
    value: json.stargazers_count,
    sourceLabel: `★ GitHub stars`,
    sourceUrl: `https://github.com/${repo}`
  };
}

// ---- Hugging Face: downloads as an open-weight adoption signal ----
async function fetchHfDownloads(modelId) {
  const json = await safeFetchJson(`https://huggingface.co/api/models/${modelId}`);
  if (!json || typeof json.downloads !== 'number') return null;
  return {
    metric: 'hf_downloads',
    value: json.downloads,
    sourceLabel: `HF downloads (30d)`,
    sourceUrl: `https://huggingface.co/${modelId}`
  };
}

// ---- Cloudflare Radar: domain popularity rank (optional, best-effort) ----
async function fetchRadarRank(domain) {
  if (!CLOUDFLARE_API_TOKEN) return null;
  const json = await safeFetchJson(
    `https://api.cloudflare.com/client/v4/radar/ranking/domain?domain=${encodeURIComponent(domain)}`,
    { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } }
  );
  const rank = json?.result?.rank ?? json?.result?.top?.[0]?.rank;
  if (typeof rank !== 'number') return null;
  // Lower rank = more popular. Invert to a 0-100-ish "popularity" score so it
  // sorts the same direction as stars/downloads (higher = more popular).
  const value = Math.max(0, Math.round(1_000_000 / rank));
  return {
    metric: 'radar_rank',
    value,
    sourceLabel: `Cloudflare Radar rank #${rank.toLocaleString()}`,
    sourceUrl: `https://radar.cloudflare.com/domains/domain/${domain}`
  };
}

async function resolveAdoptionSignal(sources) {
  if (sources.github) {
    const r = await fetchGithubStars(sources.github);
    if (r) return r;
  }
  if (sources.huggingface) {
    const r = await fetchHfDownloads(sources.huggingface);
    if (r) return r;
  }
  if (sources.radarDomain) {
    const r = await fetchRadarRank(sources.radarDomain);
    if (r) return r;
  }
  return null;
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
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  let previous = { products: [] };
  try {
    previous = JSON.parse(await readFile(OUTPUT_PATH, 'utf-8'));
  } catch {
    console.log('[info] no existing data.json yet — starting fresh');
  }
  const previousById = new Map((previous.products || []).map((p) => [p.id, p]));

  const openRouterCatalog = await loadOpenRouterCatalog();

  const products = [];
  for (const item of config) {
    const prev = previousById.get(item.id);
    const orModel = item.sources.openrouter
      ? await resolveOpenRouterModel(item.sources.openrouter, openRouterCatalog)
      : null;
    const pricing = openRouterPricing(orModel) || {};

    const adoption = await resolveAdoptionSignal(item.sources);
    const history = adoption ? pushHistory(prev?.history, adoption.value) : (prev?.history || []);
    const change = percentChange(history);

    products.push({
      id: item.id,
      name: item.name,
      category: item.category,
      url: item.url,
      badge: item.badge,
      description: item.description,
      tech: {
        pricingModel: item.pricingModel,
        costInput1M: pricing.costInput1M ?? prev?.tech?.costInput1M ?? null,
        costOutput1M: pricing.costOutput1M ?? prev?.tech?.costOutput1M ?? null,
        contextWindow: pricing.contextWindow ?? prev?.tech?.contextWindow ?? null
      },
      adoption: adoption
        ? { metric: adoption.metric, value: adoption.value, sourceLabel: adoption.sourceLabel, sourceUrl: adoption.sourceUrl }
        : prev?.adoption ?? null,
      history,
      changePct: change,
      lastUpdated: new Date().toISOString()
    });

    console.log(`[ok] ${item.id}: adoption=${adoption ? adoption.value : 'n/a'} price_in=${pricing.costInput1M ?? 'n/a'}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    products
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`[done] wrote ${OUTPUT_PATH.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
