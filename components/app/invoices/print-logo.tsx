'use client';

import { useState } from 'react';

/**
 * Seller logo on the print view. The browser (not our server) fetches the URL, so
 * there is no SSRF surface here, but we still set `referrerPolicy="no-referrer"`
 * to avoid leaking the app URL to the logo host and hide the image if it fails to
 * load so a broken link never disfigures the printed invoice.
 */
export function PrintLogo({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      className="mb-2 max-h-12 w-auto object-contain"
      onError={() => setFailed(true)}
    />
  );
}
