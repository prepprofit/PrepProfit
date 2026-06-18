import type { SellerIdentity } from './types';

/**
 * The seller fields every generated document reads — satisfied by both the
 * `organization_settings` row and `OrgSettingsValues`. Kept narrow so the builder
 * stays pure and testable (Sprint 3.5A invoice + 3.5B report documents share it).
 */
export type SellerSettings = {
  currency: string;
  businessName: string | null;
  businessAddress: string | null;
  businessTaxId: string | null;
  businessEmail: string | null;
  businessLogoUrl: string | null;
};

/** Trim a value to null when it is null/blank. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Build the shared "From"/branding block from org settings, falling back to the
 * Clerk organization name when no business name is saved. The logo is the stored
 * https URL (or null); document routes replace it with SSRF-safe local bytes via
 * `loadSafeLogo` before rendering.
 */
export function buildSellerIdentity(
  settings: SellerSettings,
  orgNameFallback: string | null,
): SellerIdentity {
  return {
    name: blankToNull(settings.businessName) ?? blankToNull(orgNameFallback) ?? '',
    address: blankToNull(settings.businessAddress),
    taxId: blankToNull(settings.businessTaxId),
    email: blankToNull(settings.businessEmail),
    logoUrl: blankToNull(settings.businessLogoUrl),
  };
}
