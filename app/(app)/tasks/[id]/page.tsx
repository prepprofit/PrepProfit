import { notFound } from 'next/navigation';
import { getOrgId, isManager, listOrgMembers } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getTaskListWithTasks } from '@/lib/data/tasks';
import { TaskListDetail } from '@/components/app/tasks/task-list-detail';

/**
 * One task list (Sprint 6). BOTH roles open it and complete/add/edit/reorder tasks
 * in an active list; managers additionally assign, reset, duplicate, delete the list
 * and hard-delete tasks. Money-free. A missing/trashed list 404s (active-only read).
 */
export default async function TaskListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();
  const [canManage, members] = await Promise.all([isManager(), listOrgMembers()]);

  const detail = await withOrg(organizationId, (tx) =>
    getTaskListWithTasks(tx, organizationId, id),
  );
  if (!detail) notFound();

  return <TaskListDetail detail={detail} canManage={canManage} members={members} />;
}
