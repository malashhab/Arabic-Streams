import request from "supertest";
import { describe, expect, it } from "vitest";
import { pickFile } from "../src/debrid/files.js";
import { parseRelease } from "../src/providers/release.js";
import { TorznabProvider, releaseMatches } from "../src/providers/torznab.js";
import { createApp } from "../src/server/app.js";
import { encryptConfig, userConfigSchema } from "../src/config/userConfig.js";
import { mockFetch, noSleep, testEnv } from "./helpers.js";

const app = (handlers: Parameters<typeof mockFetch>[0]) => {
  const f = mockFetch(handlers);
  return { f, app: createApp({ env: testEnv(), fetchImpl: f, sleep: noSleep }) };
};

describe("Arabic-style episode numbering", () => {
  const q = { type: "series" as const, titles: ["Al Hayba", "الهيبة"], season: 1, episode: 5 };
  it("parses episode-only names", () => {
    expect(parseRelease("Al Hayba E05 720p")).toMatchObject({ episode: 5 });
    expect(parseRelease("Al Hayba E05 720p").season).toBeUndefined();
    expect(parseRelease("الهيبة الحلقة 12")).toMatchObject({ episode: 12 });
    expect(parseRelease("Al Hayba S02E03")).toMatchObject({ season: 2, episode: 3 });
  });
  it("treats episode-only releases as season 1", () => {
    expect(releaseMatches("Al Hayba E05 720p", q)).toBe(true);
    expect(releaseMatches("Al Hayba E06 720p", q)).toBe(false);
    expect(releaseMatches("Al Hayba E05 720p", { ...q, season: 2 })).toBe(false);
  });
  it("picks episode-only files from a pack", () => {
    const files = [{ id: 1, name: "Al Hayba E04.mkv", size: 1 }, { id: 2, name: "Al Hayba E05.mkv", size: 1 }];
    expect(pickFile(files, { season: 1, episode: 5 })?.id).toBe(2);
    expect(pickFile(files, { season: 2, episode: 5 })).toBeUndefined();
  });
});

describe("Torznab provider", () => {
  const hash = "e".repeat(40);
  const xml = (t: string) => `<rss xmlns:torznab="x"><channel><item><title>${t}</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`;
  it("queries by IMDb id first and then by title; ambiguous year mismatches are dropped", async () => {
    const urls: string[] = [];
    const f = mockFetch([["idx.test", (u) => { urls.push(u.search); return new Response(xml("The.Mummy.1999.1080p")); }]]);
    const p = new TorznabProvider({ url: "https://idx.test/api", apiKey: "K", fetchImpl: f, sleep: noSleep });
    const out = await p.search({ type: "movie", titles: ["The Mummy"], year: 1999, imdbId: "tt0120616" });
    expect(out).toHaveLength(1);
    expect(urls[0]).toContain("t=movie");
    expect(urls[0]).toContain("imdbid=tt0120616");
    expect(urls.some((u) => u.includes("t=search"))).toBe(true);
    const wrongYear = await p.search({ type: "movie", titles: ["The Mummy"], year: 2017 });
    expect(wrongYear).toHaveLength(0);
  });
  it("throws when every request fails (so the user can be told), but not when some succeed", async () => {
    const bad = mockFetch([["idx.test", () => new Response("", { status: 401 })]]);
    await expect(new TorznabProvider({ url: "https://idx.test/api", fetchImpl: bad, sleep: noSleep }).search({ type: "movie", titles: ["X Y Z"] })).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("settings page endpoints", () => {
  it("tests a TorBox key (accepted / rejected) without echoing it", async () => {
    const ok = app([["api.torbox.app/v1/api/user/me", () => ({ success: true })]]);
    const r = await request(ok.app).post("/api/test").send({ kind: "torbox", key: "SECRETKEY" }).expect(200);
    expect(JSON.stringify(r.body)).not.toContain("SECRETKEY");
    const bad = app([["api.torbox.app", () => new Response("", { status: 401 })]]);
    const r2 = await request(bad.app).post("/api/test").send({ kind: "torbox", key: "SECRETKEY" }).expect(400);
    expect(r2.body.message).toMatch(/rejected/);
  });
  it("tests Real-Debrid and Torznab, and validates inputs", async () => {
    const a = app([["real-debrid.com/rest/1.0/user", () => ({ username: "x" })], ["idx.example.test", () => new Response("<caps><server/></caps>")]]);
    await request(a.app).post("/api/test").send({ kind: "realdebrid", key: "K" }).expect(200);
    await request(a.app).post("/api/test").send({ kind: "torznab", url: "https://1.1.1.1/api" }).expect(400); // unmocked host -> unreachable, still a clean 400
    await request(a.app).post("/api/test").send({ kind: "torbox" }).expect(400);
    await request(a.app).post("/api/test").send({ kind: "torznab", url: "http://127.0.0.1:9696/api" }).expect(400);
    await request(a.app).post("/api/test").send({ kind: "nonsense" }).expect(400);
  });
  it("rejects a Torznab URL that is not Torznab", async () => {
    const a = app([["1.1.1.1", () => new Response("<html>hello</html>")]]);
    const r = await request(a.app).post("/api/test").send({ kind: "torznab", url: "https://1.1.1.1/api" }).expect(400);
    expect(r.body.message).toMatch(/not like a Torznab/);
  });
  it("serves the logo and references it from the manifest", async () => {
    const a = app([]);
    expect((await request(a.app).get("/logo.svg").expect(200)).headers["content-type"]).toMatch(/svg/);
    expect((await request(a.app).get("/manifest.json")).body.logo).toBe("https://addon.example.test/logo.svg");
  });
});

describe("season packs vs single episodes", () => {
  const H = { ep: "1".repeat(40), packCached: "2".repeat(40), packNot: "3".repeat(40) };
  const xml = `<rss xmlns:torznab="x"><channel>
    <item><title>Bab.Al.Hara.S01E02.1080p.WEB-DL</title><size>1000000000</size><torznab:attr name="infohash" value="${H.ep}"/></item>
    <item><title>Bab.Al.Hara.S01.COMPLETE.1080p.WEB-DL</title><size>40000000000</size><torznab:attr name="infohash" value="${H.packCached}"/></item>
    <item><title>Bab.Al.Hara.S01.COMPLETE.720p.WEB-DL</title><size>20000000000</size><torznab:attr name="infohash" value="${H.packNot}"/></item></channel></rss>`;
  const build = (cfg: object) => {
    const env = testEnv({ TORZNAB_URL: "https://torznab.test/api" });
    const f = mockFetch([
      ["torbox.app/v1/api/torrents/checkcached", () => ({ success: true, data: { [H.packCached]: { files: [{ name: "Bab.Al.Hara.S01E02.mkv", size: 900000000 }] } } })],
      ["torznab.test", () => new Response(xml)],
      ["archive.org", () => ({ response: { docs: [] } })],
      ["/genre/", () => ({ genres: [] })],
      [/\/tv\/10\?.*language=en/, () => ({ id: 10, name: "Bab Al Hara", original_name: "باب الحارة", original_language: "ar", first_air_date: "2024-03-11" })],
      [/\/tv\/10\?/, () => ({ id: 10, name: "باب الحارة", original_name: "باب الحارة", original_language: "ar", first_air_date: "2024-03-11", external_ids: {} })],
    ]);
    const app = createApp({ env, fetchImpl: f, sleep: noSleep });
    return { app, tok: encryptConfig(userConfigSchema.parse({ debrid: "torbox", debridKey: "K", ...cfg }), env.CONFIG_SECRET) };
  };

  it("lists the episode first, shows a cached pack (marked), and hides an uncached pack by default", async () => {
    const { app, tok } = build({});
    const res = await request(app).get(`/${tok}/stream/series/tmdb:tv:10:1:2.json`).expect(200);
    const s = res.body.streams;
    expect(s).toHaveLength(2);
    expect(s[0].description).toContain("📚 Season pack"); // cached pack outranks everything uncached
    expect(s[0].description).toContain("⚡ Cached (TB)");
    expect(s[0].description).toContain("📦 858 MB / 37.25 GB"); // this episode's file / the whole pack
    expect(s[0].url).not.toContain("?t="); // cached: no tracker download needed
    expect(s[1].description).not.toContain("Season pack"); // the single episode
    expect(s.some((x: { description: string }) => x.description.includes("720p"))).toBe(false); // uncached pack hidden
  });

  it("shows uncached packs, last, when the user turns hiding off", async () => {
    const { app, tok } = build({ hidePacks: false });
    const res = await request(app).get(`/${tok}/stream/series/tmdb:tv:10:1:2.json`).expect(200);
    expect(res.body.streams).toHaveLength(3);
    expect(res.body.streams[2].description).toContain("Season pack");
    expect(res.body.streams[2].description).toContain("Not cached");
  });
});

describe("search speed", () => {
  const hash = "9".repeat(40);
  const xml = `<rss xmlns:torznab="x"><channel><item><title>Bab.Al.Hara.S01E02.1080p</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`;
  const q = { type: "series" as const, titles: ["Bab Al Hara", "باب الحارة"], season: 1, episode: 2, imdbId: "tt1234567" };

  it("asks as few questions as possible: one title query (+ IMDb lookup) when the episode is found", async () => {
    const f = mockFetch([["idx.test", () => new Response(xml)]]);
    await new TorznabProvider({ url: "https://idx.test/api", fetchImpl: f, sleep: noSleep }).search(q);
    const qs = f.calls.map((c) => new URL(c.url).searchParams);
    expect(qs).toHaveLength(2);
    expect(qs.some((p) => p.get("imdbid") === "tt1234567")).toBe(true);
    expect(qs.some((p) => p.get("q") === "باب الحارة")).toBe(true); // the Arabic title, bare
  });

  it("asks for the episode itself only when the first answer lacks it", async () => {
    const packOnly = `<rss xmlns:torznab="x"><channel><item><title>Bab.Al.Hara.S01.COMPLETE.1080p</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`;
    const f = mockFetch([["idx.test", () => new Response(packOnly)]]);
    await new TorznabProvider({ url: "https://idx.test/api", fetchImpl: f, sleep: noSleep }).search(q);
    const texts = f.calls.map((c) => new URL(c.url).searchParams.get("q")).filter(Boolean);
    expect(texts).toEqual(["باب الحارة", "باب الحارة S01E02"]);
  });

  it("falls back to the other-language title when nothing matched", async () => {
    const f = mockFetch([["idx.test", () => new Response("<rss><channel></channel></rss>")]]);
    await new TorznabProvider({ url: "https://idx.test/api", fetchImpl: f, sleep: noSleep }).search({ type: "movie", titles: ["Al Sharissa", "الشرسة"], year: 1993 });
    const texts = f.calls.map((c) => new URL(c.url).searchParams.get("q")).filter(Boolean);
    expect(texts).toEqual(["الشرسة", "Al Sharissa 1993"]);
  });

  it("answers a repeated search from memory without asking the indexer again, and never keys the cache on the API key text", async () => {
    const f = mockFetch([["idx.test", () => new Response(xml)]]);
    const p = new TorznabProvider({ url: "https://idx.test/api", apiKey: "SECRETKEY", fetchImpl: f, sleep: noSleep });
    await p.search(q);
    const first = f.calls.length;
    const again = await p.search(q);
    expect(f.calls.length).toBe(first);
    expect(again).toHaveLength(1);
    // a different user (different key) does not get someone else's cached answer
    await new TorznabProvider({ url: "https://idx.test/api", apiKey: "OTHERKEY", fetchImpl: f, sleep: noSleep }).search(q);
    expect(f.calls.length).toBeGreaterThan(first);
  });
});
