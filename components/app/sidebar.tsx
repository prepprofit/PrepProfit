'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  Utensils,
  Package,
  Boxes,
  Calculator,
  Users,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import { navModules, type NavKey } from '@/lib/nav';
import { cn } from '@/lib/utils';

const icons: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  recipes: Utensils,
  ingredients: Package,
  inventory: Boxes,
  breakEven: Calculator,
  payroll: Users,
  invoices: FileText,
};

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tApp = useTranslations('app');

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-6 py-5">
        <Image
          src="/logo_final.jpg"
          alt="PrepProfit"
          width={32}
          height={32}
          className="rounded-md"
        />
        <span className="font-display text-lg font-semibold text-slate-900">
          {tApp('name')}
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {navModules.map(({ key, href }) => {
          const Icon = icons[key];
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={key}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'border border-slate-200/60 bg-white text-brand-700 shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              <Icon
                className={cn(
                  'size-4',
                  active ? 'text-brand-600' : 'text-slate-400',
                )}
              />
              {t(key)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
