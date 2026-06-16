'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `value` delayed by `delayMs` — each change resets the timer, so the
 * debounced value only settles once input stops. Used to throttle the ⌘K search
 * input so we hit the server action at most once per pause, not per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
