import type { Env } from "../src/config/env.js";
import type { FetchLike } from "../src/lib/http.js";

export type Handler = (url: URL, init?: RequestInit) => unknown | Response | undefined;

/** Fake fetch: first matching handler wins. Unmatched calls fail loudly so tests never hit the network. */
export function mockFetch(handlers: Array<[RegExp | string, Handler]>): FetchLike & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [pat, h] of handlers) {
      if (typeof pat === "string" ? url.includes(pat) : pat.test(url)) {
        const r = h(new URL(url), init);
        if (r instanceof Response) return r;
        return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    throw new Error("unmocked fetch: " + url);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};

export const testEnv = (over: Partial<Env> = {}): Env => ({
  PORT: 0,
  NODE_ENV: "test",
  CONFIG_SECRET: "test-secret-test-secret-1234",
  TMDB_READ_TOKEN: "tmdb-test-token",
  LOG_LEVEL: "error",
  RATE_LIMIT_PER_MINUTE: 1000,
  TRUST_PROXY: 0,
  ALLOW_PRIVATE_INDEXERS: false,
  TORRENTIO_URL: "https://torrentio.test",
  COMET_URL: "https://comet.test",
  SECRET_FILE: "data/.secret",
  BASE_URL: "https://addon.example.test",
  ...over,
});

export const tmdbMovie = (id: number, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, original_title: title, original_language: "ar", poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
  release_date: "2024-05-01", overview: "وصف", genre_ids: [18], ...extra,
});
export const tmdbShow = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, original_name: name, original_language: "ar", origin_country: ["SA"], poster_path: `/p${id}.jpg`,
  first_air_date: "2024-03-11", overview: "وصف", genre_ids: [18], ...extra,
});
