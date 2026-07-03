'use client';

import { useEffect } from 'react';
import { useAuth, useOrganization, useUser } from '@clerk/nextjs';

/**
 * Crisp live-chat widget (owner chose human support via a platform over an in-app
 * LLM bot — see docs/support-chat-plan.md, DEFERRED). Mounted SITE-WIDE in the root
 * layout so it serves both anonymous pre-sales visitors on the marketing site and
 * signed-in users in the app; identity (below) is attached only once a user is signed in.
 *
 * The website id is a PUBLIC build-time value (`NEXT_PUBLIC_CRISP_WEBSITE_ID`), read
 * directly here. When it is absent (local/CI without the id) the component is a safe
 * no-op, so `next build` stays green without the secret and the widget simply does not
 * appear until the id is set in `.env.local` / Vercel.
 *
 * Identity is gathered CLIENT-side via Clerk hooks (no extra server round-trip on every
 * page load): we pass only who is writing — email, name, org id, and coarse role — so
 * support knows the person and tenant. We NEVER push financial data, recipe/ingredient
 * contents, or anything sensitive into Crisp.
 */

const CRISP_SRC = 'https://client.crisp.chat/l.js';

declare global {
  interface Window {
    $crisp?: unknown[];
    CRISP_WEBSITE_ID?: string;
  }
}

export function CrispChat() {
  const websiteId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID;
  const { isLoaded, user } = useUser();
  const { organization } = useOrganization();
  const { orgRole } = useAuth();

  // Load the Crisp client once. Guarded against the id being unset and against a
  // duplicate <script> if the layout remounts (Crisp keeps its own global state).
  useEffect(() => {
    if (!websiteId) return;
    window.$crisp = window.$crisp ?? [];
    window.CRISP_WEBSITE_ID = websiteId;
    if (!document.querySelector(`script[src="${CRISP_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = CRISP_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  }, [websiteId]);

  // Identify the signed-in user for the support agent. Non-sensitive descriptors only.
  useEffect(() => {
    if (!websiteId || !isLoaded || !window.$crisp) return;
    const crisp = window.$crisp;

    const email = user?.primaryEmailAddress?.emailAddress;
    const name = user?.fullName;
    if (email) crisp.push(['set', 'user:email', [email]]);
    if (name) crisp.push(['set', 'user:nickname', [name]]);

    const sessionData: [string, string][] = [];
    if (organization?.id) sessionData.push(['org_id', organization.id]);
    // Same mapping the app uses everywhere: Clerk `org:admin` => manager, else kitchen.
    if (orgRole) sessionData.push(['role', orgRole === 'org:admin' ? 'manager' : 'kitchen']);
    if (sessionData.length > 0) crisp.push(['set', 'session:data', [sessionData]]);
  }, [websiteId, isLoaded, user, organization?.id, orgRole]);

  return null;
}
