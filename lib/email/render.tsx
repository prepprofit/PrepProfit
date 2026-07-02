import type { ReactElement } from 'react';
import { render } from '@react-email/render';

/**
 * Server-only render seam for React Email templates (React Email migration).
 *
 * The whole app builds email bodies by rendering a template element to
 * `{ html, text }` HERE, then hands that to the existing `EmailSender.send`
 * seam — the rest of the app (actions, webhooks, cron, outbox worker) stays
 * decoupled from Resend's React payload behavior and tests stay deterministic
 * (they render through this same helper, never snapshot raw JSX).
 *
 * The plain-text alternative is generated from the SAME element, so every send
 * ships a text fallback for accessibility/deliverability without maintaining a
 * second copy.
 *
 * SERVER-ONLY: do not import `emails/*` (or this helper) from client components.
 */
export async function renderEmail(
  element: ReactElement,
): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}
