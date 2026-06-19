import type { NextConfig } from 'next';
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

export default withNextIntl(nextConfig);
