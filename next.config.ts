import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Browser-hardening headers (audit F-04). The always-on set (nosniff, referrer,
 * permissions, clickjacking) is cheap and breaks nothing. The CSP ships
 * Report-Only first: an SSR app pulls in third-party scripts (Clerk, Sentry,
 * PostHog) whose exact origins are easy to under-allowlist, so we observe
 * violation reports in the browser console before promoting to an enforcing
 * `Content-Security-Policy`. `'unsafe-inline'`/`'unsafe-eval'` stay until Next's
 * nonce-based CSP is wired; `frame-ancestors 'none'` is the real anti-clickjacking
 * control (X-Frame-Options is the legacy mirror).
 */
const CLERK = 'https://*.clerk.com https://*.clerk.accounts.dev https://clerk-telemetry.com';
const SENTRY = 'https://*.sentry.io https://*.ingest.sentry.io https://*.ingest.de.sentry.io';
const POSTHOG = 'https://*.posthog.com https://*.i.posthog.com';

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CLERK} ${POSTHOG} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://img.clerk.com ${CLERK}`,
  "font-src 'self' data:",
  `connect-src 'self' ${CLERK} ${SENTRY} ${POSTHOG}`,
  "worker-src 'self' blob:",
  `frame-src 'self' ${CLERK} https://challenges.cloudflare.com https://js.stripe.com https://checkout.stripe.com`,
]
  .join('; ')
  // Collapse the spacing introduced by the multi-token third-party constants.
  .replace(/\s+/g, ' ')
  .trim();

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  // CSP is Report-Only for now (see note above): violations are logged, never blocked.
  { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy },
  // HSTS only in production (HTTPS-only); browsers ignore it on plain-http localhost,
  // but gating it keeps dev preview tooling from caching a forced-HTTPS upgrade.
  ...(isProd
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the XLSX reader (Sprint 4.5 import) out of the webpack bundle: its Node
  // build pulls in `unzipper`, which has an OPTIONAL `@aws-sdk/client-s3` require
  // (only for S3 sources we never use). Bundling tries to resolve it and fails;
  // externalizing leaves it as a runtime Node require on the import route only.
  serverExternalPackages: ['read-excel-file', 'unzipper'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
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
