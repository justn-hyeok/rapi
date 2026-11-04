import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // Carrier NAT, and Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // Cloud metadata lives here
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // Multicast and everything above it
] as const)
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can wrap a private IPv4 address
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");

// BlockList also checks an IPv4-mapped IPv6 address against the IPv4 rules.
function isPrivateAddress(address: string): boolean {
  const bare = address.split("%")[0]!;
  const version = isIP(bare);
  // Not an address we can reason about, so not one we connect to.
  if (!version) return true;
  return PRIVATE_ADDRESSES.check(bare, version === 6 ? "ipv6" : "ipv4");
}

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

export type ResolveHostname = (hostname: string) => Promise<string[]>;

const resolveHostname: ResolveHostname = async (hostname) =>
  (await lookup(hostname, { all: true })).map(({ address }) => address);

const MAX_REDIRECTS = 3;

async function refuseUnlessPublic(
  url: string,
  resolve: ResolveHostname,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!isPublicUrl(url)) throw new Error("Refused a non-public address");
  const resolved = resolve(new URL(url).hostname);
  // fetch only honours the signal once it starts, and a DNS lookup cannot be cancelled.
  const addresses = await (signal
    ? Promise.race([
        resolved,
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("DNS lookup timed out")),
          ),
        ),
      ])
    : resolved);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new Error("Refused a non-public address");
}

/**
 * For addresses taken from strangers' files: every hop, redirects included, must
 * be public, and the name must not resolve to a private address. The lookup and
 * the connection are separate, so a name could still change in between, but it
 * would then need a valid certificate for that name on the private address.
 */
export function publicFetch(
  base: typeof fetch = fetch,
  resolve: ResolveHostname = resolveHostname,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    let url = String(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await refuseUnlessPublic(url, resolve, init?.signal);
      const response = await base(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location)
        return response;
      await response.body?.cancel();
      url = new URL(location, url).href;
    }
    throw new Error("Too many redirects");
  }) as typeof fetch;
}
