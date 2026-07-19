# Open Food Facts — operations runbook

Operational guide for the barcode-nutrition integration. Plan:
`docs/open-food-facts-integration-plan.md` · ADR:
`docs/adr-open-food-facts-integration.md`.

## What it is

Manager-initiated, exact **barcode** nutrition lookup (EAN-8 / UPC-A / EAN-13 /
GTIN-14) against the Open Food Facts (OFF) v3 read API, reusing the existing USDA
nutrition persistence/audit flow. There is **no** text search, crawling, preload,
or bulk sync — a single user-requested lookup per barcode (plan §2).

## Enable / disable (feature flag)

The provider is **off by default**. It is active only when BOTH are set:

| Variable | Required | Notes |
|---|---|---|
| `OPEN_FOOD_FACTS_ENABLED` | yes | `true` / `1` / `yes` to enable |
| `OPEN_FOOD_FACTS_USER_AGENT` | yes | `AppName/Version (ContactEmail)` — mandatory per OFF guidelines |
| `OPEN_FOOD_FACTS_BASE_URL` | no | defaults to `https://world.openfoodfacts.org` |

- **Enable (pilot):** set the two required vars in Vercel → redeploy. The
  packaged-product tab appears in the ingredient nutrition dialog.
- **Disable immediately (kill switch):** set `OPEN_FOOD_FACTS_ENABLED` to
  anything falsy (or unset it) → redeploy. The action returns
  `OPEN_FOOD_FACTS_DISABLED`, the UI shows the disabled note, and USDA + manual
  entry are unaffected. **Saved profiles are unchanged** — they are snapshots.

No API key exists to rotate. The User-Agent contact email is the only identity.

## Rate limits (protect the shared egress IP)

Two Postgres-backed buckets (`lib/rate-limit/config.ts`), both enforced BEFORE any
outbound request:

- `openFoodFactsRead` — per org+user, 20/min (interactive burst control).
- `openFoodFactsGlobal` — **global**, 10/min, under OFF's documented 15
  reads/min/IP. Tune this first if OFF ever returns 429s. Independent of the
  USDA bucket.

## Cache

`external_food_cache` (public reference table, no RLS, populated only by
user-requested lookups):

- **Fresh 24h**, then **serve-stale-on-error up to 30 days**.
- A row whose `normalization_version` differs from the current normalizer is a
  miss — bumping `NORMALIZATION_VERSION` (`lib/open-food-facts/normalize.ts`)
  transparently invalidates the whole cache.
- Stores only the validated normalized snapshot, never the raw provider body.
- Never preload/prewarm it (ODbL gate — see below).

## Circuit breaker

In-process, per server instance (`lib/open-food-facts/resolve.ts`): opens after
**5 consecutive** provider/network failures, cools down **30s**, then probes.
While open it serves eligible cache or a stable `OPEN_FOOD_FACTS_UNAVAILABLE`. It
**never** opens on an ordinary product 404.

## Monitoring

The resolver emits payload-free structured logs (`event: "off_lookup"`) with the
outcome (`cache_fresh`, `provider_ok`, `not_found`, `rejected`,
`provider_fail`/`_stale`, `breaker_open_*`), quality, and latency. Watch for:

- Rising `provider_fail` / `breaker_open_*` → OFF outage; stale cache covers it.
- Any `429` from OFF → lower `openFoodFactsGlobal`.
- `invalid schema` (INVALID_RESPONSE) spikes → OFF changed the contract; re-verify
  the Zod schema against the v3 reference and bump `NORMALIZATION_VERSION`.

Targets (plan §18): cache hit ≥70% after warm-up, cached p95 <300ms, external p95
<3s, zero 429s, invalid-schema <1%, zero implicit 100 ml→100 g conversions.

## The 100 ml gate

A per-100 ml product can only be saved for an ingredient that has a weight/volume
equivalency (density); otherwise the save returns `NUTRITION_EQUIVALENCY_REQUIRED`
and the UI directs the manager to add it. 100 ml is **never** assumed to weigh
100 g.

## Rollback

1. Flip `OPEN_FOOD_FACTS_ENABLED` off → redeploy (feature gone, data intact).
2. The additive DB migration (0043/0044) needs no rollback; the legacy USDA
   identity columns remain until the separate cleanup PR.
3. To purge cached rows if ever needed: `DELETE FROM external_food_cache WHERE
   provider = 'open_food_facts';` (safe — it only re-fetches on next lookup).

## BLOCKED until approved — ODbL bulk-catalog gate

No bulk export/catalog work (Parquet/JSONL download, EU filtering, searchable
catalog, prewarming) may start until the ODbL review in the ADR is approved and
recorded in a follow-up ADR. The codebase must contain no crawler or export
ingester.
