import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { NoAccess } from '@/components/app/no-access';
import { InvoiceUpload } from './upload-client';

/**
 * Supplier Invoice Reader upload (Sprint 2, AI margin roadmap). Manager-only on the
 * SERVER (defense-in-depth — the upload route enforces the same 403): kitchen users
 * get NoAccess. AI is a UNIVERSAL feature metered per-org by the monthly quota at the
 * upload route. The extraction is always staged for human review — applying records
 * PENDING price observations only, never an approved-cost change (CLAUDE.md).
 */
export default async function SupplierInvoiceImportPage() {
  const t = await getTranslations('suppliers.invoices');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('upload.subtitle')}</p>
      <InvoiceUpload />
    </div>
  );
}
