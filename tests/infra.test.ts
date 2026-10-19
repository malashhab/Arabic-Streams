import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/lib/cache.js";
import { httpRequest } from "../src/lib/http.js";
import { configureLogger, log, redact, redactString } from "../src/lib/logger.js";
import { isPrivateAddress } from "../src/lib/ssrf.js";
import { DEFAULT_USER_CONFIG, decryptConfig, encryptConfig, userConfigSchema } from "../src/config/userConfig.js";
import { loadEnv } from "../src/config/env.js";
import { pickFile } from "../src/debrid/files.js";
import { parseRelease } from "../src/providers/release.js";
import { cleanReleaseTitle, parseTorznab, releaseMatches } from "../src/providers/torznab.js";

describe("http retries / timeouts", () => {
  it("retries 5xx with backoff then succeeds", async () => {
    let n = 0;
    const delays: number[] = [];
    const f = (async () => (++n < 3 ? new Response("x", { status: 503 }) : new Response("ok"))) as typeof fetch;
    const r = await httpRequest("https://x.test", { fetchImpl: f, sleep: async (ms) => void delays.push(ms) });
    expect(await r.text()).toBe("ok");
    expect(delays).toEqual([250, 500]);
  });
  it("gives up after the retry budget with a safe error", async () => {
    const f = (async () => new Response("secret body", { status: 500 })) as typeof fetch;
    await expect(httpRequest("https://x.test", { fetchImpl: f, sleep: async () => {}, retries: 1 })).rejects.toMatchObject({ status: 502 });
  });
  it("does not retry 4xx; surfaces 401 and 429 distinctly", async () => {
    let n = 0;
    const f401 = (async () => (n++, new Response("", { status: 401 }))) as typeof fetch;
    await expect(httpRequest("https://x.test", { fetchImpl: f401, sleep: async () => {} })).rejects.toMatchObject({ code: "unauthorized" });
    expect(n).toBe(1);
    const f429 = (async () => new Response("", { status: 429, headers: { "retry-after": "9" } })) as typeof fetch;
    await expect(httpRequest("https://x.test", { fetchImpl: f429, sleep: async () => {} })).rejects.toMatchObject({ code: "rate_limited", retryAfterSec: 9 });
  });
  it("retries network errors", async () => {
    let n = 0;
    const f = (async () => {
      if (++n < 2) throw new TypeError("fetch failed");
      return new Response("fine");
    }) as typeof fetch;
    expect(await (await httpRequest("https://x.test", { fetchImpl: f, sleep: async () => {} })).text()).toBe("fine");
  });
});

describe("logging redaction", () => {
  it("redacts secrets in URLs, bearer tokens, config tokens and sensitive keys", () => {
    expect(redactString("https://a.test/x?apikey=SECRET&q=1")).toBe("https://a.test/x?apikey=***&q=1");
    expect(redactString("Authorization: Bearer abc.DEF-123")).toContain("Bearer ***");
    expect(redactString("/c_abcdefghijklmnopqrstuvwxyz0123/manifest.json")).toBe("/c_***/manifest.json");
    expect(redact({ debridKey: "x", nested: { token: "y", ok: "fine" } })).toEqual({ debridKey: "***", nested: { token: "***", ok: "fine" } });
  });
  it("never writes secrets to the sink", () => {
    const lines: string[] = [];
    configureLogger("info", (l) => lines.push(l));
    log.error("failed", { error: new Error("GET https://t.test/?token=TOPSECRET failed"), apiKey: "TOPSECRET" });
    configureLogger("error", (l) => process.stdout.write(l + "\n"));
    expect(lines.join("")).not.toContain("TOPSECRET");
  });
});

describe("user config encryption", () => {
  const secret = "unit-test-secret-1234567890";
  it("round-trips and does not expose the key", () => {
    const cfg = userConfigSchema.parse({ debrid: "torbox", debridKey: "PLAINKEY" });
    const tok = encryptConfig(cfg, secret);
    expect(tok).not.toContain("PLAINKEY");
    expect(decryptConfig(tok, secret)).toEqual(cfg);
  });
  it("rejects tampering, wrong secret and garbage", () => {
    const tok = encryptConfig(DEFAULT_USER_CONFIG, secret);
    expect(decryptConfig(tok, "another-secret-another-secret")).toBeNull();
    expect(decryptConfig(tok.slice(0, -2) + "xx", secret)).toBeNull();
    expect(decryptConfig("c_short", secret)).toBeNull();
    expect(decryptConfig(undefined, secret)).toBeNull();
  });
  it("uses a fresh IV every time", () => expect(encryptConfig(DEFAULT_USER_CONFIG, secret)).not.toBe(encryptConfig(DEFAULT_USER_CONFIG, secret)));
});

describe("env validation", () => {
  it("rejects bad values and short secrets", () => {
    expect(() => loadEnv({ PORT: "abc", CONFIG_SECRET: "x".repeat(20) })).toThrow(/PORT/);
    expect(() => loadEnv({ CONFIG_SECRET: "short" })).toThrow(/at least 16/);
    expect(() => loadEnv({ CONFIG_SECRET: "x".repeat(20), RAMADAN_2026_START: "soon" })).toThrow(/RAMADAN_2026_START/);
  });
  it("treats empty strings as unset", () => {
    const e = loadEnv({ CONFIG_SECRET: "x".repeat(20), TMDB_READ_TOKEN: "", BASE_URL: "", TORZNAB_URL: "" });
    expect(e.TMDB_READ_TOKEN).toBeUndefined();
    expect(e.BASE_URL).toBeUndefined();
    expect(e.PORT).toBe(7100);
  });
});

describe("misc", () => {
  it("TtlCache expires and coalesces concurrent loads", async () => {
    let t = 0;
    const c = new TtlCache<number>(10, () => t);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([c.wrap("k", 100, load), c.wrap("k", 100, load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    t = 101;
    expect(await c.wrap("k", 100, load)).toBe(2);
  });
  it("flags private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("release parsing and matching", () => {
  it("reads quality only when the name states it", () => {
    expect(parseRelease("Show.S01E02.1080p.WEB-DL.x265.HDR")).toMatchObject({ resolution: "1080p", source: "WEB-DL", codec: "HEVC", hdr: true, season: 1, episode: 2 });
    expect(parseRelease("Some Movie 2020 UHD BluRay").resolution).toBe("2160p");
    expect(parseRelease("Some Movie 2020").resolution).toBeUndefined();
    expect(parseRelease("Show S02 Complete 720p")).toMatchObject({ season: 2, pack: true });
  });
  it("cleans titles and matches by title/year/episode", () => {
    expect(cleanReleaseTitle("Bab.Al.Hara.S01E02.1080p")).toBe("Bab Al Hara");
    const q = { type: "series" as const, titles: ["باب الحارة", "Bab Al Hara"], season: 1, episode: 2 };
    expect(releaseMatches("Bab.Al.Hara.S01E02.1080p", q)).toBe(true);
    expect(releaseMatches("Bab.Al.Hara.S01E03.1080p", q)).toBe(false);
    expect(releaseMatches("Bab Al Hara S01 Complete", q)).toBe(true);
    expect(releaseMatches("Another.Show.S01E02", q)).toBe(false);
    const m = { type: "movie" as const, titles: ["The Mummy"], year: 1999 };
    expect(releaseMatches("The.Mummy.1999.1080p", m)).toBe(true);
    expect(releaseMatches("The.Mummy.2017.1080p", m)).toBe(false);
  });
  it("parses torznab, skipping items without an info hash", () => {
    const xml = `<rss xmlns:torznab="x"><channel><item><title>A</title><link>https://x/a.torrent</link></item><item><title>B</title><link>magnet:?xt=urn:btih:${"d".repeat(40)}&amp;dn=B</link></item></channel></rss>`;
    // A has only a .torrent link (private tracker): kept with its link so the hash can be read from the file. B has a magnet.
    expect(parseTorznab(xml)).toEqual([expect.objectContaining({ title: "A", torrentUrl: "https://x/a.torrent" }), expect.objectContaining({ title: "B", infoHash: "d".repeat(40) })]);
    expect(parseTorznab(`<rss><channel><item><title>C</title></item></channel></rss>`)).toEqual([]); // nothing to resolve
  });
  it("picks the right file in a pack and refuses to guess an episode", () => {
    const files = [
      { id: 1, name: "S01E01.mkv", size: 5 },
      { id: 2, name: "S01E02.mkv", size: 5 },
      { id: 3, name: "readme.txt", size: 99 },
    ];
    expect(pickFile(files, { season: 1, episode: 2 })?.id).toBe(2);
    expect(pickFile(files, { season: 1, episode: 9 })).toBeUndefined();
    expect(pickFile(files, {})?.id).toBe(1);
  });
});
