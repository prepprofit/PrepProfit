# AI Photo Extraction — Eval Set

Live evaluation harness for the photo recipe extraction feature
(improvement plan Phase 5 / §9). It scores the **real provider's** output
against committed golden expectations and checks the §9.3 launch thresholds
(gate G5).

## Layout

```
eval/extraction/
  fixtures/<slug>.json   committed, sanitized golden (ExpectedRecipe) — text only
  manifest.json          slug → image filename + sha256 checksum (versioned)
  images/<file>          REAL recipe photos — GITIGNORED, never committed
  README.md              this file
```

Only the **golden JSON + manifest** are versioned. The actual photos are
private fixtures (they may contain a customer's recipe) and live, gitignored,
under `images/`. The metrics module never touches image bytes — only the
golden text and the produced draft.

## Adding a fixture

1. Drop the photo in `eval/extraction/images/` (e.g. `baklava.jpg`).
2. Add or edit `eval/extraction/fixtures/<slug>.json` with the EXPECTED lines:
   ingredient name (plus `aliases` the model may legitimately produce),
   `section`, `quantityValue`, `unitToken`, and the `expectedStatus`
   (`ready` | `needs_review` | `ignored`). A crossed-out source line is
   `ignored`; a line that cannot canonicalize yet (no quantity, a bare package
   descriptor, an unknown unit) is `needs_review`.
3. Add the matching `manifest.json` entry. Leave `sha256` as `null` until the
   image is final, then pin it (see below) so a fixture swap is detectable.

The target set (§9.2) is 20 photos: 5 handwritten, 5 printed, 3 multi-section,
3 package-heavy, 2 low-light/blurry, 2 non-English. **Baklava is mandatory and
stays in the set forever.**

## Pinning a checksum

```sh
# prints the sha256 of an image; paste it into the manifest entry's "sha256"
node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" eval/extraction/images/baklava.jpg
```

The runner reports each fixture's integrity: `ok`, `unpinned` (present but no
checksum yet — it prints the hash to pin), `missing_image` (skipped), or
`checksum_mismatch` (the photo changed under a pinned hash).

## Running

```sh
npm run eval:extraction            # all fixtures with a present image
npm run eval:extraction -- --fixture baklava
```

Needs the provider key in the environment (same `aiEnv()` as production) and at
least one present image. This is a **manual/live** tool — it is NOT part of CI
(CI runs the pure `lib/ai/eval/metrics.test.ts` instead).
