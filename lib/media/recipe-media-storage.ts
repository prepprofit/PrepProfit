import { del, issueSignedToken, presignUrl } from '@vercel/blob';

/**
 * RecipeMediaStorage (plan §6.4): the ONLY seam between the app and the media
 * bucket. Backed by a PRIVATE Vercel Blob store — every object requires a
 * signed URL, nothing is ever public. Keys are built SERVER-SIDE as
 * `org/{orgId}/recipes/{recipeId}/{mediaId}`; a client filename never forms a
 * key, so cross-tenant access would require forging a signature, not a path.
 *
 * Auth: every control-plane call passes `BLOB_READ_WRITE_TOKEN` EXPLICITLY (see
 * {@link blobToken}). The app is self-hosted (Hetzner + Coolify), so the OIDC path
 * the SDK prefers by default is not available.
 */

/**
 * Read-write token for control-plane calls (`issueSignedToken`, `del`, `list`).
 *
 * The SDK picks OIDC over the token whenever it can infer a store from the
 * environment — notably when `BLOB_STORE_ID` is set — and OIDC exists ONLY inside
 * Vercel. Off-Vercel that path fails with `OIDC is enabled for this project, but not
 * for the "…" environment`, even though a perfectly valid `BLOB_READ_WRITE_TOKEN` is
 * present. Passing the token explicitly pins auth to the token, independent of which
 * Blob env vars happen to be set. Returns `undefined` when unset so the SDK falls
 * back to its own resolution (tests / a future Vercel-hosted deploy).
 */
function blobToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

export type SignedUploadUrl = {
  url: string;
  expiresAt: Date;
};

export type RecipeMediaStorage = {
  /** Short-lived direct-PUT URL constrained to one key/content-type/size. */
  createUploadUrl(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresMs: number },
  ): Promise<SignedUploadUrl>;
  /** Short-lived GET URL for serving the object to an authorized viewer. */
  createDownloadUrl(key: string, opts: { expiresMs: number }): Promise<string>;
  /**
   * Read the object's leading bytes for validation. Returns null when the
   * object does not exist (upload never happened / already swept).
   */
  readHead(
    key: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; totalSize: number } | null>;
  /** Idempotent removal — missing objects are a no-op, never an error. */
  remove(key: string): Promise<void>;
};

/** Server-side storage key. Filenames NEVER participate (plan §6.4). */
export function recipeMediaKey(
  organizationId: string,
  recipeId: string,
  mediaId: string,
): string {
  return `org/${organizationId}/recipes/${recipeId}/${mediaId}`;
}

class VercelBlobRecipeMediaStorage implements RecipeMediaStorage {
  async createUploadUrl(
    key: string,
    opts: { contentType: string; maxBytes: number; expiresMs: number },
  ): Promise<SignedUploadUrl> {
    const validUntil = Date.now() + opts.expiresMs;
    const token = await issueSignedToken({
      pathname: key,
      operations: ['put'],
      allowedContentTypes: [opts.contentType],
      maximumSizeInBytes: opts.maxBytes,
      validUntil,
      token: blobToken(),
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname: key,
      access: 'private',
      allowedContentTypes: [opts.contentType],
      maximumSizeInBytes: opts.maxBytes,
      addRandomSuffix: false,
      allowOverwrite: true, // retrying a failed upload reuses the same key
      validUntil,
    });
    return { url: presignedUrl, expiresAt: new Date(validUntil) };
  }

  async createDownloadUrl(
    key: string,
    opts: { expiresMs: number },
  ): Promise<string> {
    const validUntil = Date.now() + opts.expiresMs;
    const token = await issueSignedToken({
      pathname: key,
      operations: ['get'],
      validUntil,
      token: blobToken(),
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname: key,
      access: 'private',
      validUntil,
    });
    return presignedUrl;
  }

  async readHead(
    key: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const token = await issueSignedToken({
      pathname: key,
      operations: ['get'],
      validUntil: Date.now() + 60_000,
      token: blobToken(),
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname: key,
      access: 'private',
      // The confirm read must see the JUST-uploaded bytes, not a CDN entry.
      useCache: false,
    });
    const res = await fetch(presignedUrl, {
      headers: { Range: `bytes=0-${maxBytes - 1}` },
    });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) {
      throw new Error(`Blob read failed for confirm: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // 206 carries "bytes 0-n/total"; a 200 means we got the whole object.
    const contentRange = res.headers.get('content-range');
    const totalSize = contentRange?.match(/\/(\d+)$/)
      ? Number(contentRange.match(/\/(\d+)$/)![1])
      : bytes.byteLength;
    return { bytes, totalSize };
  }

  async remove(key: string): Promise<void> {
    // `del` accepts pathnames and does not throw on missing blobs.
    await del(key, { token: blobToken() });
  }
}

let storage: RecipeMediaStorage | null = null;

/** Process-wide adapter instance (swap point for tests via the facade args). */
export function getRecipeMediaStorage(): RecipeMediaStorage {
  storage ??= new VercelBlobRecipeMediaStorage();
  return storage;
}
