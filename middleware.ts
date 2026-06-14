import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
]);

const isOrgSelectionRoute = createRouteMatcher(['/select-organization(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  // Require authentication for everything that is not public.
  await auth.protect();

  // RULE #1: no active organization, no access to the modules.
  // Redirect to organization selection/creation.
  const { orgId } = await auth();
  if (!orgId && !isOrgSelectionRoute(req)) {
    return NextResponse.redirect(new URL('/select-organization', req.url));
  }
});

export const config = {
  matcher: [
    // Everything except static files and _next
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
