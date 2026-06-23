import { getOrgId, getUserRole, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTaskLists } from '@/lib/data/tasks';
import { TasksOverview, type OverviewList } from '@/components/app/tasks/tasks-overview';

/**
 * Kitchen task lists (Sprint 6). BOTH roles see the lists, grouped Today / Upcoming /
 * No date with a progress bar. Managers can create / duplicate / delete lists; kitchen
 * opens and works them. Money-free end-to-end — there is no cost branch.
 */
export default async function TasksPage() {
  const organizationId = await getOrgId();
  const [role, canManage] = await Promise.all([getUserRole(), isManager()]);
  void role;

  const lists = await withOrg(organizationId, (tx) =>
    listTaskLists(tx, organizationId),
  );

  // Group by scheduled date relative to today (bare calendar dates, no tz math).
  const today = new Date().toISOString().slice(0, 10);
  const overview: OverviewList[] = lists.map((l) => ({
    id: l.id,
    name: l.name,
    scheduledFor: l.scheduledFor,
    updatedAt: l.updatedAt,
    done: l.progress.done,
    total: l.progress.total,
    group:
      l.scheduledFor === null
        ? 'noDate'
        : l.scheduledFor <= today
          ? 'today'
          : 'upcoming',
  }));

  return <TasksOverview lists={overview} canManage={canManage} />;
}
