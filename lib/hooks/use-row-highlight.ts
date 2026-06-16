'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drives the "jump to a record" affordance for ⌘K deep-links (Sprint 2.7): when
 * `highlightId` is present, scroll the matching row into view and flash it
 * briefly. Returns the id currently flashing (null once it fades) so a row can
 * toggle a highlight class. `domIdPrefix` + the record id must equal the row's
 * rendered element `id`.
 */
export function useRowHighlight(
  highlightId: string | undefined,
  domIdPrefix: string,
  durationMs = 2200,
): string | null {
  const [flashId, setFlashId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!highlightId) return;
    const el = document.getElementById(`${domIdPrefix}${highlightId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(highlightId);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlashId(null), durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [highlightId, domIdPrefix, durationMs]);

  return flashId;
}
