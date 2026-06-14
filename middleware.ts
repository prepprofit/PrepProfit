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

  // Exige autenticação para tudo que não é público.
  await auth.protect();

  // REGRA Nº 1: sem organização ativa, não há acesso aos módulos.
  // Redireciona para a seleção/criação de organização.
  const { orgId } = await auth();
  if (!orgId && !isOrgSelectionRoute(req)) {
    return NextResponse.redirect(new URL('/select-organization', req.url));
  }
});

export const config = {
  matcher: [
    // Tudo exceto arquivos estáticos e _next
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
