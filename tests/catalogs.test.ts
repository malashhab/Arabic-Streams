import { describe, expect, it } from "vitest";
import { findCatalog } from "../src/catalogs/definitions.js";
import { computeRamadan, ramadanRange } from "../src/catalogs/ramadan.js";
import { CatalogService } from "../src/catalogs/service.js";
import { TmdbClient } from "../src/metadata/tmdb.js";
import { mockFetch, noSleep, tmdbMovie, tmdbShow } from "./helpers.js";

const genres: [string, () => unknown] = ["/genre/movie/list", () => ({ genres: [{ id: 18, name: "دراما" }] })];
const tvGenres: [string, () => unknown] = ["/genre/tv/list", () => ({ genres: [{ id: 18, name: "دراما" }] })];

function svc(handlers: Array<[RegExp | string, (u: URL) => unknown]>) {
  const f = mockFetch([...handlers, genres, tvGenres]);
  return { f, svc: new CatalogService(new TmdbClient("t", f, noSleep), { now: () => new Date("2026-10-19T00:00:00Z") }) };
}
const params = (f: ReturnType<typeof mockFetch>, needle: string) => new URL(f.calls.find((c) => c.url.includes(needle))!.url).searchParams;

describe("catalog responses", () => {
  it("latest Arabic movies: filters to Arabic, newest first, maps metadata", async () => {
    const { f, svc: s } = svc([["/discover/movie", () => ({ results: [tmdbMovie(1, "فيلم")], page: 1, total_pages: 1 })]]);
    const r = await s.getCatalog(findCatalog("ar_movies_latest", "movie")!, {}, { arabicOnly: true });
    const p = params(f, "/discover/movie");
    expect(p.get("with_original_language")).toBe("ar");
    expect(p.get("sort_by")).toBe("primary_release_date.desc");
    expect(p.get("primary_release_date.lte")).toBe("2026-10-19");
    expect(r.metas[0]).toMatchObject({ id: "tmdb:movie:1", type: "movie", name: "فيلم", releaseInfo: "2024", genres: ["دراما"], poster: "https://image.tmdb.org/t/p/w500/p1.jpg" });
  });

  it("series by year uses first_air_date_year and pagination via skip", async () => {
    const { f, svc: s } = svc([["/discover/tv", () => ({ results: [tmdbShow(2, "مسلسل")], page: 2, total_pages: 5 })]]);
    const r = await s.getCatalog(findCatalog("ar_series_year", "series")!, { genre: "2019", skip: 20 }, { arabicOnly: true });
    const p = params(f, "/discover/tv");
    expect(p.get("first_air_date_year")).toBe("2019");
    expect(p.get("page")).toBe("2");
    expect(r.metas[0]!.id).toBe("tmdb:tv:2");
  });

  it("rejects an invalid year", async () => {
    const { svc: s } = svc([]);
    await expect(s.getCatalog(findCatalog("ar_movies_year", "movie")!, { genre: "20x9" }, { arabicOnly: true })).rejects.toMatchObject({ status: 400 });
  });

  it("region catalogs use origin-country OR lists", async () => {
    const { f, svc: s } = svc([["/discover/tv", () => ({ results: [], page: 1, total_pages: 1 })]]);
    await s.getCatalog(findCatalog("ar_series_gulf", "series")!, {}, { arabicOnly: true });
    expect(params(f, "/discover/tv").get("with_origin_country")).toBe("SA|KW|AE|QA|BH|OM");
  });

  it("Ramadan catalog queries the computed window and honours the 2026 override", async () => {
    const { f, svc: s } = svc([["/discover/tv", () => ({ results: [], page: 1, total_pages: 1 })]]);
    await s.getCatalog(findCatalog("ar_series_ramadan", "series")!, { genre: "2026" }, { arabicOnly: true });
    const p = params(f, "/discover/tv");
    expect(p.get("first_air_date.gte")! < p.get("first_air_date.lte")!).toBe(true);
    expect(p.get("first_air_date.lte")!.startsWith("2026-03")).toBe(true);

    const f2 = mockFetch([["/discover/tv", () => ({ results: [], page: 1, total_pages: 1 })], tvGenres]);
    const s2 = new CatalogService(new TmdbClient("t", f2, noSleep), { ramadanOverrides: { start: "2026-02-19", end: "2026-03-19" } });
    await s2.getCatalog(findCatalog("ar_series_ramadan", "series")!, { genre: "2026" }, { arabicOnly: true });
    expect(params(f2, "/discover/tv").get("first_air_date.gte")).toBe("2026-02-09");
    expect(params(f2, "/discover/tv").get("first_air_date.lte")).toBe("2026-03-19");
  });

  it("computes Ramadan from the Islamic calendar", () => {
    const r = computeRamadan(2026)!;
    expect(r.start >= "2026-02-17" && r.start <= "2026-02-20").toBe(true);
    expect(r.end >= "2026-03-17" && r.end <= "2026-03-21").toBe(true);
    expect(ramadanRange(2026, { start: "2026-02-19", end: "2026-03-20" })!.source).toBe("override");
    expect(ramadanRange(2025, { start: "2026-02-19", end: "2026-03-20" })!.source).toBe("umalqura");
  });
});

describe("Arabic search", () => {
  const results = {
    results: [tmdbShow(10, "باب الحارة"), tmdbShow(11, "الهيبة"), tmdbShow(12, "Breaking Bad", { original_language: "en", origin_country: ["US"] })],
    page: 1,
    total_pages: 1,
  };

  it("ranks the matching title first, drops unrelated and non-Arabic results", async () => {
    const { svc: s } = svc([["/search/tv", () => results]]);
    const r = await s.getCatalog(findCatalog("ar_search_series", "series")!, { search: "باب الحارة" }, { arabicOnly: true });
    expect(r.metas.map((m) => m.id)).toEqual(["tmdb:tv:10"]);
  });

  it("finds an Arabic title from a Latin transliteration", async () => {
    const { svc: s } = svc([["/search/tv", () => ({ results: [tmdbShow(10, "باب الحارة"), tmdbShow(11, "الهيبة")], page: 1, total_pages: 1 })]]);
    const r = await s.getCatalog(findCatalog("ar_search_series", "series")!, { search: "Bab Al Hara" }, { arabicOnly: true });
    expect(r.metas[0]!.id).toBe("tmdb:tv:10");
    expect(r.metas.some((m) => m.id === "tmdb:tv:11")).toBe(false);
  });

  it("sends the normalised spelling to TMDB too", async () => {
    const { f, svc: s } = svc([["/search/tv", () => results]]);
    await s.getCatalog(findCatalog("ar_search_series", "series")!, { search: "أحمــد" }, { arabicOnly: true });
    const qs = f.calls.filter((c) => c.url.includes("/search/tv")).map((c) => new URL(c.url).searchParams.get("query"));
    expect(qs).toContain("احمد");
  });

  it("returns nothing for a too-short query and can include non-Arabic when arabicOnly is off", async () => {
    const { svc: s } = svc([["/search/tv", () => results]]);
    expect((await s.getCatalog(findCatalog("ar_search_series", "series")!, { search: "a" }, { arabicOnly: true })).metas).toEqual([]);
    const r = await s.getCatalog(findCatalog("ar_search_series", "series")!, { search: "Breaking Bad" }, { arabicOnly: false });
    expect(r.metas.map((m) => m.id)).toContain("tmdb:tv:12");
  });
});
