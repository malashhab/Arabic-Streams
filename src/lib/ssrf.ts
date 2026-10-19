import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AddonError } from "./errors.js";

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]!) : false;
}

/**
 * Users may supply their own indexer URL, which the server then fetches. To stop a public instance being used to
 * probe its internal network, such URLs must be http(s) and must not point at private/loopback addresses
 * unless the operator opts in with ALLOW_PRIVATE_INDEXERS=true. (DNS rebinding is not fully covered; see README.)
 */
export async function assertSafeUserUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddonError("Invalid URL", 400, "bad_request");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AddonError("Only http(s) URLs are allowed", 400, "bad_request");
  if (url.username || url.password) throw new AddonError("URLs with embedded credentials are not allowed", 400, "bad_request");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new AddonError("Private addresses are not allowed", 400, "bad_request");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new AddonError("Host could not be resolved", 400, "bad_request");
  if (addrs.some(isPrivateAddress)) throw new AddonError("Private addresses are not allowed", 400, "bad_request");
  return url;
}
