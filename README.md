# AIWO — AI World Order

Live catalog of AI models: every model on OpenRouter, refreshed twice a day,
with real pricing, context window, release date, and (for open-weight
models) real Hugging Face download counts.

## Why v2 looks different

The original design manually curated ~7 named products (ChatGPT, Claude,
Gemini...). That breaks constantly: vendors rename and retire specific model
versions every few months (Claude 3.5 Sonnet, for example, was fully retired
in January 2026 — it no longer exists to query, anywhere).

v2 instead mirrors OpenRouter's **entire** public model catalog every run.
There's nothing to hand-maintain and nothing that can go stale — whatever
OpenRouter is currently serving is what shows up here.

## Data sources

| What | Source | Auth needed |
|---|---|---|
| Full model list, pricing, context window, release date | [OpenRouter Models API](https://openrouter.ai/docs) (`/api/v1/models`) | none (public) |
| Real download counts for open-weight models | Hugging Face Models API, via the `hugging_face_id` OpenRouter provides per model | none (public) |

Models with no Hugging Face link (i.e. most proprietary/closed models) show
**"No public data"** for adoption instead of an invented number — that's
expected, not a bug.

## One-time setup

1. Upload these files to the repo root:
   - `index.html`
   - `data.json`
   - `data/pinned.json` (optional — leave as `[]`)
   - `scripts/fetch-data.mjs`
   - `.github/workflows/update-data.yml`
2. Enable GitHub Pages: *Settings → Pages* → Deploy from branch → `main` → `/root`.
3. Run the pipeline once manually: *Actions → Update AIWO data → Run workflow.*
   The first run takes a bit longer (fetches downloads for every open-weight
   model), later runs are faster since only the diff changes.

From then on it runs automatically at 06:00 and 18:00 UTC.

## Optional: pin/highlight a specific model

Edit `data/pinned.json`:

```json
[
  { "id": "anthropic/claude-sonnet-4.5", "badge": "Editor's Pick" }
]
```

Use the exact OpenRouter model `id` (visible in the URL of any model's
detail page in the app, or at openrouter.ai/models). Anything not listed
here just shows with no badge — this file is entirely optional.

## Local preview

`index.html` does `fetch('./data.json')`, which browsers block on a
`file://` URL. Serve locally instead:

```bash
python3 -m http.server 8000
```
