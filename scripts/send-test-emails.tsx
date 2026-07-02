import React from 'react';
import { Resend } from 'resend';
import { renderEmail } from '../lib/email/render';
import { WelcomeEmail } from '../emails/WelcomeEmail';
import { SubscriptionEmail } from '../emails/SubscriptionEmail';
import { PaymentPastDueEmail } from '../emails/PaymentPastDueEmail';
import { LowStockEmail } from '../emails/LowStockEmail';
import { DocumentEmail } from '../emails/DocumentEmail';
import { PurchaseOrderEmail } from '../emails/PurchaseOrderEmail';
import { AiCostReportEmail } from '../emails/AiCostReportEmail';
import { CfoReportEmail } from '../emails/CfoReportEmail';

/**
 * One-off: render every migrated React Email template with realistic sample data and
 * send one of each to a test recipient, so a human can eyeball them in a real inbox.
 * NOT wired into the app. Run with:
 *   RESEND_API_KEY=... RESEND_FROM_EMAIL=info@prepprofit.com npx tsx scripts/send-test-emails.tsx
 * Optional: TEST_EMAIL_TO (default below), RESEND_FROM_NAME, APP_URL for CTAs.
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional
  }
}

const TO = process.env.TEST_EMAIL_TO ?? 'andre@wpexperts.pt';
const APP = (process.env.APP_URL ?? 'https://www.prepprofit.com').replace(/\/+$/, '');

const brand = {
  brandName: 'PrepProfit',
  footerLines: [
    'PrepProfit — financial clarity for food businesses.',
    'This is an automated TEST message from your PrepProfit workspace.',
  ],
};

/** Each entry: a human label, the subject line, and the template element. */
function samples() {
  return [
    {
      label: 'Welcome',
      subject: '[TEST] Welcome to PrepProfit, Padaria do André',
      element: (
        <WelcomeEmail
          {...brand}
          preview="Your organization is ready — start costing your recipes."
          heading="Welcome to PrepProfit, Padaria do André"
          body="Your organization Padaria do André is ready. Add your ingredients and recipes to start costing, then explore financials, invoices and inventory. Reply to this email if you need a hand."
          cta={{ href: `${APP}/dashboard`, label: 'Open your dashboard' }}
        />
      ),
    },
    {
      label: 'Subscription (upgraded)',
      subject: '[TEST] Your plan is now PrepProfit Pro',
      element: (
        <SubscriptionEmail
          {...brand}
          preview="Padaria do André has been upgraded to Pro."
          heading="Your plan is now PrepProfit Pro"
          body="Padaria do André has been upgraded to the Pro plan. The extra limits and modules it includes are available immediately. You can review your plan any time on the billing page."
          cta={{ href: `${APP}/billing`, label: 'Manage billing' }}
        />
      ),
    },
    {
      label: 'Payment past due',
      subject: '[TEST] Action needed: update your payment method',
      element: (
        <PaymentPastDueEmail
          {...brand}
          preview="We couldn't process your latest payment."
          heading="Action needed: update your payment method"
          body="We couldn't process the latest payment for Padaria do André on the Pro plan, so the subscription is now past due. Please update your payment method on the billing page to keep your plan active."
          cta={{ href: `${APP}/billing`, label: 'Manage billing' }}
        />
      ),
    },
    {
      label: 'Low stock',
      subject: '[TEST] 3 ingredients are running low',
      element: (
        <LowStockEmail
          {...brand}
          preview="3 ingredients are at or below their threshold."
          heading="3 ingredients are running low"
          intro="These ingredients in Padaria do André are at or below their low-stock threshold and may need reordering:"
          items={[
            'Butter — 200 g left (threshold 500 g)',
            'Milk — 1000 ml left (threshold 2000 ml)',
            'Eggs — 6 left (threshold 12)',
          ]}
          cta={{ href: `${APP}/inventory`, label: 'Review low stock' }}
        />
      ),
    },
    {
      label: 'Document (invoice cover)',
      subject: '[TEST] Invoice INV-2026-0001',
      element: (
        <DocumentEmail
          {...brand}
          preview="Please find Invoice INV-2026-0001 attached."
          heading="Invoice INV-2026-0001"
          body="Please find Invoice INV-2026-0001 attached. (In the app this email carries the PDF as an attachment — this test has none.)"
        />
      ),
    },
    {
      label: 'Purchase order',
      subject: '[TEST] Purchase order 1',
      element: (
        <PurchaseOrderEmail
          {...brand}
          preview="Purchase order 1 from Padaria do André."
          heading="Purchase order 1"
          body="Please find attached purchase order 1 from Padaria do André. The order details are in the attached PDF. (This test has no attachment.)"
        />
      ),
    },
    {
      label: 'AI cost report (operator)',
      subject: '[TEST] PrepProfit — AI spend report (2026-06-25 – 2026-07-02)',
      element: (
        <AiCostReportEmail
          {...brand}
          preview="AI extraction spend for the last 7 days."
          heading="AI extraction spend"
          periodLabel="Last 7 days (2026-06-25 – 2026-07-02)"
          totals={[
            { label: 'Estimated spend', value: '$1.42', emphasize: true },
            { label: 'Extractions', value: '58' },
            { label: 'Average per extraction', value: '$0.02' },
            { label: 'Input tokens', value: '412,900' },
            { label: 'Output tokens', value: '73,140' },
          ]}
          byOrgTitle="By organization"
          orgHeader={{ name: 'Organization', count: 'Extractions', spend: 'Estimated spend' }}
          orgRows={[
            { name: 'Padaria do André', count: '31', spend: '$0.79' },
            { name: 'Wibox Kitchen', count: '27', spend: '$0.63' },
          ]}
          emptyText="No extractions in this period."
          notes={[
            'Model: gemini-2.5-flash',
            'Estimated from token usage × Gemini list price; may differ slightly from Google billing.',
          ]}
        />
      ),
    },
    {
      label: 'Weekly CFO report',
      subject: '[TEST] Your weekly CFO report (2026-07-02)',
      element: (
        <CfoReportEmail
          {...brand}
          preview="Your week at a glance — revenue, food cost, leaks and low stock."
          heading="Weekly CFO report"
          periodLabel="2026-06-26 to 2026-07-02"
          summary={[
            { label: 'Revenue', value: '€4,820.00 (+6.4%)', emphasize: true },
            { label: 'Food cost', value: '31.8% (+1.2 pts)' },
          ]}
          sections={[
            {
              title: 'Biggest margin leaks',
              items: [
                { left: 'Croissant is at 48% margin, below the 65% target' },
                { left: 'Brunch Menu is at 52% margin, below the 65% target' },
              ],
            },
            {
              title: 'Items to reprice',
              items: [
                { left: 'Croissant', right: '48% margin · Suggested: €3.20' },
                { left: 'Almond Tart', right: '55% margin · Suggested: €4.80' },
              ],
            },
            {
              title: 'Supplier price changes',
              items: [{ left: 'Butter', right: '€6.50 → €7.20 (+10.8%)' }],
            },
            {
              title: 'Low stock',
              items: [
                { left: 'Butter', right: '200 g on hand · reorder at 500 g' },
                { left: 'Eggs', right: '6 pcs on hand · reorder at 12 pcs' },
              ],
            },
          ]}
          confidenceTitle="What limits this report"
          confidenceNotes={[
            '2 ingredient(s) used in active recipes still need a price.',
          ]}
          cta={{ href: `${APP}/reports/cfo?weekTo=2026-07-02`, label: 'Open the full report' }}
        />
      ),
    },
  ];
}

async function main() {
  loadEnv();
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    throw new Error('Set RESEND_API_KEY and RESEND_FROM_EMAIL (in .env.local or the shell).');
  }
  const fromName = process.env.RESEND_FROM_NAME ?? 'PrepProfit';
  const from = `${fromName} <${fromEmail}>`;
  const resend = new Resend(apiKey);

  console.log(`Sending ${samples().length} test emails to ${TO} from ${from}\n`);
  for (const s of samples()) {
    const { html, text } = await renderEmail(s.element);
    const { data, error } = await resend.emails.send({
      from,
      to: TO,
      subject: s.subject,
      html,
      text,
    });
    if (error || !data) {
      console.error(`✗ ${s.label}: ${error?.message ?? 'no data returned'}`);
    } else {
      console.log(`✓ ${s.label}: ${data.id}`);
    }
    // Gentle spacing to stay well under any rate limit.
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
