import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
});

export const metadata: Metadata = {
  title: 'GastroKit',
  description: 'Gestão financeira para chefs e negócios de comida',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    <ClerkProvider>
      <html lang={locale} className={`${inter.variable} ${spaceGrotesk.variable}`}>
        <body className="font-sans" suppressHydrationWarning>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
