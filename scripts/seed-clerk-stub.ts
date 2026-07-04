/**
 * Seed-runtime stub for `@clerk/nextjs/server`.
 *
 * The full-demo seed (`scripts/seed-full-demo.ts`) imports data-layer helpers
 * that transitively pull in `lib/auth.ts`, which imports Clerk's Next.js server
 * module — a package that only resolves inside the Next runtime and throws under
 * plain `tsx`. The seed never authenticates (it passes org + actor explicitly),
 * so we map that import to this no-op stub via `tsconfig.seed.json` `paths`.
 * Calling `auth()` here is a bug, so it throws loudly.
 */

export function auth(): never {
  throw new Error('Clerk auth() is not available in the seed runtime.');
}
auth.protect = (): void => {};

export async function clerkClient(): Promise<Record<string, never>> {
  return {};
}

export async function currentUser(): Promise<null> {
  return null;
}
