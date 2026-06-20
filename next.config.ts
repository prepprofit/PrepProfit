import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the XLSX reader (Sprint 4.5 import) out of the webpack bundle: its Node
  // build pulls in `unzipper`, which has an OPTIONAL `@aws-sdk/client-s3` require
  // (only for S3 sources we never use). Bundling tries to resolve it and fails;
  // externalizing leaves it as a runtime Node require on the import route only.
  serverExternalPackages: ['read-excel-file', 'unzipper'],
};

// Sentry (Sprint 5a) wraps the already-composed config. Source-map upload only
// runs when `SENTRY_AUTH_TOKEN` (+ org/project) are present — so builds without
// those secrets (CI, local) stay green; `silent` keeps non-CI build output clean.
export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
});
