'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FileText, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';

/**
 * Invoice upload (Sprint 2). Posts the chosen image/PDF to the manager-only upload
 * route, then navigates to the review workbench for the created draft import. All
 * validation + metering happens on the server; this only surfaces progress + errors.
 */
export function InvoiceUpload() {
  const t = useTranslations('suppliers.invoices.upload');
  const actionError = useActionError();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<ActionErrorCode | null>(null);

  async function onFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append('document', file);
      const res = await fetch('/api/suppliers/invoices/import', {
        method: 'POST',
        body,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { code?: ActionErrorCode } | null;
        setError(data?.code ?? 'UNEXPECTED');
        setUploading(false);
        return;
      }
      const data = (await res.json()) as { importId: string };
      router.push(`/suppliers/invoices/import/${data.importId}`);
    } catch {
      setError('UNEXPECTED');
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-5 text-accent-600" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
            e.target.value = '';
          }}
        />
        <div>
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            <Upload className="size-4" />
            {uploading ? t('uploading') : t('choose')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('supported')}</p>
        <p className="text-xs text-muted-foreground">{t('safety')}</p>
        {error && (
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            {actionError(error)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
