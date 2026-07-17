'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Direct-to-bucket media upload (Fase 3, plan §6.4): asks the server for a
 * short signed PUT URL (the server builds the storage key — the filename never
 * leaves the browser), PUTs the file straight to the private store, then
 * confirms so the server validates the REAL bytes. On success the caller
 * receives the media id + a short signed preview URL.
 */
export function RecipeMediaUpload({
  recipeId,
  onUploaded,
  disabled,
  label,
}: {
  recipeId: string;
  onUploaded: (media: { mediaId: string; url: string }) => void;
  disabled?: boolean;
  label?: string;
}) {
  const t = useTranslations('recipes.workspace.media');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const kind = file.type.startsWith('video/') ? 'video' : 'image';
      const urlRes = await fetch(`/api/recipes/${recipeId}/media/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, mimeType: file.type }),
      });
      if (!urlRes.ok) throw new Error('upload-url');
      const { mediaId, uploadUrl } = (await urlRes.json()) as {
        mediaId: string;
        uploadUrl: string;
      };

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error('put');

      const confirmRes = await fetch(`/api/recipes/${recipeId}/media/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId }),
      });
      if (!confirmRes.ok) throw new Error('confirm');
      const confirmed = (await confirmRes.json()) as {
        mediaId: string;
        url: string;
      };
      onUploaded({ mediaId: confirmed.mediaId, url: confirmed.url });
    } catch {
      setError(t('uploadFailed'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus /> {busy ? t('uploading') : (label ?? t('addPhoto'))}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
    </span>
  );
}
