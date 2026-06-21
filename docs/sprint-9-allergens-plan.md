# Sprint 9 — Allergens (operational) — implementation plan

> **Status:** **AUTHORIZED for LOCAL implementation (dev review — §5 decisions
> resolved, §11 mandatory corrections folded in). Ready to start cold in a new
> session.** First module after the Foundation (F1–F6 DONE & on `main`; prod migrated
> to 0023). Source spec: `docs/expansion-plan-kitchen-ops.md` v2.2 + owner scope:
> **operational only**, the compliance **CLAIM is withdrawn from v1**, recipe
> overrides **ADD / ESCALATE ONLY**.
>
> **Migration `0024` is LOCAL only — PROHIBITED in production until the diff is
> reviewed** (as every F-slice). Authorization is conditional on every §11 item +ed
> the §6 tests.

---

## 0. What Sprint 9 is — and the compliance boundary

Allergen awareness for the **kitchen**: tag ingredients with their allergens, roll
them up onto recipes automatically (derive-on-read, like recipe cost), and let a
recipe **add or escalate** allergens (cross-contamination, a process step). It is an
**operational** safety aid; allergens are not money, so F4's financial lockdown does
not hide them — kitchen sees and (audited) edits them.

**Boundary (owner decision):** v1 makes **no legal compliance claim**. The official
customer-facing allergen **declaration** (menu labelling, legally-binding statements)
is gated by an external **food-safety / legal sign-off** and is **OUT of v1**. That
sign-off blocks only the *claim*, never this operational feature. Every surface that
shows allergens carries a non-legal disclaimer and **never says "allergen-free"** —
even reviewed-and-empty reads **"no allergens recorded"** (§11.10).

---

## 1. The model

### A. Catalog — fixed list, single source of truth
- `lib/allergens/catalog.ts` — the **14 EU FIC allergens** (Reg (EU) 1169/2011 Annex
  II) as stable slugs, each with an i18n key `allergens.<slug>`. Same single-source
  pattern as `CATEGORY_SEED` / `FOLDER_ICONS`; a `z.enum(ALLERGEN_SLUGS)` guards
  writes **and** a DB `CHECK` repeats the 14-slug whitelist (§11.7).
  Slugs → labels (verify the legal wording against Annex II before any future *claim*;
  operational labels for v1): `cereals_gluten` "Cereals containing gluten",
  `crustaceans` "Crustaceans", `eggs` "Eggs", `fish` "Fish", `peanuts` "Peanuts",
  `soybeans` "Soybeans", `milk` "Milk", `nuts` "Tree nuts", `celery` "Celery",
  `mustard` "Mustard", `sesame` "Sesame", `sulphites` "Sulphur dioxide and sulphites",
  `lupin` "Lupin", `molluscs` "Molluscs". ⚠️ cereals (gluten), tree **nuts**, and
  sulphites wording especially must be confirmed against the official Annex II — the
  dev could not reach the source this session.

### B. Presence, NOT severity (§5.2 / §11)
- 2 levels — `may_contain` < `contains` — modelling **certainty of presence**, not
  clinical gravity (so the field is **`presence`**, never `severity`). `contains` =
  deliberate ingredient; `may_contain` = cross-contamination / traces. Pure
  `comparePresence` / `maxPresence` + a fixed `PRESENCE_ORDER`.

### C. Where allergens live (join tables, §5.1)
- **`ingredient_allergens (organization_id, ingredient_id, allergen, presence)`** —
  `unique (org, ingredient_id, allergen)`; composite FK `(org, ingredient_id) →
  ingredients` **ON DELETE cascade**; **DB CHECKs**: `allergen IN (<14 slugs>)` and
  `presence IN ('may_contain','contains')` (§11.7); in `businessTables` →
  `org_isolation`.
- **`recipe_allergen_overrides (organization_id, recipe_id, allergen, presence)`** —
  `unique (org, recipe_id, allergen)`; composite FK `(org, recipe_id) → recipes`
  **ON DELETE cascade**; same two CHECKs; in `businessTables`. An override row only
  ever **adds or escalates** (§1.F); there is no "suppress" row.
- **Review provenance (§5.3 / §11.3):** `ingredients.allergens_reviewed_at
  timestamptz NULL` + `allergens_reviewed_by text NULL` (Clerk user id). `reviewed`
  is **derived** = `reviewed_at IS NOT NULL`. The boolean alone would lose the who/
  when the parent plan requires.

### D. Recipe rollup — derive-on-read, returns both sides (§11.11, §11.12)
Pure `lib/calculations/allergens.ts`, mirroring `recipeCost.ts`:
- `recipeAllergens(lines, overrides)` → for each allergen present anywhere, return
  **`{ allergen, derivedPresence: Presence | null, overridePresence: Presence | null,
  effectivePresence: Presence }`** — keeping the two sides **separate** (a single
  `source` flag loses info when both contribute). `effectivePresence =
  max(derived, override)`.
- Result is **sorted by the fixed catalog order** (`PRESENCE`/slug index) so UI and
  PDF are deterministic (§11.12).
- **INVARIANT (safety):** `effectivePresence ≥ derivedPresence` always — an override
  can only raise. The guarantee is **`max()` at read time + the action guard**
  (§1.F), **not** "by construction": the DB does not know the derived rollup (§11.6).
- **Includes ALL referenced ingredients regardless of `deleted_at`** (mirror the
  recipe-cost join in `lib/data/recipes.ts`) — a trashed ingredient must never
  silently drop an allergen.
- Also surfaces **`hasUnreviewedIngredient`** so the recipe warns when any line's
  ingredient is unreviewed (never implies allergen-free).

### E. RBAC (F4 integration) — kitchen sees allergens, money stays hidden
- Allergens are **operational** → add allergen data to the kitchen DTOs
  (`KitchenIngredient` `lib/data/ingredients.ts:29`, `KitchenRecipeLine`
  `lib/data/recipes.ts:53`), **without** reintroducing any money (§11.9).
- Kitchen **may edit** allergen tags (§5.5), **audited with the reviewer identity**
  (the kitchen user becomes `allergens_reviewed_by`).
- **The cost card stays manager-only (NEVER relaxed, §11.1).** The recipe
  cost-sheet PDF/print is a financial document since F4 and remains 403/NoAccess for
  kitchen.

### F. Override actions — strict guard + a precise clear (§5.4 / §11.5)
- `addOrEscalateRecipeOverride(db, org, recipeId, allergen, presence)` — **rejects**
  anything that is not a real add or escalation: the requested presence must be a
  **new** allergen for the recipe or **strictly higher** than the current
  `effectivePresence`; otherwise `ALLERGEN_CANNOT_DOWNGRADE` (no write, no audit).
- `clearRecipeOverride(db, org, recipeId, allergen)` — deletes only the **override
  row** (a manual addition/escalation). It can **never suppress a derived allergen**:
  the derived presence comes from ingredients, not from overrides, so after a clear
  the effective recomputes to `max(derived, ∅) = derived` — still `≥ derived`. It is
  a **separate, audited** action.

---

## 2. Surfaces
- **Ingredient editor / list:** allergen multi-select with per-allergen `presence`; an
  "unreviewed" badge (derived from `reviewed_at`); kitchen-editable (audited).
- **Recipe detail / editor:** allergen chips showing **derived vs added** separately
  (provenance), an "add allergen / escalate" control (add/escalate only), a clear
  control for manual additions, and an "unreviewed ingredients" warning.
- **Kitchen operational allergen document (§11.1, §11.2) — NEW, replaces the
  cost-card for this purpose:** a **recipe × allergen MATRIX** as **PDF + XLSX**,
  kitchen-visible, **containing NO monetary key or value**, with the non-legal
  disclaimer and "no allergens recorded" wording. Reuses `lib/documents/xlsx.ts`
  (`neutralizeFormula`) + the react-pdf infra (P&L doc precedent). This is the
  parent-plan's required kitchen-visible allergen matrix — **included**, not deferred.
- **Search / list filter by allergen:** **deferred** (§5.6).

---

## 3. Files

### CREATE
- `lib/allergens/catalog.ts` (+ `.test.ts`) — slugs, labels mapping, `PRESENCE`
  order, `z.enum`.
- `lib/calculations/allergens.ts` (+ `.test.ts`) — `comparePresence`/`maxPresence`,
  `recipeAllergens` (derived+override+effective, sorted, invariant, unreviewed flag).
- `lib/data/allergens.ts` — atomic `replaceIngredientAllergens`, batch loaders,
  `addOrEscalateRecipeOverride`, `clearRecipeOverride`.
- `lib/validation/allergens.ts` — Zod (enum + presence + payloads).
- `lib/documents/allergen-matrix-data.ts` / `-pdf.tsx` / `-xlsx.ts` / `-labels.ts` —
  the kitchen operational matrix (no money).
- `drizzle/0024_*.sql` — additive (2 tables + the 2 ingredient columns + CHECKs);
  `when` > 1782063539270 (0023).
- `tests/allergens.test.ts` (PGlite) — see §6.

### CHANGE
- `lib/db/schema.ts` — `ingredientAllergens`, `recipeAllergenOverrides` (+ CHECKs),
  `ingredients.allergensReviewedAt` / `allergensReviewedBy`; both tables to
  `businessTables`.
- `lib/data/ingredients.ts` / `lib/data/recipes.ts` — batch-load allergens into the
  views (no N+1, §11.9); add allergens to `KitchenIngredient` / `KitchenRecipeLine`
  (kept for kitchen, money still omitted).
- `app/(app)/ingredients/*`, `app/(app)/recipes/*` — editor + display + actions; the
  actions **audit** every change (§11.4) and return allergens in the response
  **without** money for kitchen (§11.9).
- `lib/data/audit.ts` — new `AuditAction`s `allergen.ingredientReview`,
  `allergen.overrideAdd`, `allergen.overrideClear`; metadata = before/after presence
  sets (slugs only), entity id, `hasReason` boolean — **never the reason free-text or
  any PII** (§11.4 + CLAUDE.md). A captured reason, if any, lives on a domain column,
  not in `audit_log`.
- `lib/action-result.ts` — `ALLERGEN_CANNOT_DOWNGRADE` (+ i18n).
- `lib/i18n/messages/en.json` — `allergens.*` (14 labels, presence labels, the
  disclaimer, "no allergens recorded", warnings), the new action error.
- `lib/data/account-export.ts` — add both tables + bump version **4 → 5**;
  `tests/account-export.test.ts` → v5 + real rows + isolation.
- The cost-card document/route — **unchanged** (stays manager-only; do not touch its
  RBAC).

---

## 4. Migration `0024` (additive, no backfill)
1. `ingredient_allergens` + `recipe_allergen_overrides` (composite FK cascade, unique,
   + the `allergen IN (…14…)` and `presence IN ('may_contain','contains')` CHECKs).
2. `ingredients` ADD `allergens_reviewed_at timestamptz`, `allergens_reviewed_by text`
   (both nullable).
3. RLS: both new tables in `businessTables` → standard `org_isolation` via
   `npm run db:migrate`.
- **Verify `_journal.json` `when` > 1782063539270** (0023); `migrate-guard` also
  aborts otherwise. **LOCAL only; prod waits for diff review.** Existing rows: no
  allergens, `reviewed_at = NULL` (= unreviewed, correctly NOT "allergen-free").

---

## 5. Decisions — RESOLVED (dev review)
1. **Join tables → YES** (not jsonb).
2. **Two levels → YES, named `presence`** (`may_contain`/`contains`) — certainty, not
   severity.
3. **Reviewed → YES, as `allergens_reviewed_at` + `allergens_reviewed_by`**; the
   boolean `reviewed` is derived from the timestamp.
4. **Strict override guard → YES** (`ALLERGEN_CANNOT_DOWNGRADE`).
5. **Kitchen edits → YES, audited, with reviewer identity.**
6. **Search / filter → DEFER.**
7. **Account-export → bump 4 → 5.**
8. **Operational document → YES, but a SEPARATE kitchen doc with NO money; the cost
   card is NOT opened to kitchen.**

---

## 6. Tests
- **`lib/allergens/catalog.test.ts`** — 14 slugs present, presence order, enum guard.
- **`lib/calculations/allergens.test.ts`** — union across lines; `max` effective;
  override **adds**; override **escalates** `may_contain → contains`; **derived &
  override returned separately**; **effective never below derived** (the invariant);
  **clear/lower never hides the derived value**; deterministic catalog ordering; empty
  recipe → empty.
- **`tests/allergens.test.ts`** (PGlite, `tenant_app`):
  - set ingredient allergens → recipe rollup reflects them;
  - a **trashed** ingredient still contributes its allergens;
  - **replace is atomic**: a forced failure mid-replace rolls back ALL rows AND the
    review stamp (nothing partially applied);
  - **empty replace marks the ingredient reviewed** (`reviewed_at` set, zero rows);
  - **add/escalate** persists; a downgrade/remove attempt → `ALLERGEN_CANNOT_DOWNGRADE`;
  - **clear** removes a manual addition and the derived allergen still shows;
  - **audit + reviewer** recorded for BOTH a manager and a kitchen edit (before/after
    presence, actor id, no reason free-text in metadata);
  - **cross-org RLS**: operate on ORG_B rows from ORG_A context → blocked;
  - **unreviewed ingredient propagates `hasUnreviewedIngredient`** to its recipe.
- **RBAC tests** —
  - kitchen ingredient + recipe payloads **carry allergens but omit money**
    (regression vs F4);
  - the **kitchen allergen matrix document contains no monetary key or value**;
  - the **cost card stays 403 / NoAccess for kitchen** (regression — never relaxed).
- **`tests/account-export.test.ts`** — version 5, both tables present (real row),
  never another tenant's.

---

## 7. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0024` applied **LOCALLY only**; prod waits for diff review.
- Every §11 correction delivered; §6 tests green.
- Cost card RBAC untouched (manager-only); kitchen has its own money-free allergen
  matrix doc; "no allergens recorded" everywhere (never "allergen-free").
- All allergen mutations audited (before/after, actor, entity; no PII in metadata).
- Account-export bumped + tested.
- **Full diff handed to the dev.**

---

## 8. Out of scope (do NOT build)
- Any **legal allergen DECLARATION / claim** (customer-facing labelling) — food-
  safety/legal sign-off, a later sprint.
- Allergen search / list filter (§5.6).
- Per-jurisdiction lists beyond EU FIC 14 (extensible later).
- Supplier-declared allergen feeds (Suppliers, Sprint 7); menu-level aggregation
  (Menus, Sprint 10).
- Any change to the cost-card document or its RBAC.

---

## 9. Codebase anchors (verified this plan)
- `lib/calculations/recipeCost.ts` — the pure derive-on-read rollup to mirror.
- `lib/data/recipes.ts:36`/`:48`/`:53` — `RecipeWithIngredients` + the F4 kitchen
  DTOs allergens flow into; the recipe-cost ingredient join is intentionally NOT
  `deleted_at`-filtered (mirror for allergens).
- `lib/data/ingredients.ts:29` `KitchenIngredient`; `lockActiveIngredient` (same file)
  — the FOR-UPDATE lock to take in the atomic replace.
- `lib/finance/categories.ts` `CATEGORY_SEED` / `lib/validation/recipe-folders.ts`
  `FOLDER_ICONS` — "fixed list + Zod enum" precedent for the catalog.
- `lib/documents/xlsx.ts` (`neutralizeFormula`) + the P&L PDF/XLSX docs — precedent
  for the kitchen allergen matrix.
- `lib/data/audit.ts` — `AuditAction` union + `writeAuditEvent` (metadata = non-PII
  only); the cost-card route RBAC (manager-only, F4) — must stay.
- `lib/data/account-export.ts:40` — `ACCOUNT_EXPORT_SCHEMA_VERSION` (4 → 5).
- `drizzle/meta/_journal.json` — current max `when` 1782063539270 (0023); 0024 must
  exceed it.

---

## 10. Risks / notes
- **Safety direction is the whole point.** Invariants the implementation MUST hold:
  overrides only add/escalate; the rollup includes trashed ingredients; clear never
  hides a derived allergen; "unreviewed" never reads as "allergen-free".
- **F4 must not regress.** Kitchen gets a separate money-free matrix doc; the cost
  card stays manager-only. A test pins both.
- **Audit privacy.** Allergen slugs + ids are non-PII; a free-text reason is NOT put
  in `audit_log` metadata (CLAUDE.md) — only a `hasReason` flag.
- **Claim boundary / wording.** The disclaimer is load-bearing; the Annex II legal
  texts must be confirmed before any future compliance claim (cereals, tree nuts,
  sulphites especially).

---

## 11. Mandatory corrections (dev review — all REQUIRED)
1. **Do NOT open the cost card to kitchen.** Build a SEPARATE kitchen operational
   document with no monetary field; the cost card stays manager-only (403/NoAccess).
2. **Ship the kitchen-visible allergen matrix (XLSX + PDF)** the parent plan requires
   (here: the recipe × allergen matrix), or it would be a silent omission — it is
   INCLUDED.
3. **`allergens_reviewed_at` + `allergens_reviewed_by`** (not a lone boolean) —
   provenance required by the parent plan; `reviewed` derives from the timestamp.
4. **Every mutation writes a transactional audit event** inside the same `withOrg`:
   before/after presence, actor, ingredient/recipe id; `hasReason` flag only — the
   reason free-text is NEVER stored in `audit_log` (CLAUDE.md: no PII/notes in
   metadata).
5. **Clarify clear/override:** `clearRecipeOverride` removes only a manual addition/
   escalation and can NEVER suppress a derived allergen (derived isn't stored in
   overrides; effective recomputes to ≥ derived); it is a separate audited action.
6. **Drop the "safe by construction" claim** — the add/escalate guarantee comes from
   `max()` at read time + the action guard, not the schema.
7. **DB CHECK constraints** for the 14 slugs and the 2 presence values, in addition to
   Zod.
8. **Atomic replace** of ingredient allergens: validate all, lock the active
   ingredient (`lockActiveIngredient`), replace rows, and stamp review — all in one
   `withOrg`; any failure rolls back everything.
9. **Batch loaders (no N+1)**; action responses return allergens **without**
   reintroducing money into kitchen payloads.
10. **Never "allergen-free."** Reviewed-and-empty shows **"no allergens recorded"**
    next to the disclaimer.
11. **Rollup returns `derivedPresence` and `overridePresence` separately** (not a
    single `source`).
12. **Sort results by the fixed catalog order** for deterministic UI/PDF.
13. **Confirm catalog texts against Reg (EU) 1169/2011 Annex II** (cereals/gluten,
    tree nuts, sulphites especially) before any compliance claim.
