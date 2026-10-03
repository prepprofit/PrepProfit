'use client';

import * as React from 'react';

/**
 * Protects unsaved edits while `active`: the browser's own prompt on reload/close,
 * and in-app links (sidebar, breadcrumbs, any `<a>` to this site) are held back so
 * the page can ask first. A capture-phase listener on `document` runs before the
 * Next.js `<Link>` handler, so the navigation never starts unless confirmed.
 */
export function useLeaveGuard(active: boolean, onAttempt: (href: string) => void) {
  const attemptRef = React.useRef(onAttempt);
  React.useEffect(() => {
    attemptRef.current = onAttempt;
  }, [onAttempt]);

  React.useEffect(() => {
    if (!active) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Safari only prompts when returnValue is set.
      e.returnValue = '';
    };
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download') || anchor.dataset.leaveGuard === 'off') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page (e.g. an in-page anchor) is not leaving.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      attemptRef.current(url.pathname + url.search + url.hash);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [active]);
}
