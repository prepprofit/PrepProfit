'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

/** Thin wrapper so the (client) next-themes provider can be mounted from the
 *  root server layout. Light is the default theme; dark via the top-bar toggle. */
export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props} />;
}
