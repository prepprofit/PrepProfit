'use client';

import * as React from 'react';
import posthog from 'posthog-js';
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
    // TEMPORARY: only fires if PostHog already loaded (consent granted before
    // the crash) — a second capture path while diagnosing the iPhone crash.
    if (posthog.__loaded) {
      posthog.captureException(error, { boundary: 'global-error' });
    }
    // Stale-client crashes (old build in a restored tab/bfcache after a deploy:
    // missing chunks, WebKit hooks bug, vendor code the current build no longer
    // ships — e.g. the removed Flows SDK's `new WebSocket` throwing
    // SecurityError "The operation is insecure" on iOS) are fixed by fetching
    // the current build. A message allowlist can't enumerate every stale-bundle
    // failure, so auto-reload ONCE for ANY global error; the sessionStorage
    // guard means a genuinely persistent error reloads once, then shows this
    // screen instead of looping.
    try {
      if (!sessionStorage.getItem('pp-global-error-reloaded')) {
        sessionStorage.setItem('pp-global-error-reloaded', '1');
        window.location.reload();
      }
    } catch {
      // sessionStorage unavailable (private mode): leave the manual button.
    }
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
          {/* TEMPORARY diagnostic panel for the iPhone WebKit crash investigation.
              Remove once the root cause is found — this is intentionally visible
              to whoever hits the error so it can be read/photographed off-device
              without needing a Mac for remote Safari debugging. */}
          <div
            style={{
              marginTop: 24,
              textAlign: 'left',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              color: '#334155',
              background: '#f1f5f9',
              borderRadius: 8,
              padding: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <div>
              <strong>message:</strong> {error.message || '(empty)'}
            </div>
            {error.digest && (
              <div>
                <strong>digest:</strong> {error.digest}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <strong>stack:</strong>
              {'\n'}
              {error.stack || '(no stack)'}
            </div>
            <div style={{ marginTop: 8 }}>
              <strong>ua:</strong>{' '}
              {typeof navigator !== 'undefined' ? navigator.userAgent : '(n/a)'}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
