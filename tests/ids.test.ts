import { describe, expect, it } from "vitest";
import { parseId } from "../src/metadata/ids.js";

describe("parseId", () => {
  it("parses tmdb movie/tv/episode ids", () => {
    expect(parseId("tmdb:movie:603")).toEqual({ kind: "tmdb", type: "movie", tmdbId: 603, season: undefined, episode: undefined });
    expect(parseId("tmdb:tv:1396:2:5")).toMatchObject({ kind: "tmdb", type: "series", tmdbId: 1396, season: 2, episode: 5 });
  });
  it("parses IMDb ids with optional season/episode", () => {
    expect(parseId("tt0903747:1:2")).toMatchObject({ kind: "imdb", imdbId: "tt0903747", season: 1, episode: 2 });
    expect(parseId("tt0133093")).toMatchObject({ kind: "imdb", imdbId: "tt0133093" });
  });
  it("rejects malformed or unknown ids", () => {
    for (const bad of ["", "foo", "tmdb:movie", "tmdb:movie:abc", "tmdb:movie:1:1:1", "tmdb:tv:1:2", "tmdb:tv:1:a:b", "tt12", "kitsu:1", "tmdb:tv:1:2:3:4", "%E0%A4%A"]) {
      expect(parseId(bad), bad).toBeNull();
    }
  });
});

describe("large TMDB ids", () => {
  it("accepts 7-digit ids (new titles)", () => {
    expect(parseId("tmdb:movie:1651563")).toMatchObject({ kind: "tmdb", type: "movie", tmdbId: 1651563 });
    expect(parseId("tmdb:tv:1234567:1:2")).toMatchObject({ tmdbId: 1234567, season: 1, episode: 2 });
  });
});
