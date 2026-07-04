import type { Metadata } from 'next';
import { Roboto, Outfit } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { ThemeProvider } from '@/components/theme-provider';
import { CrispChat } from '@/components/support/crisp-chat';
import './globals.css';

// Google-product type pairing: Roboto for UI/body (the Android system font) and
// Outfit for display — a free, geometric stand-in for the proprietary Google Sans.
const roboto = Roboto({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-roboto',
});
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit' });

export const metadata: Metadata = {
  title: 'PrepProfit',
  description: 'Financial management for chefs and food businesses',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    <ClerkProvider>
      <html
        lang={locale}
        className={`${roboto.variable} ${outfit.variable}`}
        suppressHydrationWarning
      >
        <body className="font-sans" suppressHydrationWarning>
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem
            disableTransitionOnChange
          >
            <NextIntlClientProvider>
              {children}
              {/* Crisp live-chat, site-wide: helps anonymous pre-sales visitors on the
                  marketing site AND signed-in users in the app. No-op until
                  NEXT_PUBLIC_CRISP_WEBSITE_ID is set; identifies the user only once
                  signed in. */}
              <CrispChat />
            </NextIntlClientProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
