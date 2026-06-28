/**
 * Live AI photo-extraction eval runner (improvement plan Phase 5 / §9).
 *
 *   npm run eval:extraction                 # every fixture with a present image
 *   npm run eval:extraction -- --fixture baklava
 *   npm run eval:extraction -- --json       # machine-readable summary
 *
 * Calls the REAL provider over each private fixture image, maps the result through the
 * production `mapExtractionToPhotoDraft`, scores it against the committed golden, and
 * checks the §9.3 launch thresholds (gate G5). Manual/live only — NOT part of CI (CI
 * runs the pure metrics + loader tests). Exits non-zero when the gate fails, a pinned
 * image changed, or nothing could be evaluated, so it is usable in a release check.
 *
 * Privacy (G6): image bytes never leave this process and are never logged; only counts,
 * rates, latency, and the provider/model id are printed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mapExtractionToPhotoDraft } from '@/lib/ai/photo-draft';
import {
  RecipeExtractionError,
  getRecipeExtractor,
} from '@/lib/ai/recipe-extraction';
import { loadFixtures, type LoadedFixture } from '@/lib/ai/eval/fixtures';
import {
  aggregate,
  checkThresholds,
  rates,
  scoreDraft,
  type EvalScore,
} from '@/lib/ai/eval/metrics';

function loadEnv(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local is optional when the provider key is already in the environment.
  }
}

/** The allowlisted image mimes (mirrors the upload route). */
function mimeFor(image: string): string | null {
  switch (path.extname(image).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** The p95 of a latency sample (nearest-rank; empty → 0). */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

type FixtureRun =
  | { slug: string; ok: true; score: EvalScore; latencyMs: number; attempts: number; unpinnedSha?: string }
  | { slug: string; ok: false; reason: string };

async function runFixture(fixture: LoadedFixture): Promise<FixtureRun | null> {
  const { slug } = fixture.expected;
  const { integrity } = fixture;

  if (integrity.state === 'missing_image') {
    console.warn(`• ${slug}: SKIP — no image at ${fixture.imagePath}`);
    return null;
  }
  if (integrity.state === 'checksum_mismatch') {
    return {
      slug,
      ok: false,
      reason: `image checksum changed (pinned ${integrity.expected.slice(0, 12)}…, got ${integrity.actual.slice(0, 12)}…)`,
    };
  }

  const mimeType = mimeFor(fixture.image);
  if (!mimeType) return { slug, ok: false, reason: `unsupported image type: ${fixture.image}` };

  const imageBytes = readFileSync(fixture.imagePath);
  const startedAt = Date.now();
  let extraction;
  try {
    extraction = await getRecipeExtractor().extract({ imageBytes, mimeType });
  } catch (err) {
    const reason = err instanceof RecipeExtractionError ? err.message : 'extraction failed';
    return { slug, ok: false, reason };
  }
  const latencyMs = Date.now() - startedAt;

  const draft = mapExtractionToPhotoDraft(extraction.recipe, {
    attemptId: `eval:${slug}`,
    provider: extraction.provider,
    model: extraction.model,
  });
  const score = scoreDraft(fixture.expected, draft);

  return {
    slug,
    ok: true,
    score,
    latencyMs,
    attempts: extraction.attempts ?? 1,
    unpinnedSha: integrity.state === 'unpinned' ? integrity.sha256 : undefined,
  };
}

async function main(): Promise<void> {
  loadEnv();

  const argv = process.argv.slice(2);
  const only = argv.includes('--fixture') ? argv[argv.indexOf('--fixture') + 1] : undefined;
  const asJson = argv.includes('--json');

  let fixtures = loadFixtures();
  if (only) fixtures = fixtures.filter((f) => f.expected.slug === only);
  if (fixtures.length === 0) {
    console.error(only ? `No fixture named "${only}".` : 'No fixtures in the manifest.');
    process.exitCode = 1;
    return;
  }

  const runs: FixtureRun[] = [];
  for (const fixture of fixtures) {
    const run = await runFixture(fixture);
    if (run) runs.push(run);
  }

  const ok = runs.filter((r): r is Extract<FixtureRun, { ok: true }> => r.ok);
  const failed = runs.filter((r): r is Extract<FixtureRun, { ok: false }> => !r.ok);

  if (ok.length === 0) {
    console.error('\nNothing evaluated — no fixture produced a score.');
    for (const f of failed) console.error(`  ✗ ${f.slug}: ${f.reason}`);
    if (!asJson) {
      console.error('\nDrop a real image into eval/extraction/images/ (see eval/extraction/README.md).');
    }
    process.exitCode = 1;
    return;
  }

  const scores = ok.map((r) => r.score);
  const totals = aggregate(scores);
  const r = rates(totals);
  const gate = checkThresholds(r);

  const latencies = ok.map((x) => x.latencyMs);
  const retried = ok.filter((x) => x.attempts > 1).length;
  const retryRate = ok.length === 0 ? 0 : retried / ok.length;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          fixtures: ok.length,
          skippedOrFailed: fixtures.length - ok.length,
          rates: r,
          counts: totals,
          latency: { p95Ms: p95(latencies), maxMs: Math.max(...latencies) },
          retryRate,
          gate,
          failures: failed,
        },
        null,
        2,
      ),
    );
    process.exitCode = gate.passed && failed.length === 0 ? 0 : 1;
    return;
  }

  console.log('\nPer-fixture');
  for (const x of ok) {
    const fr = rates(x.score.counts);
    console.log(
      `  ${x.slug.padEnd(16)} recall ${pct(fr.lineRecall)}  correctable ${pct(fr.correctableRecall)}  ready ${pct(fr.readyAccuracy)}  loss ${pct(fr.silentLossRate)}  ${x.latencyMs}ms${x.attempts > 1 ? `  (${x.attempts} attempts)` : ''}`,
    );
    if (x.score.hallucinatedNames.length > 0) {
      console.log(`      hallucinated: ${x.score.hallucinatedNames.join(', ')}`);
    }
    if (x.unpinnedSha) console.log(`      unpinned — pin sha256: ${x.unpinnedSha}`);
  }
  for (const f of failed) console.log(`  ${f.slug.padEnd(16)} ✗ ${f.reason}`);

  console.log('\nOverall');
  console.log(`  line recall          ${pct(r.lineRecall)}`);
  console.log(`  correctable recall   ${pct(r.correctableRecall)}`);
  console.log(`  ready accuracy       ${pct(r.readyAccuracy)}`);
  console.log(`  hallucination rate   ${pct(r.hallucinationRate)}`);
  console.log(`  silent-loss rate     ${pct(r.silentLossRate)}`);
  console.log(`  field accuracy       name ${pct(r.fieldAccuracy.name)} · qty ${pct(r.fieldAccuracy.quantity)} · unit ${pct(r.fieldAccuracy.unit)} · section ${pct(r.fieldAccuracy.section)}`);
  console.log(`  latency p95          ${p95(latencies)}ms (max ${Math.max(...latencies)}ms)`);
  console.log(`  retry rate           ${pct(retryRate)} (${retried}/${ok.length})`);

  console.log(`\nLaunch gate (§9.3): ${gate.passed ? 'PASS' : 'FAIL'}`);
  for (const f of gate.failures) {
    console.log(`  ✗ ${f.metric} = ${pct(f.value)} (need ${f.comparator} ${pct(f.threshold)})`);
  }

  process.exitCode = gate.passed && failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
