# Sprint 6 — Kitchen operations: prep, reorder & checklist tasks — implementation plan

> **Status: DRAFT for senior review — NOT started. Decisions in §1.B need sign-off
> before implementation.**
> Source of truth for scope: `PLANO.md` §"Sprint 6 — Kitchen operations". This plan
> only refines the *how*; it does not expand the scope (owner reduced it). Reuses the
> shipped patterns: soft-delete + 30-day Trash (`lib/trash.ts`, `lib/data/trash.ts`),
> optimistic concurrency (`expectedUpdatedAt` + `FOR UPDATE`, see
> `lib/data/productions.ts`), audit log (`lib/data/audit.ts`), Zod validation, stable
> `ActionErrorCode` + next-intl, ⌘K search registry (`lib/search/`), and the
> purge-null-link precedent (`transactions.recipe_id`, `lib/data/trash.ts`). Migration
> `0031` is **LOCAL only** until its generated SQL/meta diff is reviewed and the owner
> explicitly authorizes production.
>
> Note: `docs/expansion-plan-kitchen-ops.md` later labels the reduced task work as
> "11c". This file intentionally follows the current `PLANO.md` Sprint 6 acceptance
> criteria (`task_lists` + `tasks`, linked reorder/prep tasks, Trash, search).

## 0. Outcome and non-negotiable boundaries

Sprint 6 ships a **chef-specific, operational** task system — reliable shared prep /
reorder / checklist lists anchored in real PrepProfit data. It is deliberately *not* a
generic to-do app, and it is **money-free end-to-end** (no cost/price/margin anywhere,
so there is no F4 surface to defend — it simply never touches money).

Two entities: a **task list** (a named, optionally dated container — "Saturday prep",
"Opening", "Closing") and its **tasks** (a title, optional notes/station, an optional
assignee + due date, and an open/done status with completion provenance). Tasks may be
**anchored to real data**: a low-stock ingredient → a *reorder* task, or a recipe → a
*prep* task — the differentiator over a generic list.

Hard invariants (carried from the project rules):

- **Multi-tenancy (RULE #1):** every row carries `organization_id`; every query is
  org-scoped; both tables are in `businessTables` → standard `org_isolation` RLS; all
  writes run inside `withOrg`. `organization_id` is never accepted from the client.
- **Operational, not financial:** no monetary column, no cost derivation, nothing
  gated by entitlements. Audit metadata carries ids/counts/status only — **never** task
  titles, notes, or assignee names (titles are free text and may incidentally contain
  PII).
- **Source links never block catalogue integrity:** a task anchored to a recipe /
  ingredient keeps a *nullable* link; purging that recipe/ingredient **nulls the link
  first** (the task survives as plain text), mirroring `transactions.recipe_id`.
- **Soft-delete + Trash:** task lists follow the 30-day Trash pattern; restore/purge
  live on the existing manager-only `/trash` surface.
- **Task rows are not Trash entities:** individual task deletion is a hard delete from
  an active list (audited, optimistic-locked). The recoverable Trash boundary is the
  list; purging a trashed list cascades its tasks.

---

## 1. Decisions

### 1.A — Locked (from PLANO.md / project rules, restated for context)

1. **L1 — Two tables.** `task_lists` + `tasks` with a composite `(organization_id,
   task_list_id)` FK (cascade). A task always belongs to exactly one list.
2. **L2 — RBAC asymmetry (PLANO acceptance criteria).** *Both* roles read and
   **complete/uncomplete** tasks. **Manager-only:** create/edit/delete/reorder a list,
   hard-delete an individual task, **assign** a task to someone, reset, duplicate, and
   Trash restore/purge. This is the one place kitchen and manager diverge — enforced
   server-side (RBAC before data), not just hidden in the UI.
3. **L3 — Operational + money-free.** No cost/price/margin columns or derivations. No
   plan/entitlement gate (mirrors productions, D7 there).
4. **L4 — Anchored to real data.** A task may link to a recipe (*prep*) or an
   ingredient (*reorder*). Links are nullable composite FKs; the purge paths null them
   before deleting the referenced row (no orphan, no blocked purge).
5. **L5 — Trash + auto-purge.** Task lists are soft-deletable (30-day Trash, manager
   restore/purge via `/trash`); `purgeExpired` deletes expired lists (tasks cascade).
6. **L6 — Search.** Task lists are a ⌘K entity for **both** roles, money-free
   (`lib/search/`), `deleted_at IS NULL`.
7. **L7 — True recurrence is OUT (backlog).** Recurring checklists are achieved
   manually via **reset** (all tasks → open) + **duplicate** (copy a list). A scheduled
   recurrence engine stays in the backlog until manual lists prove the need.

### 1.B — To confirm with senior review (proposed defaults in **bold**)

> Each has a recommended default so a "no changes" review is a valid approval.

- **D1 — May kitchen ADD tasks to an existing list (vs. complete-only)?** PLANO blocks
  kitchen from *creating/deleting lists* and *assigning others*, but is silent on adding
  a task row to an existing active list.
  - **Recommended: kitchen MAY add, edit (title/notes/station/due), reorder and
    complete tasks inside an ACTIVE list** — a chef adding "also prep X" mid-shift is
    core kitchen UX. List lifecycle (create/delete/reset/duplicate) and **assignment**
    stay manager-only, satisfying the acceptance test verbatim.
  - Alternative: kitchen is strictly read + toggle-complete; all authoring is manager.
    *Pick one — this drives the per-action RBAC guard.*
- **D2 — Assignee model.** "Assign one / assign others" implies real people.
  - **Recommended: `assignee_user_id` = a Clerk org member id**, set by a manager via a
    member picker (org members listed server-side through the Clerk Backend API, names
    resolved for display only, never stored). Null = unassigned. The Server Action
    validates the assignee is a member of the active org before the data mutation; the
    data layer stores only the id and has no FK to Clerk. A definite non-member returns
    `TASK_ASSIGNEE_INVALID`; a transient Clerk/API failure is surfaced as unexpected
    rather than silently accepting or rejecting. Real accountability + matches "assign
    others".
  - Alternative: a free-text `assignee_label` (no Clerk call, but no real identity).
- **D3 — Source-link FK strategy.** PLANO: "purged recipes/ingredients null task source
  links first."
  - **Recommended: two nullable composite FKs** — `(org, source_recipe_id) → recipes`
    and `(org, source_ingredient_id) → ingredients`, both `ON DELETE restrict`, plus a
    `source_kind` discriminator (`manual` | `prep` | `reorder`). The purge paths null
    the matching column first (exactly the `transactions.recipe_id` precedent). A task
    has exactly the source implied by `source_kind`: `manual` = both NULL, `prep` =
    recipe only, `reorder` = ingredient only.
- **D4 — `reset` semantics.** For reusing a daily checklist.
  - **Recommended: reset = set EVERY task in the list back to `open` and clear its
    completion stamps**, keeping the task rows (so "Opening" can be re-run tomorrow).
    Manager-only, optimistic-locked.
- **D5 — Dating / "Today" grouping.** PLANO shows a per-task **due date** in the row.
  - **Recommended: `due_on` (bare date, nullable) on the TASK**, plus a nullable
    `scheduled_for` (bare date) on the LIST to drive a simple "Today / Upcoming / No
    date" grouping on `/tasks`. No calendar, no time, no tz.
- **D6 — Status model.** **Recommended: `open` | `done` only** (toggle), with
  `completed_at`/`completed_by` stamped on done and cleared on reopen (CHECK: both
  non-null iff `done`). No `in_progress` (reduced scope).
- **D7 — Reorder/prep entry points.** Where the data anchors are created.
  - **Recommended:** a manager-only **"Create reorder task"** affordance on the
    low-stock list (dashboard low-stock panel + `/ingredients`) and a **"Add prep
    task(s)"** affordance from a recipe (and, as a cheap bonus reusing 11a, from a
    *planned/completed* production's money-free mise-en-place). Prep-task creation
    follows D1 (both roles if kitchen authoring is approved). Each appends to a
    chosen/most-recent list. Confirm whether the production source is in or deferred.
- **D8 — Individual task deletion.** **Recommended: manager-only hard-delete task rows
  from active lists** (with `expectedUpdatedAt` and audit). Lists are the recoverable
  Trash unit; adding per-task Trash would add UI and purge complexity not requested by
  PLANO.

---

## 2. Lifecycle & edit contract

```text
TASK LIST:  active  ─► (soft-delete) ─► trashed ─► (restore) ─► active
                                              └─► (30-day auto-purge / manual purge) ─► gone (tasks cascade)
TASK:       open  ⇄  done            (toggle; done stamps completed_at/by, reopen clears)
            reset (list-level): every task ─► open
```

- **Create list / task:** manager creates a list; tasks added by manager (always) or
  kitchen (D1). New list is `active`; new task is `open`.
- **Toggle complete:** `open → done` stamps `completed_at = now()` + `completed_by =
  actorUserId`; `done → open` clears both. Idempotent — re-completing a done task (or
  re-opening an open one) is a no-op that does not re-stamp or re-audit.
- **Assign:** manager sets/clears `assignee_user_id` (D2).
- **Reorder:** drag = rewrite `sort_order` for the affected tasks in one tx.
- **Delete task:** manager hard-deletes a task row from an active list only (D8). A
  trashed list refuses task deletes; deleting a list goes through list Trash instead.
- **Reset / duplicate:** manager-only (D4 / L7). Duplicate copies the list header +
  every task as `open`, unassigned, links preserved.
- **Optimistic concurrency:** list and task mutations carry `expectedUpdatedAt`, lock
  the row `FOR UPDATE`, compare, and return `*_STALE` before any write — same contract
  as productions. Task mutations also lock the parent list to prove it is active. A
  trashed list refuses task edits (`TASK_LIST_NOT_EDITABLE`). Any task add/update/
  delete/toggle/reorder bumps the parent list's `updated_at`, so list-level UIs and
  bulk operations have one coherent freshness token.

---

## 3. Data model — migration `0031`

Set journal `when` above the current maximum (0030 = 1782198548358). Add both tables to
`businessTables`, standard `org_isolation` RLS, and the account export; bump the export
schema version **11 → 12**.

### `task_lists` (new)

- `id`, `organization_id`;
- `name text NOT NULL` (CHECK trimmed length 1..200), `notes text NULL`
  (CHECK null or length ≤1000);
- `scheduled_for date NULL` (bare 'YYYY-MM-DD' — drives Today/Upcoming, D5);
- `sort_order integer NOT NULL DEFAULT 0` (CHECK `>= 0`; list ordering is
  `(sort_order, scheduled_for NULLS LAST, created_at, id)`);
- `created_at`, `updated_at` (`$onUpdate`), `deleted_at` (Trash);
- indexes `(org)`, `(org, deleted_at)`, `(org, scheduled_for)`; `unique (org, id)` (FK
  target); pg_trgm GIN on `name` for ⌘K.

### `tasks` (new)

- `id`, `organization_id`, `task_list_id text NOT NULL`;
- `title text NOT NULL` (CHECK trimmed length 1..200), `notes text NULL`
  (CHECK null or length ≤1000), `station text NULL` (CHECK null or length ≤60;
  free-text tag);
- `status text NOT NULL DEFAULT 'open'` (CHECK `IN ('open','done')`);
- `assignee_user_id text NULL` (Clerk member id, D2; no DB FK);
- `due_on date NULL`;
- `completed_at timestamptz NULL`, `completed_by text NULL`
  (CHECK: `(completed_at IS NOT NULL) = (status = 'done')` and
  `(completed_by IS NOT NULL) = (status = 'done')`);
- `source_kind text NOT NULL DEFAULT 'manual'` (CHECK `IN ('manual','prep','reorder')`);
- `source_recipe_id text NULL`, `source_ingredient_id text NULL` (D3);
- source CHECK:
  - `manual` ⇔ `source_recipe_id IS NULL AND source_ingredient_id IS NULL`;
  - `prep` ⇔ `source_recipe_id IS NOT NULL AND source_ingredient_id IS NULL`;
  - `reorder` ⇔ `source_recipe_id IS NULL AND source_ingredient_id IS NOT NULL`;
- `sort_order integer NOT NULL DEFAULT 0` (CHECK `>= 0`; task ordering is
  `(sort_order, created_at, id)`, no uniqueness requirement);
- `created_at`, `updated_at`;
- composite FK `(org, task_list_id) → task_lists(org,id) ON DELETE cascade`;
- composite FK `(org, source_recipe_id) → recipes(org,id) ON DELETE restrict`
  (MATCH SIMPLE; NULL rows skip it — purge nulls it first);
- composite FK `(org, source_ingredient_id) → ingredients(org,id) ON DELETE restrict`
  (MATCH SIMPLE; same);
- indexes `(org, task_list_id)`, `(org, assignee_user_id)`, `(org, source_recipe_id)`,
  `(org, source_ingredient_id)`.

Generate with Drizzle; do not hand-author. Review SQL/meta/FK/CHECK/index/RLS
registration + journal order before local apply. **No append-only carve-out** — both
are normal org-isolated tables.

---

## 4. Pure helpers — minimal, money-free

No costing. One tiny pure module `lib/calculations/tasks.ts` (or inline) for the
progress rollup used by the list view + ⌘K subtitle:

- `taskListProgress(tasks: {status}[]) → { done: number; total: number; allDone: boolean }`.

Tested for empty / all-open / all-done / mixed. Everything else is data-layer CRUD.

---

## 5. Data layer — `lib/data/tasks.ts`

All org-scoped, inside `withOrg`. Optimistic concurrency + `FOR UPDATE` on every
list/task mutation (reuse the productions lock helper shape). Add two internal lock
helpers:

- `lockTaskListForUpdate(db, org, listId, expectedUpdatedAt?)` — active list only,
  returns `not_found` / `stale` / `not_editable`.
- `lockTaskForUpdate(db, org, taskId, expectedUpdatedAt)` — locks the task and its
  parent list in a deterministic order; refuses if the parent list is trashed.

Every child mutation updates the parent `task_lists.updated_at` in the same tx. This
makes list detail pages, reset, duplicate and reorder operate from one freshness token
instead of trying to compare dozens of child timestamps.

**Lists:** `listTaskLists` (with progress counts, newest/scheduled order),
`getTaskListWithTasks`, `createTaskList`, `updateTaskList`, `reorderTaskLists`
(manager-only list rail ordering), `duplicateTaskList`, `resetTaskList` (D4),
`softDeleteTaskList`, `restoreTaskList`, `purgeTaskList`.

**Tasks:** `addTask`, `updateTask`, `toggleTask` (idempotent, stamps/clears
`completed_at`/`completed_by`), `assignTask` (manager; action already validated org
membership), `reorderTasks`, `deleteTask` (manager-only hard delete, D8).

**Integrations (L4 / D7):** `createReorderTaskFromIngredient(listId, ingredientId)` and
`createPrepTasksFromRecipe(listId, recipeId)` — resolve the active source row, snapshot
its name into the task `title`, set `source_kind` + the link. Money-free (never read a
price). The source row is locked/read active at creation time; later soft-delete keeps
the link, and purge nulls it. (Optional production source reuses the 11a/11b kitchen
view: completed productions use frozen consumptions, planned productions use the live
money-free explosion.)

**Trash coupling (extend, do not rewrite):**
- `purgeExpired` (`lib/data/trash.ts`): before deleting expired recipes/ingredients,
  **null `tasks.source_recipe_id` / `tasks.source_ingredient_id`** that point at the
  purge set (matching the exact delete set, exactly like the `transactions.recipe_id`
  unlink) so the restrict FK never blocks; then add expired `task_lists` to the purge
  (tasks cascade).
- Manual recipe/ingredient purge actions (`app/(app)/trash/actions.ts`): call the same
  null-first data helpers before the existing purge guard/delete, so a manual purge of
  a recipe/ingredient used only by tasks succeeds and leaves the task as plain text.
  Do not null links if another guard will still block the purge (`RECIPE_IN_MENU`,
  `RECIPE_IN_PRODUCTION`, `INGREDIENT_IN_TRASHED_RECIPE`, production movement pin).

**Concurrency test (opt-in real Postgres):** two togglers race on one task →
exactly one stamps; reorder vs. concurrent add → deterministic order, no lost row.

---

## 6. Actions, validation, audit & errors

### Actions — `app/(app)/tasks/actions.ts`

Canonical order per action: **RBAC → Zod → external membership validation when needed
→ `withOrg`(mutation + audit) → revalidate**. Source-row validation stays inside
`withOrg`, so the source read and task insert are atomic.

- Manager-only (`isManager()` first, else `FORBIDDEN`): `createTaskListAction`,
  `updateTaskListAction`, `deleteTaskListAction`, `duplicateTaskListAction`,
  `resetTaskListAction`, `reorderTaskListsAction`, `assignTaskAction`,
  `deleteTaskAction`, and `createReorderTaskFromIngredientAction`.
- Both roles: `toggleTaskAction`, and (per **D1**) `addTaskAction` / `updateTaskAction`
  / `reorderTasksAction` / `createPrepTasksFromRecipeAction` scoped to an active list.
- Trash restore/purge of lists live in `app/(app)/trash/actions.ts` (manager-only).
- All input Zod-validated (`lib/validation/tasks.ts`): trimmed title (1..200), notes
  (≤1000), station (≤60), `due_on`/`scheduled_for` real calendar dates,
  `expectedUpdatedAt` ISO; **caps** — ≤500 tasks per list (guards `duplicate` + bulk
  prep). `assignTaskAction` validates `assigneeUserId` against active Clerk org
  membership before calling the data layer. No rate-limit bucket (no external cost;
  caps suffice).

### New action errors (`ActionErrorCode` + `actionErrors.*`)

- `TASK_LIST_STALE`, `TASK_STALE` (optimistic concurrency);
- `TASK_LIST_NOT_EDITABLE` (editing a task in a trashed list);
- `TASK_LIST_FULL` (per-list task cap);
- `TASK_ASSIGNEE_INVALID` (assignee is not an active member of the current org);
- reuse `NOT_FOUND`, `INVALID_INPUT`, `FORBIDDEN`.

### Audit (`AuditAction`) — metadata = ids/counts/status only, NEVER titles/notes/names

- `taskList.create` / `.update` / `.delete` / `.reset` / `.duplicate` / `.reorder`
  (metadata: listId/counts only);
- `task.create` / `.update` / `.delete` (taskId, listId, sourceKind);
- `task.complete` / `.reopen` (taskId, listId — no-op toggles don't audit);
- `task.assign` (taskId, whether assigned/cleared — assignee user id is an id, no name).
- Trash restore/purge reuse the generic `trash.restore` / `trash.purge` (entityType
  `taskList`).

### Search / export plumbing

- Add `taskList` to `SearchEntityType`, `searchTaskLists` to `lib/search/queries.ts`,
  and a both-role descriptor in `SEARCH_REGISTRY` (near productions/ingredients).
  Query only active lists (`deleted_at IS NULL`) by `task_lists.name`; subtitle is
  money-free (`scheduled_for` + progress count, no task titles/notes).
- Add `taskLists` + `tasks` imports and table entries to `lib/data/account-export.ts`,
  then bump `ACCOUNT_EXPORT_SCHEMA_VERSION` **11 → 12** with a version comment.

---

## 7. UI

- **`/tasks`** (new nav + sidebar entry, e.g. `ListChecks` icon — visible to both
  roles): a rail/grid of lists grouped Today / Upcoming / No date (D5), each with a
  progress bar (`taskListProgress`). Manager sees New/Duplicate/Delete; kitchen sees
  lists it can open + complete.
- **`/tasks/[id]`**: the list — task rows with a status checkbox, station tag, assignee
  avatar/name (resolved from Clerk on the server/client boundary, never stored), due
  date; inline add (per D1); drag-reorder; reset/delete task (manager). Trashed list →
  read-only.
- **Integration affordances (D7):** "Create reorder task" on the dashboard low-stock
  panel + `/ingredients` (manager); "Add prep task" from a recipe (and optionally a
  planned/completed production).
- **⌘K:** task-list entity (money-free), `→ /tasks/[id]`.
- **a11y/mobile:** keyboard toggle + reorder, touch targets — PLANO calls out keyboard
  + mobile support explicitly.
- **i18n:** all copy in `en.json` (`tasks.*`) + the new `actionErrors.*`.

---

## 8. Test matrix

### Pure
- `taskListProgress` over empty / all-open / all-done / mixed.

### PGlite / data / RLS
- Create list + tasks; toggle stamps/clears `completed_at`/`completed_by`; CHECK
  rejects a done task with null completion (and vice-versa).
- DB CHECK rejects empty list/task titles, negative sort orders, invalid source
  combinations (`prep` without recipe, `reorder` without ingredient, manual with a
  source link).
- Toggle idempotency: re-completing/re-opening writes nothing new and does not re-audit.
- Reorder preserves order across reload; reset sets all `open` + clears stamps; child
  mutations bump parent `task_lists.updated_at`.
- Duplicate copies header + tasks as open/unassigned with links preserved, respecting
  the per-list cap.
- Manager delete task hard-deletes only from an active list, audits once, and is
  refused for a trashed parent list.
- Source links: prep-from-recipe + reorder-from-ingredient set `source_kind` + the
  correct link; **purging the recipe/ingredient nulls the link first** (manual + cron
  `purgeExpired`), task survives as text; restrict FK never blocks. If another guard
  blocks the purge, task source links are not nulled.
- Soft-delete → Trash → restore/purge; expired list auto-purges (tasks cascade);
  editing a task in a trashed list → `TASK_LIST_NOT_EDITABLE`.
- Stale `expectedUpdatedAt` → `*_STALE`, zero writes.
- Composite-FK + unfiltered `tenant_app` isolation for both tables; export schema v12
  contains both tables and no foreign-tenant rows.

### RBAC
- Manager-only actions (list create/delete/reset/duplicate/reorder, assign, task
  delete) return `FORBIDDEN` for kitchen **before** data access; kitchen
  toggle/add/prep-task creation (D1) succeed; reorder-task vs. reorder-list split is
  enforced.
- Assignment validates Clerk org membership; invalid member id returns
  `TASK_ASSIGNEE_INVALID` before the data mutation.

### Audit / search / concurrency
- `taskList.*` / `task.*` audit once, in-tx; metadata carries no titles/notes/names;
  no-op toggles don't audit.
- ⌘K returns task lists for both roles, money-free, `deleted_at IS NULL` only; registry
  RBAC and `SearchEntityType` include `taskList`.
- Real-PG opt-in: concurrent toggle → single stamp; reorder vs. add → valid order.

---

## 9. Out of scope (Sprint 6)

- True scheduled/recurring checklists (backlog — manual reset + duplicate first).
- Reminders / push / email notifications, calendar views, time tracking, task
  dependencies, sub-tasks, per-user workload dashboards, comments/attachments.
- Any money/cost/entitlement surface (it is operational only).
- Per-org station management UI (station is a free-text tag in v1).

---

## 10. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0031` generated, SQL/meta/journal reviewed, migrate-guard green, applied
  locally only; RLS verified `tenant_app` for both tables; status/completion CHECKs
  verified.
- Both roles complete tasks; manager-only list create/delete/reorder/reset/duplicate,
  task delete, and assignment proven by RBAC-before-data tests.
- Assignment membership validation proven (`TASK_ASSIGNEE_INVALID`) without persisting
  invalid ids.
- Source-link null-on-purge proven for manual + cron paths (task survives, link null).
- Blocked recipe/ingredient purges do **not** null task source links.
- Soft-delete/restore/purge, reorder, reset, duplicate, integrations, ⌘K, export v12,
  audit (no PII), i18n wired and tested.
- No migration reaches production without separate owner review/authorization.

---

## 11. Codebase anchors

- Trash + purge null-first precedent: `lib/data/trash.ts` (`purgeExpired`,
  `transactions.recipe_id` unlink), `app/(app)/trash/actions.ts`,
  `app/api/cron/purge-trash/route.ts`, `lib/trash.ts`.
- Optimistic concurrency + `FOR UPDATE` lock shape: `lib/data/productions.ts`
  (`lockProductionForUpdate`).
- Low-stock source: `selectLowStock` (`lib/calculations/inventory.ts`),
  `components/app/dashboard/low-stock-card.tsx`, `app/(app)/dashboard/page.tsx` +
  `ingredients`; recipe source: `lib/data/recipes.ts`. Production money-free source
  (optional): `getKitchenProduction`.
- Plumbing: `lib/db/schema.ts` + `businessTables`, `lib/db/rls.ts`,
  `lib/data/account-export.ts` (v11→v12), `lib/data/audit.ts`, `lib/action-result.ts`,
  `lib/search/{queries,registry,types}.ts`, `lib/nav.ts`,
  `components/app/sidebar.tsx`, `components/app/command-palette.tsx`,
  `drizzle/meta/_journal.json`, i18n messages.

---

## 12. Open questions for the senior dev

1. **D1** — kitchen task-authoring scope (add+edit vs. complete-only).
2. **D2** — assignee as a Clerk member id (with org-membership validation) vs. free
   text.
3. **D7** — include the planned-production mise-en-place as a third prep source, or keep
   only recipe + low-stock ingredient for v1?
4. **D8** — confirm task rows are manager-only hard-deleted individually and only lists
   use Trash.
5. Any objection to bumping the account export to **v12** and to migration **0031**
   staying local until the diff review?
