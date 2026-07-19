# Open Food Facts Integration Plan

**Project:** PrepProfit  
**Status:** Approved for implementation  
**Last revised:** 2026-07-19  
**Scope:** USDA + Open Food Facts multi-provider nutrition integration for the European launch

## 1. Outcome

Add European packaged-food coverage without replacing USDA and without using the Open Food Facts API as a bulk catalog feed.

| User need | Primary source | Fallback |
|---|---|---|
| Generic ingredient such as flour, eggs, carrots | USDA Foundation / SR Legacy | Manual profile |
| European packaged product with EAN/GTIN | Open Food Facts | Manual profile |
| Branded product without a barcode | Future local European catalog | USDA Branded or manual profile |
| Missing or unreliable external data | Manager-reviewed manual profile | None |

The MVP is an exact barcode lookup. European text search is a separate future workstream powered by official exports, not by crawling the API.

## 2. Non-negotiable reuse rules

These rules follow the Open Food Facts guides:

- [Reusing Open Food Facts Data](https://wiki.openfoodfacts.org/Reusing_Open_Food_Facts_Data)
- [Current API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [License guidance](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/)
- [Barcode normalization](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-barcode-normalization/)

Implementation rules:

1. Use the API only for individual, user-initiated product lookups and refreshes.
2. Do not crawl barcodes, enumerate products, preload a catalog, or perform bulk synchronization through the API.
3. Cache only products that users actually request.
4. Do not run automatic mass refreshes of saved products.
5. Use Parquet or JSONL exports for any future searchable European catalog.
6. Use the JSONL delta exports to update that future catalog.
7. Use the website's advanced search only for exploration or small fixture sets, never as the production backend.
8. Complete an ODbL review before importing any bulk export.
9. Display the required Open Food Facts attribution wherever its data is presented.
10. Do not add product images to the MVP. Images have separate CC BY-SA obligations and may contain other protected elements.

## 3. Existing invariants that must be preserved

The current USDA implementation already establishes the correct security model:

- The external client is server-only.
- External payloads are untrusted and parsed with Zod.
- Missing nutrients remain `null`; they never silently become zero.
- Search and detail calls have timeouts and limited retry behavior.
- Only managers can edit nutrition profiles.
- Rate limiting occurs before the external request.
- Saving a provider result resolves the food again on the server; browser-supplied nutrient values are not trusted.
- The ingredient row is locked before UPSERT.
- All business mutations are organization-scoped and audited.
- One active nutrition snapshot exists per ingredient.
- A saved snapshot changes only through an explicit manager action.
- Allergens remain independent from nutrition data.

Relevant existing files:

- `lib/usda/client.ts`
- `app/(app)/ingredients/nutrition-actions.ts`
- `lib/data/ingredient-nutrition.ts`
- `lib/validation/ingredient-nutrition.ts`
- `lib/db/schema.ts`
- `lib/calculations/nutrition.ts`
- `lib/data/recipe-nutrition-tree.ts`
- `components/app/recipes/workspace/recipe-nutrition-tab.tsx`
- `lib/rate-limit/config.ts`
- `lib/action-result.ts`

Do not build a second independent Open Food Facts persistence flow. Generalize the existing nutrition source flow.

## 4. Target architecture

### 4.1 Interactive MVP

```text
Manager enters or scans EAN/GTIN
                |
                v
Validate barcode locally
                |
                v
Fresh persistent cache lookup
        | hit                 | miss
        v                     v
Return normalized data   Open Food Facts API
                              |
                              v
                    Zod parse + normalization
                              |
                              v
                     Preview and warnings
                              |
                              v
                    Manager confirms product
                              |
                              v
             Server resolves provider detail again
                              |
                              v
                Locked, audited profile UPSERT
```

"Resolves again" means the server obtains the authoritative normalized snapshot by provider identifier. A fresh server-side cache entry may satisfy that resolution; values posted by the browser may not.

### 4.2 Future European name search

```text
Official Parquet/JSONL full export
                |
                v
Offline validation and EU-country filtering
                |
                v
Separate product catalog/search index
                |
                v
Daily JSONL delta application
```

This flow is explicitly outside the MVP.

## 5. Provider-neutral domain contract

Create a provider-neutral module, for example `lib/external-food/types.ts`:

```ts
export type NutritionProviderId = 'usda' | 'open_food_facts';

export type ExternalFoodQuality = 'complete' | 'partial' | 'rejected';

export type NutritionBasis = {
  quantity: 100;
  unit: 'g' | 'ml';
};

export type ExternalFoodSnapshot = {
  provider: NutritionProviderId;
  externalId: string;
  barcode: string | null;
  description: string;
  brandOwner: string | null;
  sourceCountry: string | null;
  sourceLanguage: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: Date | null;
  basis: NutritionBasis;
  nutrients: Record<NutrientKey, number | null>;
  derivedFields: NutrientKey[];
  qualityStatus: ExternalFoodQuality;
  qualityWarnings: string[];
  normalizationVersion: number;
};

export type ProviderCapabilities = {
  textSearch: boolean;
  barcodeLookup: boolean;
  refresh: boolean;
};
```

Initial capabilities:

| Provider | Text search | Barcode lookup | Refresh |
|---|---:|---:|---:|
| USDA | Yes | No | Yes |
| Open Food Facts | No in MVP | Yes | Yes |

Do not force the different providers into one method. A small provider registry may expose separate `searchByText`, `lookupByBarcode`, and `getByExternalId` capabilities.

## 6. Database migration

### 6.1 Changes to `ingredient_nutrition_profiles`

Extend `source` to:

```text
usda
open_food_facts
custom
```

Add:

| Column | Type | Purpose |
|---|---|---|
| `external_source_id` | text | FDC ID or normalized GTIN; strings preserve leading zeroes |
| `external_source_type` | text nullable | USDA data type or provider-specific subtype |
| `barcode` | text nullable | Normalized product code |
| `source_country` | text nullable | Country context used for the lookup |
| `source_language` | text nullable | Source/product language |
| `source_revision` | text nullable | Provider revision if available |
| `normalization_version` | integer | Version of PrepProfit's mapping logic |
| `source_payload_hash` | text nullable | Debug/audit identity without storing the raw body |
| `quality_status` | text nullable | `complete`, `partial`, or `rejected` |
| `quality_warnings` | jsonb nullable | Stable warning codes, not translated sentences |
| `salt_g` | numeric nullable | European salt value per profile basis |

Keep existing source description, brand, source-updated time, refresh time, updater and nutrient columns.

### 6.2 Zero-downtime sequence

1. Add nullable columns and update TypeScript source unions.
2. Backfill `external_source_id = fdc_id::text` for USDA profiles.
3. Backfill `external_source_type = fdc_data_type`.
4. Deploy dual-read and dual-write support.
5. Migrate refresh, audit, recipe tree and UI reads to generic identity.
6. Observe production for at least one release cycle.
7. Remove `fdc_id` and `fdc_data_type` only in a later migration.

The first migration must be backward-compatible with the currently deployed application. Do not rename or drop the old columns in the first release.

### 6.3 Cache table

Add a public reference-data table outside the organization business tables:

```text
external_food_cache
- provider
- external_id
- normalized_payload
- source_updated_at
- fetched_at
- expires_at
- normalization_version
- payload_hash
```

Constraints:

- Unique key on `(provider, external_id)`.
- This table contains no organization data, user data, search history or pricing data.
- Document explicitly why it is not subject to organization RLS.
- Do not store full external responses unless a separate review approves it.
- Prefer a validated normalized JSON payload.

## 7. Open Food Facts client

Suggested new files:

```text
lib/open-food-facts/client.ts
lib/open-food-facts/schemas.ts
lib/open-food-facts/normalize.ts
lib/open-food-facts/barcode.ts
```

Requirements:

- Server-only module.
- Pin the API version in one constant. Start the spike against v3.6.
- Verify the current v3.6 nutrition schema against its official OpenAPI reference before finalizing Zod schemas.
- Do not assume the deprecated v2 `nutriments` structure is the authoritative v3.6 contract.
- Send a custom `User-Agent` in the documented `AppName/Version (ContactEmail)` form.
- Send `Accept: application/json`.
- Request only documented fields needed by PrepProfit.
- Ignore unknown additive fields.
- Reject incompatible changes to required fields.
- Use a 5-8 second timeout.
- Retry once on network error or 5xx, with a small jitter.
- Do not automatically retry `400`, `404` or `429`.
- Respect `Retry-After` where present.
- Never log credentials, raw payloads or complete request URLs if they could expose user-entered data.
- Provide a test hook to reset any in-process cache.

Environment variables:

```text
OPEN_FOOD_FACTS_ENABLED
OPEN_FOOD_FACTS_BASE_URL
OPEN_FOOD_FACTS_USER_AGENT
```

Read access does not require an API key. The user agent and contact identity are mandatory operational configuration, not browser-visible values.

## 8. Barcode handling

Treat every barcode as a string from UI to database.

Support initially:

- EAN-8
- EAN-13 / GTIN-13
- UPC-A
- GTIN-14 when the API identifies a supported food product

Local validation:

1. Trim whitespace.
2. Remove only explicitly accepted visual separators.
3. Reject non-digits after sanitization.
4. Enforce supported lengths.
5. Validate the check digit where applicable.
6. Preserve leading zeroes.
7. Send the string to Open Food Facts.
8. Store the normalized code returned by the provider.

Never convert a barcode to a JavaScript number or a PostgreSQL integer.

## 9. Nutrition normalization

### 9.1 Initial mapping

| Open Food Facts value | PrepProfit field | Transformation |
|---|---|---|
| Energy in kcal | `caloriesKcal` | Direct |
| Energy only in kJ | `caloriesKcal` | `kJ / 4.184`, mark derived |
| Fat | `totalFatG` | Direct |
| Saturated fat | `saturatedFatG` | Direct |
| Carbohydrate | `totalCarbohydrateG` | Direct |
| Sugars | `totalSugarsG` | Direct |
| Fiber | `dietaryFiberG` | Direct |
| Protein | `proteinG` | Direct |
| Salt | `saltG` | Direct |
| Sodium in grams | `sodiumMg` | Multiply by 1,000 |
| Salt when sodium is absent | `sodiumMg` | `saltG / 2.5 * 1,000`, mark derived |

Commonly absent European-label values must remain `null`, including trans fat, cholesterol, added sugars and many micronutrients.

Do not infer an absent nutrient as zero. Do not calculate optional nutrients from the ingredient list.

### 9.2 Plausibility

Reuse the existing per-nutrient validation ceilings where applicable. Add explicit consistency checks:

- Values must be finite and non-negative.
- Macro values must respect the supported 100 g/100 ml bounds and documented tolerance.
- Derived kcal must remain within the existing calorie ceiling.
- Sodium and salt must not contradict each other outside a defined rounding tolerance.
- A rejected field remains `null` and adds a quality warning; severe contradictions reject the product snapshot.

Increment `normalizationVersion` whenever mapping or derivation behavior changes.

## 10. The 100 g versus 100 ml gate

The existing recipe nutrition calculation is mass-based and intentionally does not assume `1 ml = 1 g`.

Rules:

- Data based on 100 g can feed the current profile contract directly.
- Data based on 100 ml must not be relabeled as 100 g.
- If an ingredient has an explicit weight-volume equivalency, the server may convert the profile and record the original basis and derivation.
- Without an equivalency, show the product preview but block nutrition-profile confirmation.
- Direct the manager to add the required density/equivalency.
- Never assume water density.

The first implementation spike must capture at least one real beverage fixture and prove the basis detection end-to-end.

## 11. Quality classification

### Complete

- Valid code.
- Product name present.
- Recognized nutrition basis.
- Energy present.
- Most core European nutrients are present.
- No severe provider data-quality errors.
- Values pass PrepProfit plausibility checks.

### Partial

- Valid product with some important nutrient values absent.
- Preview identifies every missing field.
- Saving requires explicit manager confirmation.
- Recipe calculations continue to report incomplete nutrients honestly.

### Rejected

- Missing product name.
- Ambiguous or unsupported nutrition basis.
- Invalid/non-finite/negative values.
- Severe contradictions or provider quality errors.
- Incompatible response schema.
- Redirect/result identifies a non-food product.

Rejected products cannot be saved as external-source profiles. Manual entry remains available.

## 12. Allergens

Do not import Open Food Facts allergens into the active allergen model in the MVP.

- Absence of allergen data never means allergen-free.
- Do not infer "free from" claims.
- Do not merge `contains` and `may contain`.
- Keep nutrition and allergens independently sourced and reviewed.

A future allergen feature may show provider data only as manager-review suggestions with explicit provenance and confirmation.

## 13. Cache, rate limiting and resilience

### Cache policy

- Fresh for 24 hours.
- May serve stale data for up to 30 days only when the provider is unavailable.
- Mark stale use internally and show an appropriate warning where relevant.
- Explicit refresh attempts a provider resolution.
- Saved ingredient profiles remain snapshots and do not change when cache entries change.
- Never preload cache entries from guessed or imported barcode lists.

### Rate limits

Create an `openFoodFactsRead` bucket separate from `usdaSearch`.

Enforce both:

- Per organization + user interactive limit.
- Global application limit keyed consistently in the existing database-backed limiter.

Start with a global ceiling of 10 requests/minute, leaving margin under the documented 15 product reads/minute/IP. Make this value easy to tune without sharing the USDA bucket.

### Circuit breaker

- Open after a defined number of consecutive provider/network failures.
- While open, return fresh/stale cache if eligible or a stable unavailable error.
- Probe after a cooldown.
- Never open on ordinary product `404` responses.

## 14. Server actions and validation

Refactor/add:

```text
searchExternalFoodsAction             # USDA text search
lookupExternalFoodByBarcodeAction     # Open Food Facts exact lookup
saveIngredientNutritionAction         # USDA, OFF or custom
refreshIngredientNutritionAction      # Dispatch by stored provider identity
```

Required action flow:

1. Check manager authorization before data access.
2. Zod-parse the input.
3. Resolve organization and user on the server.
4. Enforce the appropriate rate limits.
5. Call the external provider outside any database transaction.
6. Convert the result to `ExternalFoodSnapshot`.
7. For save, accept only provider + external ID/barcode from the browser.
8. Resolve authoritative provider detail on the server.
9. Enter `withOrg`, lock the active ingredient and UPSERT the snapshot.
10. Write an audit event with ingredient ID, provider, external ID, quality and normalization version; do not put the complete nutrients in audit metadata.
11. Revalidate recipes and ingredients surfaces.

Replace `getUsdaProfileIdentity` with a generic identity function while keeping compatibility during the migration.

Suggested stable error codes:

```text
INVALID_BARCODE
OPEN_FOOD_FACTS_DISABLED
OPEN_FOOD_FACTS_UNAVAILABLE
EXTERNAL_PRODUCT_NOT_FOUND
EXTERNAL_PRODUCT_INVALID
EXTERNAL_PRODUCT_PARTIAL
NUTRITION_BASIS_UNSUPPORTED
NUTRITION_EQUIVALENCY_REQUIRED
```

Map provider implementation details to stable product-level errors at the action boundary.

## 15. User experience

Refactor the existing nutrition dialog into three clear paths:

### Generic ingredient

- Existing USDA search.
- Existing Common and Branded scopes.

### Packaged product

- EAN/GTIN input.
- Explicit Search button; no search-as-you-type.
- Optional camera scanner is a follow-up, not required for the first release.

### Manual

- Existing custom nutrient form.

The Open Food Facts preview should show:

- Product name and brand.
- Package quantity when available.
- Normalized barcode.
- Product language.
- Countries where the product is reported as sold.
- Nutrition basis: 100 g or 100 ml.
- Available core nutrient values.
- Missing values.
- Quality warnings.
- Source update/fetch date.
- Open Food Facts attribution and source link.

Do not describe `countries_tags` as manufacturing origin. It is relevance/market information.

Do not automatically replace a missing packaged product with generic USDA nutrition.

## 16. License and attribution

MVP requirements:

- Read-only Open Food Facts integration.
- Visible "Data from Open Food Facts" attribution.
- Link to the original product/source where feasible.
- Link to applicable database license information.
- Add Open Food Facts to PrepProfit's data-sources/legal page.
- Preserve provider attribution on nutrition details and generated reports that expose the imported data.
- Keep the existing "estimate, not a compliance claim" positioning.

Bulk-catalog gate:

Before downloading or incorporating the complete/filtered export into a production catalog:

1. Review ODbL obligations for the intended database architecture and distribution model.
2. Determine whether the resulting catalog is a derivative database.
3. Define what must be offered under share-alike terms, if applicable.
4. Keep the Open Food Facts reference catalog structurally separate from private organization, pricing, recipe and inventory data.
5. Record the approved decision in an architecture decision record.

No bulk catalog work starts before this gate is approved.

## 17. Testing plan

### Unit tests

- EAN-8, EAN-13, UPC-A and supported GTIN-14.
- Leading zero preservation.
- Invalid check digit.
- Open Food Facts Zod schemas.
- Every nutrient mapping and unit conversion.
- kJ-to-kcal derivation.
- Salt-to-sodium derivation and tolerances.
- Missing value remains `null`.
- Per-100-g versus per-100-ml detection.
- Plausibility and quality classification.
- Unknown additive API fields.
- Normalization version behavior.
- Cache key and TTL behavior.

### Integration/action tests

- Manager allowed; kitchen user forbidden before external/database access.
- Organization isolation.
- Server-side detail resolution before save.
- Browser-supplied external nutrient values ignored/rejected.
- Cache fresh, miss, expired and stale-on-error.
- Provider 404, 429, 5xx, timeout and malformed response.
- Circuit-breaker transitions.
- USDA save and refresh remain unchanged.
- Open Food Facts save and refresh.
- Custom save remains unchanged.
- Migration/backfill preserves existing USDA profiles.
- Audit metadata contains identifiers, not full nutrient payloads.

### Versioned fixtures

Include real-response-shaped, checked-in fixtures for:

- European solid food based on 100 g.
- Beverage based on 100 ml.
- Multilingual packaging.
- Partial nutrition.
- Severe data-quality warning/error.
- Product not found.
- UPC/EAN normalization with leading zeroes.
- Non-food redirect/result.
- Response with additional unknown fields.

Do not make normal CI depend on the live Open Food Facts API.

### End-to-end tests

- Barcode -> preview -> confirm -> recipe recalculates.
- Partial product requires explicit confirmation.
- Rejected product cannot be saved externally.
- A 100 ml product without equivalency is blocked.
- Adding the equivalency permits the reviewed flow.
- Refresh preserves provider identity and attribution.
- Feature flag disables the provider cleanly.
- Attribution is visible in the relevant UI/print surface.

### Standard repository checks

Run and pass:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e   # focused suite or full suite according to CI policy
```

## 18. Observability

Measure:

- Lookup count by provider/outcome.
- Cache hit/miss/stale rate.
- Provider latency p50/p95.
- 404, 429, 5xx, timeout and invalid-schema rate.
- Circuit-breaker state changes.
- Complete/partial/rejected products.
- Save confirmation/abandon rate.
- Refresh success/failure rate.

Do not record API credentials, cookies, complete payloads or full nutrient objects in error reporting.

Initial targets:

- Cache hit rate >= 70% after pilot warm-up.
- Cached lookup p95 < 300 ms.
- External lookup p95 < 3 seconds under normal provider health.
- Zero provider `429` responses in production.
- Invalid schema rate < 1%.
- Zero implicit 100 ml -> 100 g conversions.

## 19. Implementation work packages

### WP0 - Contract spike and ADR

Deliver:

- Confirmed v3.6 product-detail contract.
- Checked-in fixture set.
- Confirmed 100 g/100 ml detection.
- Confirmed quality fields.
- ADR covering interactive API versus future exports.
- Recorded ODbL bulk-catalog gate.

Estimate: 1-2 engineering days.

### WP1 - Provider-neutral persistence

Deliver:

- Backward-compatible schema migration.
- Provider-neutral types.
- USDA backfill.
- Dual-read/write.
- Generic profile identity and audit metadata.

Estimate: 2-3 days.

### WP2 - Open Food Facts backend

Deliver:

- Barcode validation.
- Client and schemas.
- Normalizer and quality classification.
- Persistent cache.
- Global/per-user rate limits.
- Circuit breaker and feature flag.

Estimate: 3-4 days.

### WP3 - Actions and refresh

Deliver:

- Barcode lookup action.
- Provider-neutral save.
- Provider-dispatched refresh.
- Stable error mapping.
- Authorization and audit tests.

Estimate: 2 days.

### WP4 - UX and localization

Deliver:

- Generic / Packaged / Manual modes.
- Barcode preview and warnings.
- Basis/equivalency gate.
- Attribution.
- All supported locale messages.

Estimate: 2-3 days.

### WP5 - Verification and rollout

Deliver:

- Unit, integration and focused E2E coverage.
- Observability dashboards/events.
- Feature-flagged pilot.
- Rollback verification.
- Production runbook update.

Estimate: 3-4 days.

Expected MVP total: 13-18 engineering days plus QA/review.

The searchable European export catalog is not included in this estimate.

## 20. Recommended PR sequence

Keep changes reviewable and rollback-safe:

1. **PR 1:** Contract fixtures, provider-neutral types and ADR; no behavior change.
2. **PR 2:** Additive schema migration, USDA backfill and dual-read/write.
3. **PR 3:** Barcode validator, Open Food Facts client, normalizer and unit tests.
4. **PR 4:** Persistent cache, rate limits, circuit breaker and observability.
5. **PR 5:** Server actions, save/refresh dispatch and authorization tests.
6. **PR 6:** UI, localization, attribution and E2E tests behind the feature flag.
7. **PR 7:** Pilot enablement and operational documentation.
8. **Later cleanup PR:** Remove legacy USDA-only identity columns after production validation.

Do not combine the additive migration and legacy-column removal in one PR.

## 21. Definition of Done

The MVP is complete only when:

- Existing USDA search, save and refresh pass without regression.
- A valid European EAN can be looked up, reviewed and saved.
- GTIN is a string throughout the stack.
- Provider results are resolved on the server before save.
- Browser-supplied external nutrient values are never trusted.
- Missing nutrients remain `null`.
- 100 ml is never treated as 100 g without an explicit equivalency.
- Open Food Facts cache contains only user-requested products.
- No API crawling, preload or bulk synchronization exists.
- A separate global rate limit protects the production egress IP.
- Snapshots carry provider identity, normalization version, quality and audit metadata.
- Open Food Facts attribution and license links are visible.
- The integration can be disabled immediately through a feature flag.
- Tests, typecheck, lint and production build pass.
- Production monitoring is active before feature enablement.
- Bulk export/catalog implementation remains blocked until the ODbL gate is approved.

## 22. Out of scope for the MVP

- Full-text Open Food Facts search through deprecated endpoints.
- Search-as-you-type against Open Food Facts.
- Bulk product crawling or cache prewarming.
- Parquet/JSONL catalog ingestion.
- Automatic product contribution/write-back to Open Food Facts.
- Product image storage/display.
- Automatic allergen imports or "free from" claims.
- Automatic replacement of missing packaged products with generic USDA values.
- Nutrition-label regulatory compliance certification.

