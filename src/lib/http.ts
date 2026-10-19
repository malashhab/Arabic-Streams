import { AddonError } from "./errors.js";
import { log, redactString } from "./logger.js";

export type FetchLike = typeof fetch;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  retries?: number;
  /** Label used in logs instead of the (possibly secret-bearing) URL. */
  label?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * fetch with a timeout and retry+exponential backoff for network errors and 5xx/408.
 * 429 is NOT retried blindly: it is surfaced as an AddonError carrying Retry-After.
 * Non-2xx responses throw AddonError without leaking the upstream body.
 */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = 8000, retries = 2, label = "upstream", fetchImpl = fetch, sleep = defaultSleep } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        throw new AddonError(`${label} rate limit reached`, 429, "rate_limited", Number.isFinite(ra) && ra > 0 ? ra : 30);
      }
      if (RETRYABLE.has(res.status) && attempt < retries) {
        lastErr = new AddonError(`${label} returned ${res.status}`, 502, "upstream_error");
      } else {
        throw new AddonError(`${label} returned HTTP ${res.status}`, res.status === 401 || res.status === 403 ? res.status : 502, res.status === 401 || res.status === 403 ? "unauthorized" : "upstream_error");
      }
    } catch (e) {
      if (e instanceof AddonError && e.code !== "upstream_error") throw e;
      if (e instanceof AddonError && attempt >= retries) throw e;
      lastErr = e;
      if (attempt >= retries) break;
    }
    const delay = 250 * 2 ** attempt;
    log.debug("retrying upstream request", { label, attempt: attempt + 1, delay });
    await sleep(delay);
  }
  const reason = lastErr instanceof Error ? redactString(lastErr.message) : "unknown";
  throw new AddonError(`${label} unavailable (${reason})`, 502, "upstream_unavailable");
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpRequest(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  try {
    return (await res.json()) as T;
  } catch {
    throw new AddonError(`${opts.label ?? "upstream"} returned invalid JSON`, 502, "bad_upstream_response");
  }
}
