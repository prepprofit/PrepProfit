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

### 2. Broaden the eval set to the §9.2 target (marketing-grade G5)
Today only Baklava exists. The plan wants **20 photos**: 5 handwritten, 5 printed,
3 multi-section, 3 package-heavy, 2 low-light/blurry, 2 non-English. For each:
- Drop the image in `eval/extraction/images/<slug>.<ext>` (gitignored).
- Add a sanitized golden `eval/extraction/fixtures/<slug>.json` (see
  `lib/ai/eval/metrics.ts` `ExpectedRecipe`/`ExpectedLine`; aliases for name variants;
  `expectedStatus` = ready | needs_review | ignored).
- Add the `manifest.json` entry (pin `sha256` once the image is final — the runner
  prints the hash for `unpinned` fixtures).
- Re-run `npm run eval:extraction`. The launch gate (§9.3) is enforced in
  `checkThresholds`; silent-loss must stay 0.
- **Also watch latency:** the single Baklava call took ~20 s vs the §9.3 **< 12 s P95
  target** (latency is reported but NOT gated). If a fuller set confirms it's slow,
  consider image downscaling before upload, or revisit the model.

### 3. Phase 6 — supplier pack integration
Only after 0–5 are stable (they are). Resolve package descriptors (`1 pkt phyllo`,
`1 block butter`, `300g bag walnuts`) against `ingredient_suppliers` pack metadata.
Rules from the plan §6/§13: preserve `needsPricing` for anything without a trustworthy
cost; **never auto-price from AI text alone** unless the pack match is exact and
org-scoped. New ingredients from AI still default to `priceCents = 0`.

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
