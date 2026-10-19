import request from "supertest";
import { describe, expect, it } from "vitest";
import { encryptConfig, userConfigSchema } from "../src/config/userConfig.js";
import { manifestSchema } from "../src/protocol/manifest.js";
import { catalogResponseSchema, metaResponseSchema, streamResponseSchema } from "../src/protocol/responses.js";
import { createApp } from "../src/server/app.js";
import { mockFetch, noSleep, testEnv, tmdbMovie, tmdbShow, type Handler } from "./helpers.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const torznabXml = `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
<item><title>Bab.Al.Hara.S01E02.1080p.WEB-DL.x264</title><size>1500000000</size>
<torznab:attr name="infohash" value="${HASH_A}"/><torznab:attr name="seeders" value="12"/></item>
<item><title>Bab Al Hara S01E02 720p HDTV</title><size>2147483648</size><torznab:attr name="infohash" value="${HASH_B}"/><torznab:attr name="seeders" value="3"/></item>
<item><title>Some.Other.Show.S01E02.1080p</title><torznab:attr name="infohash" value="${HASH_C}"/></item>
</channel></rss>`;
const SECRET_TB = "TB-SECRET-KEY-123";
const SECRET_RD = "RD-SECRET-KEY-456";

type Routes = Array<[RegExp | string, Handler]>;

function build(extra: Routes = [], envOver = {}) {
  const f = mockFetch([
    ...extra,
    ["/genre/", () => ({ genres: [{ id: 18, name: "دراما" }] })],
    ["/discover/movie", () => ({ results: [tmdbMovie(1, "فيلم")], page: 1, total_pages: 1 })],
    ["/search/tv", () => ({ results: [tmdbShow(10, "باب الحارة")], page: 1, total_pages: 1 })],
    [/\/tv\/10\/season\/1/, () => ({ episodes: [{ episode_number: 1, name: "الحلقة 1", air_date: "2024-03-11" }, { episode_number: 2, name: "x", air_date: null }] })],
    [/\/tv\/10\?.*language=en/, () => ({ ...tmdbShow(10, "Bab Al Hara"), overview: "english overview" })],
    [/\/tv\/10\?/, () => ({ ...tmdbShow(10, "باب الحارة", { overview: "" }), genres: [{ id: 18, name: "دراما" }], seasons: [{ season_number: 0, episode_count: 1 }, { season_number: 1, episode_count: 2 }], external_ids: { imdb_id: "tt1234567" } })],
    ["/find/tt1234567", () => ({ tv_results: [{ id: 10 }], movie_results: [] })],
    ["archive.org", () => ({ response: { docs: [] } })],
    ["torznab.test", () => new Response(torznabXml, { status: 200 })],
  ]);
  const env = testEnv({ TORZNAB_URL: "https://torznab.test/api", TORZNAB_API_KEY: "TZ-KEY", ...envOver });
  return { f, env, app: createApp({ env, fetchImpl: f, sleep: noSleep, now: () => new Date("2026-10-19T00:00:00Z") }) };
}
const tokenFor = (env: ReturnType<typeof testEnv>, cfg: object) => encryptConfig(userConfigSchema.parse(cfg), env.CONFIG_SECRET);
const STREAM = "stream/series/tmdb:tv:10:1:2.json";

describe("manifest", () => {
  it("is schema-valid and exposes the documented catalogs", async () => {
    const { app } = build();
    const res = await request(app).get("/manifest.json").expect(200);
    const m = manifestSchema.parse(res.body);
    expect(m.catalogs.map((c) => c.id)).toEqual(expect.arrayContaining(["ar_movies_latest", "ar_series_ramadan", "ar_series_gulf", "ar_search_series"]));
    expect(m.catalogs.find((c) => c.id === "ar_series_ramadan")!.extra![0]!.options![0]).toBe("2026");
    expect(m.catalogs.find((c) => c.id === "ar_search_movie")!.extra).toEqual([{ name: "search", isRequired: true }]);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("only lists the catalogs a user enabled, and rejects tampered tokens", async () => {
    const { app, env } = build();
    const tok = tokenFor(env, { catalogs: ["ar_movies_latest"] });
    const res = await request(app).get(`/${tok}/manifest.json`).expect(200);
    expect(res.body.catalogs.map((c: { id: string }) => c.id)).toEqual(["ar_movies_latest"]);
    await request(app).get(`/${tok.slice(0, -4)}AAAA/manifest.json`).expect(400);
  });
});

describe("catalog / meta", () => {
  it("serves a valid catalog and caches publicly", async () => {
    const { app } = build();
    const res = await request(app).get("/catalog/movie/ar_movies_latest.json").expect(200);
    expect(catalogResponseSchema.parse(res.body).metas[0]!.name).toBe("فيلم");
    expect(res.headers["cache-control"]).toMatch(/public/);
  });

  it("handles Arabic search in the extra path", async () => {
    const { app } = build();
    const res = await request(app).get(`/catalog/series/ar_search_series/search=${encodeURIComponent("باب الحارة")}.json`).expect(200);
    expect(res.body.metas[0].id).toBe("tmdb:tv:10");
    await request(app).get("/catalog/series/ar_search_series.json").expect(400);
  });

  it("404s on unknown catalogs", async () => {
    const { app } = build();
    await request(app).get("/catalog/movie/nope.json").expect(404);
  });

  it("returns series meta with real IDs only, dated episodes, and an English description fallback", async () => {
    const { app } = build();
    const res = await request(app).get("/meta/series/tmdb:tv:10.json").expect(200);
    const { meta } = metaResponseSchema.parse(res.body);
    expect((meta as { imdb_id?: string }).imdb_id).toBe("tt1234567");
    expect(meta.description).toBe("english overview");
    // season 0 and the undated episode are skipped
    expect((meta as { videos: unknown[] }).videos).toEqual([expect.objectContaining({ id: "tmdb:tv:10:1:1", season: 1, episode: 1 })]);
    // Asked by IMDb id (what catalogs now return): answer with the same id and IMDb-style episode ids
    const byImdb = await request(app).get("/meta/series/tt1234567.json").expect(200);
    expect(byImdb.body.meta.id).toBe("tt1234567");
    expect(byImdb.body.meta.videos[0].id).toBe("tt1234567:1:1");
  });

  it("stays out of the way for non-Arabic IMDb titles so the default meta addon is used", async () => {
    const { app } = build([
      ["/find/tt7654321", () => ({ tv_results: [{ id: 99 }], movie_results: [] })],
      [/\/tv\/99\?/, () => ({ ...tmdbShow(99, "Other", { original_language: "en", origin_country: ["US"] }), seasons: [] })],
    ]);
    await request(app).get("/meta/series/tt7654321.json").expect(404);
  });

  it("catalogs return IMDb ids where TMDB has one, tmdb: ids otherwise", async () => {
    const { app } = build([
      ["/movie/1/external_ids", () => ({ imdb_id: "tt7777777" })],
      ["/discover/movie", () => ({ results: [tmdbMovie(1, "فيلم"), tmdbMovie(2, "آخر")], page: 1, total_pages: 1 })],
      ["/movie/2/external_ids", () => ({ imdb_id: null })],
    ]);
    const res = await request(app).get("/catalog/movie/ar_movies_latest.json").expect(200);
    expect(res.body.metas.map((m: { id: string }) => m.id)).toEqual(["tt7777777", "tmdb:movie:2"]);
  });

  it("maps TMDB failures to a safe 502 without leaking details", async () => {
    const { app } = build([["/discover/movie", () => new Response("secret upstream body", { status: 500 })]]);
    const res = await request(app).get("/catalog/movie/ar_movies_latest.json").expect(502);
    expect(JSON.stringify(res.body)).not.toContain("secret upstream body");
  });

  it("reports a missing TMDB token clearly", async () => {
    const { app } = build([], { TMDB_READ_TOKEN: undefined });
    const res = await request(app).get("/catalog/movie/ar_movies_latest.json").expect(503);
    expect(res.body.error).toBe("tmdb_not_configured");
  });
});

describe("streams", () => {
  const torbox = (cachedHashes: string[]): [string, Handler] => ["torbox.app/v1/api/torrents/checkcached", () => ({ success: true, data: Object.fromEntries(cachedHashes.map((h) => [h, { name: "x", files: [{ name: "Bab.Al.Hara.S01E02.mkv", size: 1073741824 }] }])) })];

  it("TorBox: marks only provider-confirmed hashes as cached, ranks them first, never embeds the API key", async () => {
    const { app, env } = build([torbox([HASH_B])]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB });
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    const { streams } = streamResponseSchema.parse(res.body);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.name).toContain("⚡ TB");
    expect(streams[0]!.description).toContain("⚡ Cached (TB)");
    expect(streams[0]!.description).toContain("📦 1.00 GB / 2.00 GB"); // episode file / whole release
    expect(streams[0]!.description).toContain("📡 Index");
    expect(streams[0]!.url).toBe(`https://addon.example.test/${tok}/resolve/${HASH_B}/1/2`);
    expect(streams[1]!.description).toContain("⏳ Not cached (TB)");
    expect(streams[1]!.name).toContain("1080p"); // quality comes only from the release name
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TB);
    expect(JSON.stringify(res.body)).not.toContain("TZ-KEY");
  });



  it("Torrentio / Comet: asked by IMDb id only, wrong episodes and hash-less rows dropped, shared hashes merged", async () => {
    const HASH_D = "d".repeat(40);
    const { app, env, f } = build(
      [
        torbox([HASH_D]),
        ["torrentio.test", () => ({ streams: [
          { name: "Torrentio\n1080p", title: "Bab.Al.Hara.S01E02.1080p.WEB-DL.x264\n👤 12 💾 1.5 GB ⚙️ EZTV", infoHash: HASH_D },
          { name: "Torrentio", title: "Bab Al Hara S01E09 720p\n👤 3 💾 1 GB ⚙️ TPB", infoHash: HASH_B }, // wrong episode
          { name: "Torrentio", title: "Bab Al Hara S01E02 720p\n👤 3 💾 1 GB ⚙️ TPB" }, // no hash
        ] })],
        ["comet.test", () => ({ streams: [
          { name: "[TORRENT] Comet", description: "📄 Bab.Al.Hara.S01E02.1080p.WEB-DL.x264\n⭐ WEB-DL\n👤 4 💾 1.5 GB 🔎 Comet|Knaben", infoHash: HASH_D, behaviorHints: { filename: "Bab.Al.Hara.S01E02.1080p.WEB-DL.x264.mkv" } },
          { name: "[⛔️] Comet", description: "Use a debrid provider", url: "https://comet.test/playback/x" },
        ] })],
      ],
      { TORZNAB_URL: undefined, TORZNAB_API_KEY: undefined },
    );
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB, torrentio: true, comet: true });
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    const { streams } = streamResponseSchema.parse(res.body);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.name).toContain("⚡ TB");
    expect(streams[0]!.url).toBe(`https://addon.example.test/${tok}/resolve/${HASH_D}/1/2`);
    expect(f.calls.map((c) => c.url)).toEqual(expect.arrayContaining(["https://torrentio.test/stream/series/tt1234567:1:2.json", "https://comet.test/stream/series/tt1234567:1:2.json"]));
    // off by default: no calls to either addon
    const off = build([], { TORZNAB_URL: undefined });
    await request(off.app).get(`/${tokenFor(off.env, { debrid: "torbox", debridKey: SECRET_TB })}/${STREAM}`).expect(200);
    expect(off.f.calls.some((c) => /torrentio|comet/.test(c.url))).toBe(false);
  });

  it("showUncached=false hides unconfirmed TorBox releases", async () => {
    const { app, env } = build([torbox([HASH_B])]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB, showUncached: false });
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    expect(res.body.streams).toHaveLength(1);
  });

  it("Real-Debrid: never claims cached (no reliable API) and adds nothing to the account when listing", async () => {
    const { app, env, f } = build();
    const tok = tokenFor(env, { debrid: "realdebrid", debridKey: SECRET_RD });
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    expect(res.body.streams).toHaveLength(2);
    for (const s of res.body.streams) {
      expect(s.description).toContain("Cache unknown (RD)");
      expect(s.name).not.toContain("⚡");
    }
    expect(f.calls.some((c) => c.url.includes("real-debrid"))).toBe(false);
  });

  it("works with an IMDb id", async () => {
    const { app, env } = build([torbox([])]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB });
    const res = await request(app).get(`/${tok}/stream/series/tt1234567:1:2.json`).expect(200);
    expect(res.body.streams.length).toBe(2);
  });

  it("missing credentials: explains instead of returning fake streams", async () => {
    const { app, env } = build();
    const tok = tokenFor(env, {});
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    expect(res.body.streams).toHaveLength(1);
    expect(res.body.streams[0].url).toBeUndefined();
    expect(res.body.streams[0].description).toMatch(/TorBox or Real-Debrid/);
  });

  it("no token at all: no resolve links", async () => {
    const { app } = build();
    const res = await request(app).get(`/${STREAM}`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain("/resolve/");
  });

  it("invalid key and provider rate limits become explanatory notices", async () => {
    const a = build([["torbox.app/v1/api/torrents/checkcached", () => new Response("no", { status: 401 })]]);
    const r1 = await request(a.app).get(`/${tokenFor(a.env, { debrid: "torbox", debridKey: SECRET_TB })}/${STREAM}`).expect(200);
    expect(r1.body.streams).toHaveLength(1);
    expect(r1.body.streams[0].description).toMatch(/rejected/);

    const b = build([["torbox.app/v1/api/torrents/checkcached", () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } })]]);
    const r2 = await request(b.app).get(`/${tokenFor(b.env, { debrid: "torbox", debridKey: SECRET_TB })}/${STREAM}`).expect(200);
    expect(r2.body.streams[0].description).toMatch(/Rate limited/);
  });

  it("empty results give an empty stream list", async () => {
    const { app, env } = build([["torznab.test", () => new Response("<rss><channel></channel></rss>")]]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB });
    const res = await request(app).get(`/${tok}/${STREAM}`).expect(200);
    expect(res.body.streams).toEqual([]);
  });

  it("offers Internet Archive files as direct streams without any debrid", async () => {
    const { app, env } = build([
      ["advancedsearch.php", () => ({ response: { docs: [{ identifier: "arabic-film-1", title: "فيلم", year: "2024" }] } })],
      ["archive.org/metadata/arabic-film-1", () => ({ files: [{ name: "film.mp4", format: "MPEG4", size: "1000" }] })],
      ["/movie/5?", () => ({ ...tmdbMovie(5, "فيلم"), external_ids: {} })],
    ]);
    const tok = tokenFor(env, {});
    const res = await request(app).get(`/${tok}/stream/movie/tmdb:movie:5.json`).expect(200);
    expect(res.body.streams[0]).toMatchObject({ url: "https://archive.org/download/arabic-film-1/film.mp4", name: "Internet Archive" });
  });

  it("rejects private-network user indexers (SSRF) on stream requests", async () => {
    const { app, env } = build();
    const tok = tokenFor(env, { torznabUrl: "http://127.0.0.1:9696/api" });
    await request(app).get(`/${tok}/${STREAM}`).expect(400);
  });
});

describe("credential isolation", () => {
  it("two users get separate links; one user's key is never used for the other", async () => {
    const seenAuth: string[] = [];
    const { app, env } = build([
      [
        "torbox.app/v1/api/torrents/checkcached",
        (_u, init) => {
          seenAuth.push(String((init?.headers as Record<string, string>).authorization));
          return { success: true, data: {} };
        },
      ],
    ]);
    const t1 = tokenFor(env, { debrid: "torbox", debridKey: "KEY-USER-ONE" });
    const t2 = tokenFor(env, { debrid: "torbox", debridKey: "KEY-USER-TWO" });
    const r1 = await request(app).get(`/${t1}/${STREAM}`);
    const r2 = await request(app).get(`/${t2}/${STREAM}`);
    expect(seenAuth).toEqual(["Bearer KEY-USER-ONE", "Bearer KEY-USER-TWO"]);
    expect(r1.body.streams[0].url).toContain(t1);
    expect(r2.body.streams[0].url).toContain(t2);
    expect(JSON.stringify([r1.body, r2.body])).not.toMatch(/KEY-USER/);
  });
});

describe("resolve + config endpoints", () => {
  it("TorBox cached release: 302 to the user's link with no-store", async () => {
    const { app, env } = build([
      ["torrents/createtorrent", () => ({ success: true, data: { torrent_id: 7 } })],
      ["torrents/mylist", () => ({ success: true, data: { id: 7, download_finished: true, files: [{ id: 1, name: "Bab.Al.Hara.S01E02.mkv", size: 5 }, { id: 2, name: "Bab.Al.Hara.S01E03.mkv", size: 9 }] } })],
      ["torrents/requestdl", (u) => ({ success: true, data: `https://cdn.torbox.test/file${u.searchParams.get("file_id")}` })],
    ]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB });
    const res = await request(app).get(`/${tok}/resolve/${HASH_A}/1/2`).expect(302);
    expect(res.headers.location).toBe("https://cdn.torbox.test/file1");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("uncached TorBox release: 503 with Retry-After and an honest message", async () => {
    const { app, env } = build([
      ["torrents/createtorrent", () => ({ success: true, data: { torrent_id: 7 } })],
      ["torrents/mylist", () => ({ success: true, data: { id: 7, download_finished: false, progress: 0.25 } })],
    ]);
    const tok = tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB });
    const res = await request(app).get(`/${tok}/resolve/${HASH_A}`).expect(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.text).toMatch(/Not cached/);
    expect(res.text).toMatch(/25%/);
  });

  it("Real-Debrid: adds the magnet, selects the right file, unrestricts it", async () => {
    let selected = "";
    const { app, env } = build([
      ["/torrents?limit", () => []],
      ["torrents/addMagnet", () => ({ id: "RDID" })],
      ["torrents/selectFiles/RDID", (_u, init) => {
        selected = String(init?.body);
        return new Response(null, { status: 204 });
      }],
      ["torrents/info/RDID", () => ({ id: "RDID", status: "downloaded", files: [{ id: 3, path: "/ep2.S01E02.mkv", bytes: 9, selected: 1 }], links: ["https://rd.test/l/1"] })],
      ["unrestrict/link", () => ({ download: "https://dl.rd.test/ep2.mkv" })],
    ]);
    const tok = tokenFor(env, { debrid: "realdebrid", debridKey: SECRET_RD });
    const res = await request(app).get(`/${tok}/resolve/${HASH_A}/1/2`).expect(302);
    expect(res.headers.location).toBe("https://dl.rd.test/ep2.mkv");
    expect(selected).toBe("");
  });

  it("validates hash, token and credentials", async () => {
    const { app, env } = build();
    await request(app).get(`/${tokenFor(env, { debrid: "torbox", debridKey: SECRET_TB })}/resolve/nothex`).expect(400);
    await request(app).get(`/${tokenFor(env, {})}/resolve/${HASH_A}`).expect(400);
    await request(app).get(`/resolve/${HASH_A}`).expect(400);
  });

  it("POST /api/config returns an install URL that contains no plain-text secrets", async () => {
    const { app } = build();
    const res = await request(app).post("/api/config").send({ debrid: "torbox", debridKey: SECRET_TB, catalogs: ["ar_movies_latest"] }).expect(200);
    expect(res.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/c_[A-Za-z0-9_-]+\/manifest\.json$/);
    expect(res.body.stremioUrl.startsWith("stremio://")).toBe(true);
    expect(res.body.manifestUrl).not.toContain(SECRET_TB);
    await request(app).get(new URL(res.body.manifestUrl).pathname).expect(200);
  });

  it("POST /api/config validates input and blocks private indexers", async () => {
    const { app } = build();
    await request(app).post("/api/config").send({ debrid: "torbox" }).expect(400);
    await request(app).post("/api/config").send({ debrid: "bogus" }).expect(400);
    await request(app).post("/api/config").send({ torznabUrl: "http://localhost:9696/api" }).expect(400);
    await request(app).post("/api/config").send({ torznabUrl: "http://192.168.1.5:9696/api" }).expect(400);
    await request(app).post("/api/config").send({ torznabUrl: "ftp://x.test/api" }).expect(400);
  });

  it("serves health and the configure page", async () => {
    const { app } = build();
    expect((await request(app).get("/health").expect(200)).body.status).toBe("ok");
    expect((await request(app).get("/configure").expect(200)).text).toContain("Create install link");
  });
});
