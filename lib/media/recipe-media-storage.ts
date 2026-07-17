import { del, issueSignedToken, presignUrl } from '@vercel/blob';

/**
 * RecipeMediaStorage (plan §6.4): the ONLY seam between the app and the media
 * bucket. Backed by a PRIVATE Vercel Blob store — every object requires a
 * signed URL, nothing is ever public. Keys are built SERVER-SIDE as
 * `org/{orgId}/recipes/{recipeId}/{mediaId}`; a client filename never forms a
 * key, so cross-tenant access would require forging a signature, not a path.
 *
 * Auth: on Vercel the SDK uses OIDC automatically once the private store is
 * connected to the project; locally set `BLOB_READ_WRITE_TOKEN` (SETUP.md).
 */

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
    await del(key);
  }
}

let storage: RecipeMediaStorage | null = null;

/** Process-wide adapter instance (swap point for tests via the facade args). */
export function getRecipeMediaStorage(): RecipeMediaStorage {
  storage ??= new VercelBlobRecipeMediaStorage();
  return storage;
}
