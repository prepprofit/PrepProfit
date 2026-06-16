import { AppShell } from '@/components/app/app-shell';
import { canAccessFinancials, getUserRole } from '@/lib/auth';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Role drives the cosmetic nav (the Finance group is hidden for kitchen staff);
  // the real enforcement lives in each finance page + action.
  const role = await getUserRole();

  return (
    <AppShell canSeeFinance={canAccessFinancials(role)}>{children}</AppShell>
  );
}
