import { ThemedSignIn } from '@/components/auth/themed-clerk';

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <ThemedSignIn />
    </div>
  );
}
