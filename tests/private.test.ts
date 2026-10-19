import { createHash } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptConfig, userConfigSchema } from "../src/config/userConfig.js";
import { infoHashOfTorrent } from "../src/lib/torrent.js";
import { releaseMatches, cleanReleaseTitle, resetTorrentHashCache } from "../src/providers/torznab.js";
import { parseRelease } from "../src/providers/release.js";
import { createApp } from "../src/server/app.js";
import { mockFetch, noSleep, testEnv, tmdbShow } from "./helpers.js";

// A tiny but valid single-file torrent
const INFO = "d6:lengthi5e4:name1:x12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
const TORRENT = Buffer.from(`d8:announce20:http://tracker.test/4:info${INFO}e`, "latin1");
const HASH = createHash("sha1").update(INFO, "latin1").digest("hex");

describe("torrent files", () => {
  it("computes the info-hash from the info dictionary only", () => {
    expect(infoHashOfTorrent(TORRENT)).toBe(HASH);
  });
  it("rejects garbage", () => {
    expect(infoHashOfTorrent(Buffer.from("not a torrent"))).toBeNull();
    expect(infoHashOfTorrent(Buffer.from("d4:name1:xe"))).toBeNull();
  });
});

describe("bilingual private-tracker release names", () => {
  const hayba = { type: "series" as const, titles: ["الهيبة", "Al Hayba"], season: 1, episode: 3 };
  it("cleans bracketed names", () => {
    expect(cleanReleaseTitle("الهيبة [كامل] [S01] [مترجم] [NF] [1080p] [H264] Al Hayba")).toBe("الهيبة Al Hayba");
  });
  it("accepts the right season pack and the right episode", () => {
    expect(releaseMatches("الهيبة [كامل] [S01] [مترجم] [NF] [1080p] [H264] Al Hayba", hayba)).toBe(true);
    expect(releaseMatches("الهيبة S01E03 [1080p]", hayba)).toBe(true);
    expect(releaseMatches("الهيبة S01E04 [1080p]", hayba)).toBe(false);
  });
  it("does not confuse a spin-off or a different season", () => {
    expect(releaseMatches("الهيبة: رأس الجبل [كامل] [S01] [2026] [SHAHID] [1080p]", hayba)).toBe(false);
    expect(releaseMatches("الهيبة [كامل] [S02] [1080p] Al Hayba", hayba)).toBe(false);
    expect(releaseMatches("Dark Phoenix S01 Complete", { type: "series", titles: ["Dark"], season: 1, episode: 1 })).toBe(false);
  });
});

beforeEach(() => resetTorrentHashCache());

describe("private tracker end to end (mocked)", () => {
  const env = testEnv({ TORZNAB_URL: undefined, ALLOW_PRIVATE_INDEXERS: true });
  const xml = `<rss xmlns:torznab="x"><channel><item><title>Bab.Al.Hara.S01E02.1080p</title><link>http://prowlarr.test/1/download?apikey=PKEY&amp;link=abc</link>
    <torznab:attr name="seeders" value="4"/></item><item><title>Bab.Al.Hara.S01E02.720p</title><link>http://evil.test/steal.torrent</link></item></channel></rss>`;
  const make = (extra: Array<[string, (u: URL, i?: RequestInit) => unknown]> = []) => {
    let uploaded: FormDataEntryValue | null = null;
    const f = mockFetch([
      ...extra,
      ["torbox.app/v1/api/torrents/checkcached", () => ({ success: true, data: {} })],
      ["torrents/createtorrent", (_u, init) => {
        uploaded = (init?.body as FormData).get("file");
        return { success: true, data: { torrent_id: 3 } };
      }],
      ["torrents/mylist", () => ({ success: true, data: { id: 3, download_finished: true, files: [{ id: 1, name: "ep2.S01E02.mkv", size: 9 }] } })],
      ["torrents/requestdl", () => ({ success: true, data: "https://cdn.torbox.test/f" })],
      ["prowlarr.test/1/api", () => new Response(xml)],
      ["prowlarr.test/1/download", () => new Response(new Uint8Array(TORRENT))],
      ["/genre/", () => ({ genres: [] })],
      [/\/tv\/10\?.*language=en/, () => tmdbShow(10, "Bab Al Hara")],
      [/\/tv\/10\?/, () => ({ ...tmdbShow(10, "باب الحارة"), external_ids: {} })],
    ]);
    return { f, app: createApp({ env, fetchImpl: f, sleep: noSleep }), uploaded: () => uploaded };
  };
  const tok = () => encryptConfig(userConfigSchema.parse({ debrid: "torbox", debridKey: "TBKEY", torznabUrl: "http://prowlarr.test/1/api", torznabKey: "PKEY", internetArchive: false, arabicOnly: false, allowPrivateUpload: true }), env.CONFIG_SECRET);

  it("with TorBox it reads at most a few .torrent files while searching (to check the cache), then uploads the file on click", async () => {
    const { app, uploaded, f } = make();
    const t = tok();
    const res = await request(app).get(`/${t}/stream/series/tmdb:tv:10:1:2.json`).expect(200);
    expect(res.body.streams).toHaveLength(1); // the release hosted on another origin is ignored
    const url = new URL(res.body.streams[0].url);
    expect(url.pathname).toBe(`/${t}/resolve/${HASH}/1/2`); // hash learned from the file
    expect(f.calls.filter((c) => c.url.includes("/download")).length).toBeLessThanOrEqual(3);
    expect(res.body.streams[0].description).toContain("Not cached (TB)"); // TorBox was asked and said no: honest label
    expect(url.searchParams.get("t")).toMatch(/^t_/);
    expect(res.text).not.toContain("PKEY");
    expect(res.text).not.toContain("prowlarr.test");

    const go = await request(app).get(url.pathname + url.search).expect(302);
    expect(go.headers.location).toBe("https://cdn.torbox.test/f");
    expect(uploaded()).toBeTruthy(); // the .torrent file itself was sent to TorBox
  });

  it("refuses tampered or foreign download links", async () => {
    const { app } = make();
    const t = tok();
    await request(app).get(`/${t}/resolve/${HASH}/1/2?t=t_garbage`).expect(400);
  });

  it("explains when the tracker refuses the download (returns a message instead of a torrent)", async () => {
    const { app } = make([["prowlarr.test/1/download", () => new Response("<b>no access</b>")]]);
    const t = tok();
    const res = await request(app).get(`/${t}/stream/series/tmdb:tv:10:1:2.json`);
    const url = new URL(res.body.streams[0].url);
    const go = await request(app).get(url.pathname + url.search).expect(502);
    expect(go.text).toMatch(/valid \.torrent/);
  });
});

describe("hashtags in release names", () => {
  it("are ignored", () => {
    const q = { type: "series" as const, titles: ["الهيبة: راس الجبل", "Al Hayba: Ras Al Jabal"], season: 1, episode: 3 };
    expect(releaseMatches("الهيبة: راس الجبل [كامل] [S01] [2026] [SHAHID] [1080p] #رمضان2026", q)).toBe(true);
  });
});

describe("Arabic bracket-style title formats (real examples)", () => {
  it("movies with the whole title in brackets", () => {
    expect(cleanReleaseTitle("[عرب البوح] [1999] [1080p] [Web-DL]")).toBe("عرب البوح");
    const q = { type: "movie" as const, titles: ["عرب البوح"], year: 1999 };
    expect(releaseMatches("[عرب البوح] [1999] [1080p] [Web-DL]", q)).toBe(true);
    expect(releaseMatches("[عرب البوح] [2005] [1080p] [Web-DL]", q)).toBe(false);
    expect(releaseMatches("[الشرسة] [1993] [1080p] [Web-DL]", q)).toBe(false);
  });
  it("Arabic season markers", () => {
    expect(parseRelease("سلم الهاند [E05 E01] [م2] [2026] [YANGO] [1080p]")).toMatchObject({ season: 2 });
    expect(parseRelease("مسلسل س [الموسم 3] [1080p]")).toMatchObject({ season: 3, pack: true });
  });
  it("platform tags and plain bracket names do not become titles", () => {
    expect(cleanReleaseTitle("أحلى وأصعب S01E15 [SHAHID] [2160p] [H265]")).toBe("أحلى وأصعب");
  });
});

describe("gentle cache lookups", () => {
  const items = ["480p", "1080p", "720p"].map((r, i) => `<item><title>[Kazan Nights] [1999] [${r}] [Web-DL]</title><size>${100 + i}</size><link>http://idx.test/1/download?link=${i}</link></item>`).join("");
  const xml = `<rss><channel>${items}</channel></rss>`;
  const q = { type: "movie" as const, titles: ["Kazan Nights"], year: 1999 };

  it("downloads at most N files, best quality first, and learns their hashes", async () => {
    const downloads: string[] = [];
    const f = mockFetch([
      ["idx.test/1/api", () => new Response(xml)],
      ["idx.test/1/download", (u) => { downloads.push(u.search); return new Response(new Uint8Array(TORRENT)); }],
    ]);
    const { TorznabProvider } = await import("../src/providers/torznab.js");
    const out = await new TorznabProvider({ url: "http://idx.test/1/api", hashLookups: 2, fetchImpl: f, sleep: noSleep }).search(q);
    expect(downloads).toHaveLength(2);
    expect(downloads[0]).toContain("link=1"); // 1080p first
    expect(out.filter((r) => r.kind === "torrent" && r.infoHash === HASH)).toHaveLength(1); // same file bytes -> same hash -> de-duplicated
    expect(out.some((r) => r.kind === "torrent" && !r.infoHash)).toBe(true); // the third stays unchecked
  });

  it("never downloads when lookups are 0; a refusal is remembered so the tracker is not asked again", async () => {
    let n = 0;
    const f = mockFetch([["idx.test/1/api", () => new Response(xml)], ["idx.test/1/download", () => (n++, new Response("denied"))]]);
    const { TorznabProvider } = await import("../src/providers/torznab.js");
    await new TorznabProvider({ url: "http://idx.test/1/api", hashLookups: 0, fetchImpl: f, sleep: noSleep }).search(q);
    expect(n).toBe(0);
    await new TorznabProvider({ url: "http://idx.test/1/api", hashLookups: 3, fetchImpl: f, sleep: noSleep }).search({ ...q, year: 1999, titles: ["Kazan Nights"] });
    expect(n).toBe(3); // three in parallel, all refused
    await new TorznabProvider({ url: "http://idx.test/1/api", hashLookups: 3, fetchImpl: f, sleep: noSleep }).search(q);
    expect(n).toBe(3); // refusals are remembered: nothing more is downloaded
  });
});
