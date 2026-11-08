// At least two labels ending in a name: rejects IP literals, however they were
// written, and single-label internal names. A trailing dot also fails here.
const PUBLIC_HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
const INTERNAL_HOSTNAME =
  /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|example|invalid|arpa|onion|ts\.net)$/;

/**
 * HTTPS on the default port to a name that could be public, with nothing hidden
 * in the address. This reads the address alone; publicFetch also checks DNS.
 */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    PUBLIC_HOSTNAME.test(url.hostname) &&
    !INTERNAL_HOSTNAME.test(url.hostname)
  );
}
