import { getTranslations } from 'next-intl/server';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipes } from '@/lib/data/recipes';
import { listMenus } from '@/lib/data/menus';
import { listTaskListOptions } from '@/lib/data/tasks';
import { PrepPlannerClient } from '@/components/app/tasks/prep-planner-client';

/**
 * Prep/Reorder Planner (Sprint 7, AI margin roadmap). OPERATIONAL and MONEY-FREE — visible
 * to BOTH roles (it lives under /tasks). The page loads only lightweight id+name options
 * (never a price/cost) for the demand builder; the deterministic plan, the optional AI
 * summary, and turning the plan into anchored tasks all run through server actions. Creating
 * tasks is manager-only (the plan can create reorder tasks) — the client hides that control
 * for kitchen, and the action enforces it server-side.
 */
export default async function PrepPlannerPage() {
  const t = await getTranslations('prepPlanner');
  const organizationId = await getOrgId();

  const [canManage, options] = await Promise.all([
    isManager(),
    withOrg(organizationId, async (tx) => {
      const [recipes, menus, taskLists] = await Promise.all([
        listRecipes(tx, organizationId),
        listMenus(tx, organizationId),
        listTaskListOptions(tx, organizationId),
      ]);
      return {
        recipes: recipes.map((r) => ({ id: r.id, name: r.name })),
        menus: menus.map((m) => ({ id: m.id, name: m.name })),
        taskLists,
      };
    }),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <PrepPlannerClient
        recipes={options.recipes}
        menus={options.menus}
        taskLists={options.taskLists}
        canManage={canManage}
      />
    </div>
  );
}
