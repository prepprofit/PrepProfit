# AI Photo Extraction — Next-Session Kickoff

**Purpose:** cold-start handoff after Phases 0–5 landed. Read this first, then the
plan (`docs/ai-photo-extraction-improvement-plan.md`).

**Last updated:** 2026-06-28

---

## Where things stand

- Feature branch `feat/ai-photo-extraction-v2` is **MERGED to `main` (ff) and PUSHED**;
  Vercel production deploy is **Ready**. Repo is back to `main`-only (branch deleted).
- **Phases 0–5 DONE.** Editable no-loss photo draft → server-side stage endpoint →
  existing confirm path. Eval harness + pure metrics shipped.
- **Gates G1, G2, G3, G4, G6 met.** **G5 PASSES live** on the mandatory Baklava photo
  (`npm run eval:extraction`): line recall 100 %, correctable 100 %, ready 100 %,
  hallucination 0 %, silent-loss 0 %.
- Extraction model is **`gemini-2.5-flash`** (swapped from `gemini-3.5-flash`, which
  returns chronic 503s under load). Single source of truth:
  `RECIPE_EXTRACTION_MODEL` in `lib/ai/recipe-extraction.ts`.

### Working agreement (unchanged)
One small conventional commit per slice; **STOP after each slice for review**. Gate
each slice with `npm run lint && npm run typecheck && npm test` (+ `npm run build`
when a route/UI changes). The owner wants a short plan to approve BEFORE coding.

### Local env gotcha (already fixed, but be aware)
`.env.local` must keep `GEMINI_API_KEY` on its own well-formed line. A bare label line
(e.g. `Gemini` without a `#`) makes Node's `process.loadEnvFile` STOP parsing, so the
key below it never loads. The key is a valid non-`AIza` 53-char key (REST `/models` →
200). Vercel stores it **Sensitive**, so `vercel env pull` returns it EMPTY — it cannot
be read via CLI; it must live in local `.env.local` to run the eval.

---

## What's left (suggested order)

### 1. Visual smoke test of the workbench ✅ DONE (2026-06-28, live in PRODUCTION)
The owner ran the full UI click-flow manually against production and **it passed
end to end**: upload → review workbench (all 11 active Baklava lines, needs_review
where expected) → edit/stage → confirm created the recipe, and the new ingredients
landed at `priceCents = 0` / `needsPricing = true`. The flow had only ever been
covered by integration tests + build + the provider eval before this.
- Surfaces exercised: `app/(app)/recipes/import/photo/photo-workbench.tsx`, the route
  `app/api/recipes/import/photo/route.ts`, stage `…/stage/route.ts`.
- Next time a deeper local re-run is wanted, drive it with the preview_* tools
  (needs Clerk auth + `GEMINI_API_KEY` in `.env.local`).

### 2. Broaden the eval set to the §9.2 target (marketing-grade G5) ✅ DONE (2026-06-28)
The full **20-photo** §9.2 set is built and **PASSES the live §9.3 gate** on a Tier-1
Gemini key: line recall 100%, correctable 98.2%, ready 98.0%, hallucination 0.0%,
silent-loss 0.0% (20/20 fixtures). Set composition: 4 printed, 3 multi-section, 3
package-heavy, 2 non-English (PT/FR), 6 handwritten (incl. Baklava), 2 low-light.
- Goldens in `eval/extraction/fixtures/*.json`, all transcribed from the real images;
  `manifest.json` has all 20 with `sha256` pinned; images stay gitignored.
- Run with `npm run eval:extraction` (needs `GEMINI_API_KEY` in `.env.local`).
- ⚠️ **Free-tier Gemini cannot run the full set** (5 req/min + 20 req/day). The owner
  enabled billing (Tier 1) to run all 20 at once. If re-running on free tier, batch it.
- ⚠️ Two non-gated soft spots remain (not launch blockers): **unit field accuracy ~82%**
  (PT/FR units like "colher de chá"/"c. à café" and pack descriptors the model doesn't
  normalize) and **latency p95 ~16.5 s vs the §9.3 < 12 s target** (reported, NOT gated).
  To tune: image downscaling before upload, or a unit-synonym pass; revisit only if a
  product decision needs the P95.

### 3. Phase 6 — supplier pack integration ✅ DONE (2026-06-28, on `main`, not pushed)
Resolves package descriptors (`1 pkt phyllo`, `1 block butter`, `300g bag walnuts`)
against `ingredient_suppliers` pack metadata. Shipped in three slices:
- **Slice 1 (`d412cad`)** — pure `lib/ai/supplier-pack-resolve.ts` `resolveSupplierPack`:
  resolves only purchase-container descriptors (pkt/bag/block/can/…), never portion
  words (clove/slice/…); needs exactly one distinct usable pack; never carries a price.
- **Slice 2 (`8a5f869`)** — wired into the EXTRACTION route (not stage — the workbench
  blocks Stage on needs_review, so inference must reach the returned draft). New
  `loadSupplierPacksByIngredientName` (org-scoped) + pure `applySupplierPacks`; audits a
  PII-free `packsResolved` count.
- **Slice 3 (`0a308e4`)** — display-only `packageSizeInferred` flag + a "From your
  supplier — please check" hint in the workbench, cleared when the chef edits the pack.

Rules held (plan §6/§13): `needsPricing` preserved; **never auto-prices from AI text** —
only the recipe line's quantity canonicalizes; new AI ingredients still start at
`priceCents = 0`. Stage unchanged (the pack arrives on the line; `canonicalPackageSize`
re-validates). ⚠️ The supplier-inferred hint has not been visually verified in a browser
yet (same Clerk-auth blocker) — covered by integration tests + types.

Phases 0–6 are now COMPLETE. The only remaining track is the 20-photo eval set above (#2).

---

## Quick commands

```sh
npm run eval:extraction                 # live G5 run (needs key + ≥1 image)
npm run eval:extraction -- --fixture baklava
npm run eval:extraction -- --json
npm run lint && npm run typecheck && npm test && npm run build
```

## Key files
- Pure mapper / no-loss contract: `lib/ai/photo-draft.ts` (+ `…/types.ts`)
- Provider seam + prompt + model id: `lib/ai/recipe-extraction.ts`
- Eval metrics (pure, CI-safe): `lib/ai/eval/metrics.ts`
- Eval fixtures loader: `lib/ai/eval/fixtures.ts`
- Live runner: `scripts/eval-extraction.ts`
- Routes: `app/api/recipes/import/photo/route.ts` + `…/stage/route.ts`
- UI: `app/(app)/recipes/import/photo/photo-workbench.tsx`
- The plan: `docs/ai-photo-extraction-improvement-plan.md`
