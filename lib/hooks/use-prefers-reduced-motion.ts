'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks the OS "reduce motion" setting — used to disable Recharts' entry
 * animation for users who asked for less motion. Returns false on the server /
 * first paint, then syncs from the media query on the client.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
