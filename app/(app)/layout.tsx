import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { Sidebar } from '@/components/app/sidebar';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
          <OrganizationSwitcher
            hidePersonal
            afterCreateOrganizationUrl="/dashboard"
            afterSelectOrganizationUrl="/dashboard"
          />
          <UserButton />
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
