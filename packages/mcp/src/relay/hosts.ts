/**
 * Which addresses the daemon may listen on.
 *
 * The relay is plaintext: the pairing signature proves who the daemon is at the handshake, but no session key is derived, so nothing stops a network attacker tampering with CDP frames afterwards. The daemon therefore binds only addresses that are already private — loopback, a LAN, or a WireGuard/Tailscale interface — and refuses anything routable from the internet. Giving it a TLS certificate is what would lift that.
 */

const LOOPBACK = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);

/** `127.0.0.1`, `localhost` or `::1`: whoever reaches it is already the user */
export function isLoopbackHost(host: string | undefined): boolean {
  return !host || LOOPBACK.has(normalize(host));
}

/**
 * Whether the daemon may bind this address without TLS: loopback, "all interfaces" (which is as private as the interfaces themselves, so it's refused), RFC1918, CGNAT (`100.64/10`, which Tailscale uses), link-local, and IPv6 unique-local
 */
export function isPrivateHost(host: string): boolean {
  const value = normalize(host);
  if (isLoopbackHost(value)) {
    return true;
  }
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    // Carrier-grade NAT, which Tailscale hands out
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    return false;
  }
  if (value.includes(":")) {
    // Unique-local (fc00::/7) and link-local (fe80::/10)
    return /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
  }
  // A name: only `localhost` is known to be private
  return false;
}

/** The message for a `--host` the daemon won't bind */
export function publicHostMessage(host: string): string {
  return `Browser MCP won't listen on ${host}: it speaks plaintext, so it only binds private addresses (loopback, 10.x, 172.16–31.x, 192.168.x, 100.64–127.x, link-local or IPv6 unique-local). Bind the address of a private network, such as a WireGuard or Tailscale interface.`;
}

function normalize(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}
