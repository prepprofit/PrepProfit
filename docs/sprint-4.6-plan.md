# Sprint 4.6 — Recipe import + ingredient resolver (PLAN)

Status: **approved plan, not yet implemented.** Branch to use: `feat/sprint-4.6-recipe-import`.
Builds directly on Sprint 4.5 (deterministic import foundation, `import_jobs`, staged
preview→confirm). Read `PLANO.md` §"Sprint 4.6" and `CLAUDE.md` ("AI and import rules",
"Testing rules", Rule 1) before coding.

## 1. Goal & scope

Import recipes from a trusted structured file (CSV/XLSX) by reusing the 4.5 staging
foundation, resolving each ingredient name to an existing org ingredient (exact /
fuzzy-suggested) or staging a new one — always with human confirmation, never an
automatic write.

**In scope**
- `lib/import/resolveIngredient.ts` — pure, tested resolver: `exact | fuzzy | new`.
- Recipe CSV/XLSX templates (one row per recipe line, grouped by recipe name).
- Recipe import parser + Zod row schemas + staged preview reusing `import_jobs`
  (new `entity: 'recipes'`).
- Preview UI that lets the manager resolve fuzzy/new ingredients before confirm.
- Confirm action: creates new (unpriced) ingredients + recipes + lines in ONE
  transaction, re-checks the **recipe plan limit**, idempotent, org-scoped.
- New ingredients created by import default to `priceCents = 0` and are flagged as
  needing pricing.

**Out of scope (defer)**
- `.docx` table import → spike only if time permits; otherwise Sprint 4.7/backlog.
- AI/OCR/free-form extraction → Sprint 4.7.
- Recipe-level selling price + hidden costs (labour/energy/packaging) in the file →
  default to 0 on import; the manager fills them in the recipe editor afterwards.
- Updating EXISTING recipes via import → v1 only CREATES recipes.

## 2. Decisions to confirm (recommendation each)

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | **File shape** (recipes have a header + many lines). | **Long format, one row per line**, grouped by a `recipe` name column. Columns: `recipe, yield_portions, yield_percentage, ingredient, quantity, unit`. `yield_*` are optional and read from the FIRST row of each recipe group (blank → defaults 1 / 100). One row type only — far simpler than discriminator/2-sheet shapes. |
| D2 | **Fuzzy matching engine** (must be pure & tested). | Pure **trigram Dice-coefficient** similarity in `resolveIngredient.ts` over a candidate list passed in by the data layer (no DB in the pure fn). Threshold ≈ **0.7**; return top 3 suggestions sorted desc. (pg_trgm stays for live search; the resolver is self-contained so it unit-tests without a DB.) |
| D3 | **Fuzzy = never auto-link** (PLANO/acceptance). | A fuzzy outcome defaults to **"create new"** in the UI; linking to a suggestion requires an explicit manager choice. Exact matches auto-link (no decision). |
| D4 | **Unit handling.** | `unit` ∈ the `Unit` set (`g,kg,oz,lb,ml,l,floz,cup,count`; blank ⇒ `count`). Canonical = `quantity × toCanonical(unit)`. For a NEW ingredient the dimension is inferred via `dimensionOf(unit)`. For an EXISTING ingredient, a unit whose dimension ≠ the ingredient's dimension is a hard row issue (`UNIT_MISMATCH`); an unknown unit is `INVALID_UNIT`. |
| D5 | **"Needs pricing" flag.** | Add migration **0017**: `ingredients.needs_pricing boolean NOT NULL DEFAULT false`; import-created ingredients set it true; show a badge in `/ingredients`. (Alternative = treat `priceCents === 0` implicitly and skip the migration — but an explicit flag distinguishes "free" from "unpriced" and helps 4.7. Recommend the column.) |
| D6 | **Duplicate recipe name already in org.** | **Skip** with a soft `DUPLICATE_RECIPE` issue (conservative; avoids accidental dupes on re-import). The product *allows* duplicate recipe names, so this is an import-policy choice, revisitable. |
| D7 | **Confirm vs the recipe plan cap.** | All-or-nothing: `assertPlanLimit('recipes', countActiveRecipes + recipesToCreate)`. If it would exceed the cap → `PLAN_LIMIT_REACHED`, import nothing (deterministic). |
| D8 | **What the client sends to confirm** (4.5 "never trust client rows"). | Confirm payload = `{ jobId, resolutions }` where `resolutions` is a per-ingredient-name choice: `{action:'link', ingredientId}` or `{action:'create'}`. The server VALIDATES each choice against the job's STORED suggestions (a linked id must have been an offered suggestion for that name AND be an active org ingredient) — so the client can only pick among server-offered options or create-new (always priceCents 0). Rows themselves are never sent. |
| D9 | **`.docx`.** | Not in v1. Optional timeboxed spike at the end; ship only if a real-table parser is proven trivial. |

## 3. Data model / migrations

- `import_jobs.entity` is a plain `text` column (no DB CHECK — see `drizzle/0016`), so
  adding `'recipes'` to `ImportEntity` is a **TS-only** change (no migration).
- **Migration 0017** (only if D5 accepted): `ALTER TABLE ingredients ADD COLUMN
  needs_pricing boolean NOT NULL DEFAULT false;` — additive, safe. Watch the journal
  `when` gotcha: it must be **> 1781901704548** (0016's `when`). Update Drizzle types +
  `ingredientSchema` (optional, defaults false).
- New `normalized_rows` JSON shape for recipe jobs (stored typed in `lib/import/types.ts`):
  a list of recipes, each `{ name, yieldPortions, yieldPercentage, lines: [{ ingredientName,
  quantityCanonical, dimension, resolution }] }`, plus a per-distinct-ingredient
  `resolutions` map carrying the stored suggestions for server-side validation at confirm.

## 4. Implementation order (small conventional commits)

1. **Resolver (pure):** `lib/import/resolveIngredient.ts` + `normalizeIngredientName`
   (lowercase, trim, collapse ws, strip diacritics/punct) + trigram Dice. Unit tests:
   exact (accents/case/space), fuzzy ranking+threshold, new, ties. (no DB)
2. **Migration 0017 + needs_pricing** (D5): schema column, types, `ingredientSchema`,
   `/ingredients` badge. `db:generate`, fix journal `when`.
3. **Types + parser:** extend `ImportEntity` with `'recipes'`; recipe row Zod schemas in
   `lib/validation/import.ts`; `parseRecipes(matrix)` in `lib/import/parse.ts` — group
   lines by recipe, read yield from first row, validate quantity/unit, emit per-row
   issues (`INVALID_UNIT`, `UNIT_MISMATCH` is decided at plan time vs the existing
   ingredient, `MISSING_REQUIRED`, caps). Pure tests with fixtures.
4. **Templates:** recipe CSV/XLSX in `lib/import/templates.ts` (extend the entity maps);
   `/api/import/template?entity=recipes&format=…` already serves it via the existing
   route. Round-trip test.
5. **Data layer:** `lib/data/import.ts` `planRecipeImport(tx, org, parsed)` → resolve
   each distinct ingredient name against active org ingredients (exact link / fuzzy
   suggestions / new), detect duplicate recipe names (skip), validate units vs existing
   ingredient dimension, build the stored job payload + counts + issues. `applyRecipeImport`
   creates new ingredients (priceCents 0, needs_pricing true, deduped) then recipes +
   lines (reuse `addRecipeIngredient` for the active-row lock/invariant). PGlite tests:
   link/new/dedupe/dup-recipe/org-isolation.
6. **Actions:** reuse `app/(app)/import/actions.ts` — extend `previewImportAction` for
   `entity:'recipes'`; `confirmImportAction` accepts `{ jobId, resolutions }`, validates
   resolutions against the stored job, enforces the recipe cap (D7), applies all-or-nothing,
   audits `import.commit`. Tests: RBAC-before-data, idempotency, plan-limit race, forged
   resolution (non-offered/cross-org ingredientId rejected), cross-org job hidden.
7. **Preview UI:** extend `import-workbench.tsx` — for recipes, render an ingredient
   RESOLUTION panel (per distinct name: exact=auto, fuzzy=radio of suggestions + "create
   new", new=create-new) feeding the `resolutions` map into the confirm form; recipe/line
   grid; localized `import.*` additions. Mobile-friendly.
8. **Docs:** mark Sprint 4.6 tasks `[x]` in `PLANO.md`, production notes (migration 0017,
   prod `db:migrate`). Update memory.
9. **Gate + ship:** `npm run lint && npm run typecheck && npm test && npm run build`;
   apply migration 0017 to prod Neon; **confirm with the user before merge**; ff → `main`,
   delete branch.

## 5. Testing strategy (covers CLAUDE.md testing rules)

- **Resolver (pure):** exact/normalized/fuzzy(threshold+rank)/new; diacritic & whitespace
  insensitivity; no false auto-link.
- **Units:** every unit → canonical; unknown unit; unit/dimension mismatch vs existing.
- **Parser:** recipe grouping, yield-from-first-row, missing/invalid cells, row/file caps,
  formula-injection-safe (a `=cmd()` ingredient/note stays literal — reuse 4.5 readers).
- **RLS read+write:** recipe jobs org-isolated; created recipes/ingredients/lines scoped;
  cross-org ingredient link rejected by the composite FK.
- **RBAC:** preview/confirm/template return FORBIDDEN/403 before any data access.
- **Confirm:** idempotent (double confirm = one effect); recipe **plan-limit race**
  (N over cap → PLAN_LIMIT_REACHED, nothing written); forged `resolutions` (id not among
  offered suggestions, or another org's ingredient) rejected; all-or-nothing rollback.
- **Cost honesty:** a recipe with a new unpriced ingredient costs it at 0; cost rises once
  the ingredient is priced (live calc — no extra code, but assert it).

## 6. Reuse from Sprint 4.5 (do NOT rebuild)

`import_jobs` table + RLS; `readImportMatrix` + `csv.ts`/`xlsx.ts` readers (formula/macro
safe); the preview→confirm action skeleton + `import` rate bucket + `import.preview`/
`import.commit` audit actions; `lib/import/templates.ts` + the template download route;
`MAX_IMPORT_BYTES`/`MAX_IMPORT_ROWS`/`IMPORT_JOB_TTL_MS`; the FOR-UPDATE-lock idempotent
confirm pattern (`lib/data/import-jobs.ts`).

## 7. Acceptance criteria (from PLANO)

- Import a recipe sheet referencing existing AND new ingredients; existing ones link,
  new ones are staged as needing pricing, and recipe cost updates correctly once prices
  are filled.
- Fuzzy matches require explicit user confirmation (never auto-linked).
- Confirm is idempotent and cannot write outside the active org.
