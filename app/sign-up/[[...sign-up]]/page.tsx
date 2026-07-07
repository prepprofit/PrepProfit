import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ThemedSignUp } from '@/components/auth/themed-clerk';

export default async function SignUpPage() {
  const t = await getTranslations('legal');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
      <ThemedSignUp />
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        {t.rich('signupNotice', {
          terms: (chunks) => (
            <Link href="/terms" className="underline underline-offset-2">
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link href="/privacy" className="underline underline-offset-2">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
