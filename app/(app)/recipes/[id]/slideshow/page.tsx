import { notFound } from 'next/navigation';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { getRecipeMediaStorage } from '@/lib/media/recipe-media-storage';
import { logError } from '@/lib/observability';
import {
  RecipeSlideshow,
  type SlideshowSlide,
} from '@/components/app/recipes/workspace/recipe-slideshow';

/**
 * Full-screen step slideshow (plan §9.4). Kitchen-safe BY CONSTRUCTION: the
 * loader always uses the KITCHEN DTO regardless of the viewer's role, so no
 * financial key can ever reach this page's payload. One step per slide,
 * keyboard/swipe navigation, `prefers-reduced-motion` respected client-side.
 */
export default async function RecipeSlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();

  const dto = await withOrg(organizationId, (tx) =>
    getRecipeWorkspace(tx, organizationId, id, 'kitchen'),
  );
  if (!dto) notFound();

  // Signed URLs for READY media, fail-soft (media is never load-bearing).
  const readyMedia = dto.media.filter((m) => m.status === 'ready');
  let mediaUrls = new Map<string, string>();
  if (readyMedia.length > 0) {
    try {
      const storage = getRecipeMediaStorage();
      mediaUrls = new Map(
        await Promise.all(
          readyMedia.map(
            async (m) =>
              [
                m.id,
                await storage.createDownloadUrl(m.storageKey, {
                  expiresMs: 60 * 60 * 1000, // a cook-through can take a while
                }),
              ] as const,
          ),
        ),
      );
    } catch (error) {
      logError({ action: 'recipeSlideshowMediaUrls', orgId: organizationId }, error);
    }
  }
  const mediaById = new Map(readyMedia.map((m) => [m.id, m]));

  const sectionTitleById = new Map(
    dto.methodSections.map((s) => [s.id, s.title]),
  );
  const slides: SlideshowSlide[] = dto.steps.map((step) => ({
    id: step.id,
    sectionTitle: step.sectionId
      ? (sectionTitleById.get(step.sectionId) ?? null)
      : null,
    instruction: step.instruction,
    media: step.media
      .map((link) => {
        const media = mediaById.get(link.mediaId);
        const url = mediaUrls.get(link.mediaId);
        return media && url ? { url, kind: media.kind } : null;
      })
      .filter((m) => m !== null),
  }));

  return (
    <RecipeSlideshow
      recipeId={dto.recipe.id}
      recipeName={dto.recipe.name}
      slides={slides}
    />
  );
}
