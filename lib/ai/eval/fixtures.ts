import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ExpectedRecipe } from './metrics';

/**
 * Loader for the photo-extraction eval set (improvement plan Phase 5 / §9.2).
 *
 * Node-only (fs + crypto): used by the live runner (`scripts/eval-extraction.ts`)
 * and the loader test. The committed, sanitized golden JSON + manifest are validated
 * with Zod (untrusted-on-disk → strict parse); the REAL images are private fixtures
 * under `images/` (gitignored) and are referenced only by path + checksum — the
 * metrics layer never reads image bytes.
 *
 * Integrity (per fixture) is reported, never thrown for: a missing image just means
 * the runner skips that fixture; a malformed/committed golden or a manifest/fixture
 * mismatch IS a hard error (a versioned file is broken).
 */

export const EVAL_ROOT = path.join(process.cwd(), 'eval', 'extraction');
export const FIXTURES_DIR = path.join(EVAL_ROOT, 'fixtures');
export const IMAGES_DIR = path.join(EVAL_ROOT, 'images');
export const MANIFEST_PATH = path.join(EVAL_ROOT, 'manifest.json');

/* -------------------------------------------------------------------------- */
/* Schemas — the on-disk untrusted boundary.                                  */
/* -------------------------------------------------------------------------- */

const expectedLineSchema = z.object({
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).optional(),
  section: z.string().trim().min(1).nullable(),
  quantityValue: z.number().positive().finite().nullable(),
  unitToken: z.string().trim().min(1).nullable(),
  expectedStatus: z.enum(['ready', 'needs_review', 'ignored']),
});

const expectedRecipeSchema = z.object({
  slug: z.string().trim().min(1),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  yieldPortions: z.number().int().positive().nullable(),
  lines: z.array(expectedLineSchema).min(1),
});

// Compile-time proof the schema's output matches the metrics ExpectedRecipe type, so
// the two cannot drift (the loader returns the parsed result typed as ExpectedRecipe).
type _SchemaMatchesType = z.infer<typeof expectedRecipeSchema> extends ExpectedRecipe
  ? ExpectedRecipe extends z.infer<typeof expectedRecipeSchema>
    ? true
    : never
  : never;
const _schemaMatch: _SchemaMatchesType = true;
void _schemaMatch;

const SHA256_RE = /^[a-f0-9]{64}$/;

const manifestEntrySchema = z.object({
  slug: z.string().trim().min(1),
  image: z.string().trim().min(1),
  sha256: z.string().regex(SHA256_RE).nullable(),
  category: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  fixtures: z.array(manifestEntrySchema),
});

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Integrity + loaded fixture.                                                */
/* -------------------------------------------------------------------------- */

export type FixtureIntegrity =
  | { state: 'ok' }
  /** No image on disk — the runner skips this fixture (golden + manifest still valid). */
  | { state: 'missing_image' }
  /** Image present but the manifest checksum is null — prints the hash to pin. */
  | { state: 'unpinned'; sha256: string }
  /** Image present but its hash differs from the pinned manifest checksum. */
  | { state: 'checksum_mismatch'; expected: string; actual: string };

export type LoadedFixture = {
  expected: ExpectedRecipe;
  image: string;
  imagePath: string;
  integrity: FixtureIntegrity;
};

/** SHA-256 (hex) of a file's bytes. */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function resolveIntegrity(entry: ManifestEntry, imagePath: string): FixtureIntegrity {
  if (!existsSync(imagePath)) return { state: 'missing_image' };
  const actual = sha256File(imagePath);
  if (entry.sha256 === null) return { state: 'unpinned', sha256: actual };
  if (entry.sha256 !== actual) {
    return { state: 'checksum_mismatch', expected: entry.sha256, actual };
  }
  return { state: 'ok' };
}

/** Parse + validate the manifest. Throws (hard) if it is missing or malformed. */
export function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Eval manifest not found at ${MANIFEST_PATH}`);
  }
  const parsed = manifestSchema.safeParse(readJson(MANIFEST_PATH));
  if (!parsed.success) {
    throw new Error(`Eval manifest failed validation: ${parsed.error.message}`);
  }
  return parsed.data.fixtures;
}

/**
 * Load + validate every fixture named by the manifest, cross-checking that the golden
 * file exists, parses, and its `slug` matches the manifest entry. A committed file
 * being broken is a hard error; a missing private image is soft (reported, not thrown).
 */
export function loadFixtures(): LoadedFixture[] {
  const entries = loadManifest();
  return entries.map((entry) => {
    const fixturePath = path.join(FIXTURES_DIR, `${entry.slug}.json`);
    if (!existsSync(fixturePath)) {
      throw new Error(`Manifest references missing fixture file: ${fixturePath}`);
    }
    const parsed = expectedRecipeSchema.safeParse(readJson(fixturePath));
    if (!parsed.success) {
      throw new Error(`Fixture ${entry.slug}.json failed validation: ${parsed.error.message}`);
    }
    if (parsed.data.slug !== entry.slug) {
      throw new Error(
        `Fixture slug "${parsed.data.slug}" does not match manifest slug "${entry.slug}".`,
      );
    }
    const expected: ExpectedRecipe = parsed.data;
    const imagePath = path.join(IMAGES_DIR, entry.image);
    return { expected, image: entry.image, imagePath, integrity: resolveIntegrity(entry, imagePath) };
  });
}

/**
 * Fixture JSON files on disk that no manifest entry references (would be silently
 * un-evaluated). Used by the loader test to keep the manifest and fixtures dir in sync.
 */
export function orphanFixtureFiles(): string[] {
  const referenced = new Set(loadManifest().map((e) => `${e.slug}.json`));
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !referenced.has(f));
}
