// Permite o import side-effect de CSS global (ex.: app/globals.css) no TypeScript.
declare module '*.css';

// Custom Clerk session-token claims. `org_trial_ends_at` is projected from the
// org's `public_metadata.trial_ends_at` by the session-token template (configured
// in the Clerk dashboard), so `auth().sessionClaims` carries the reverse-trial
// deadline with ZERO extra I/O in the request-time entitlement path. Declared at
// top level (this file is a script, not a module) so it merges into the global
// `CustomJwtSessionClaims` interface Clerk reads — do NOT add a top-level import or
// `export` here, or `declare module '*.css'` stops applying globally.
interface CustomJwtSessionClaims {
  org_trial_ends_at?: string;
}
