# ADR: Open Food Facts nutrition integration (interactive API, exports deferred)

**Status:** Accepted — 2026-07-19
**Context:** European launch needs packaged-food nutrition by barcode without
replacing USDA and without misusing the Open Food Facts (OFF) API.
**Plan:** `docs/open-food-facts-integration-plan.md`

## Decision

1. The MVP uses the OFF **read API only for individual, user-initiated barcode
   lookups and explicit refreshes**. No crawling, no barcode enumeration, no
   catalog preload, no bulk sync through the API (plan §2).
2. Any future searchable European catalog will be built from the official
   **Parquet/JSONL exports**, kept structurally separate from private org data,
   and is explicitly **out of scope** for this MVP (plan §4.2, §22).
3. The integration reuses the existing USDA nutrition persistence/audit flow via
   a **provider-neutral contract** (`lib/external-food/types.ts`), rather than a
   second independent Open Food Facts write path (plan §3).

## API contract we build against

- Endpoint: `GET {BASE_URL}/api/v3/product/{barcode}` (API pinned at **v3**).
- We request only the documented fields PrepProfit needs via `fields=` and
  **ignore unknown additive fields** (both new top-level keys and new
  `nutriments` keys), rejecting only incompatible changes to required fields.
- **Nutriments are read from the flat per-basis keys** (`energy-kcal_100g`,
  `energy-kj_100g`, `fat_100g`, `saturated-fat_100g`, `carbohydrates_100g`,
  `sugars_100g`, `fiber_100g`, `proteins_100g`, `salt_100g`, `sodium_100g`) plus
  `nutrition_data_per` (`100g` | `100ml`). The v3 read response continues to
  expose this flat form for backward compatibility; the nested per-nutrient
  object is a v3 **write** concern we do not use. This choice is captured in Zod
  schemas (`lib/open-food-facts/schemas.ts`) and is tolerant by construction —
  if OFF later drops the flat keys, the schema fails closed to
  `EXTERNAL_PRODUCT_INVALID` rather than mis-reading data.
- Fixtures proving the shape live in `lib/open-food-facts/__fixtures__/`
  (solid 100 g, beverage 100 ml, multilingual, partial, severe-quality,
  not-found, leading-zero UPC, non-food, unknown-fields). **CI never depends on
  the live API.**

## 100 g vs 100 ml gate

Confirmed via the `beverage-100ml` fixture: a product with
`nutrition_data_per: "100ml"` is detected as a volume basis, never relabeled as
100 g. Without an ingredient weight/volume equivalency the preview is shown but
profile confirmation is **blocked** (`NUTRITION_EQUIVALENCY_REQUIRED`); with an
equivalency the server converts and records the original basis (plan §10).

## Quality fields

`quality_status` ∈ {`complete`, `partial`, `rejected`} and stable
`quality_warnings` codes (`lib/external-food/types.ts`) are derived by the
normalizer, not by the provider. Rejected products cannot be saved as
external-source profiles; manual entry stays available (plan §11).

## ODbL bulk-catalog gate (BLOCKING)

No bulk export/catalog work — download, filtering, ingestion, or building a
searchable European catalog from Parquet/JSONL — starts until this gate is
approved (plan §16):

1. Review ODbL obligations for the intended database architecture and
   distribution model.
2. Determine whether the resulting catalog is a derivative database.
3. Define what must be offered under share-alike terms, if applicable.
4. Keep the OFF reference catalog structurally separate from private
   organization, pricing, recipe and inventory data.
5. Record the approved decision in a follow-up ADR.

Until then the codebase must contain **no** crawler, cache prewarmer, or export
ingester.

## Attribution (MVP obligation)

Wherever OFF data is presented (nutrition detail, generated reports), show
"Data from Open Food Facts", link to the source product where feasible, link to
the applicable database license, and add OFF to the data-sources/legal page.
Product images are **not** imported in the MVP (separate CC BY-SA obligations).

## Consequences

- Second provider ships with zero changes to the USDA path (dual-read/write over
  a generic identity).
- The production egress IP is protected by a **separate global** OFF rate limit
  (10 req/min ceiling, under the documented 15/min/IP) plus a per-org+user limit.
- The searchable European catalog remains a distinct, later, gated workstream.
