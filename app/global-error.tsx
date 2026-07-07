'use client';

import * as React from 'react';
import { logError } from '@/lib/observability';

/**
 * Last-resort boundary: catches errors thrown by the root layout itself, so it
 * replaces `<html>`/`<body>` and renders OUTSIDE every provider (no next-intl,
 * no theme) — hence plain English and inline styles. The localized, in-app
 * boundary is `app/(app)/error.tsx`.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    logError({ action: 'global-error' }, error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          background: '#ffffff',
          color: '#0f172a',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', marginBottom: 20 }}>
            An unexpected error occurred. Please try again.
          </p>
          <button
            type="button"
            // Full reload, NOT reset(): a root-layout crash here is often a stale
            // client (tab restored from bfcache after a deploy, old build against
            // the new server). reset() re-renders the same broken in-memory state
            // forever; a hard reload fetches the current build and recovers.
            onClick={() => window.location.reload()}
            style={{
              cursor: 'pointer',
              borderRadius: 9999,
              border: 'none',
              background: '#c2410c',
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 500,
              padding: '10px 20px',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
