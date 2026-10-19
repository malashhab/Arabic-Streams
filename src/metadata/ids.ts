import type { MediaType } from "../catalogs/definitions.js";

export type ParsedId =
  | { kind: "tmdb"; type: MediaType; tmdbId: number; season?: number; episode?: number }
  | { kind: "imdb"; imdbId: string; season?: number; episode?: number };

const posInt = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (!/^\d{1,9}$/.test(s)) return NaN; // TMDB ids for new titles already have 7 digits
  return Number(s);
};

/**
 * Parse ids this addon understands:
 *   tmdb:movie:603            tmdb:tv:1396            tmdb:tv:1396:2:5  (season 2 episode 5)
 *   tt0133093                 tt0903747:1:2           (IMDb, optional :season:episode)
 * Anything else returns null. IDs are never invented.
 */
export function parseId(id: string): ParsedId | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts[0] === "tmdb") {
    const kind = parts[1];
    if (kind !== "movie" && kind !== "tv") return null;
    const tmdbId = posInt(parts[2]);
    const season = posInt(parts[3]);
    const episode = posInt(parts[4]);
    if (!tmdbId || Number.isNaN(season) || Number.isNaN(episode) || parts.length > 5) return null;
    if ((season === undefined) !== (episode === undefined)) return null;
    if (kind === "movie" && season !== undefined) return null;
    return { kind: "tmdb", type: kind === "movie" ? "movie" : "series", tmdbId, season, episode };
  }
  if (/^tt\d{5,10}$/.test(parts[0] ?? "")) {
    const season = posInt(parts[1]);
    const episode = posInt(parts[2]);
    if (Number.isNaN(season) || Number.isNaN(episode) || parts.length > 3) return null;
    if ((season === undefined) !== (episode === undefined)) return null;
    return { kind: "imdb", imdbId: parts[0]!, season, episode };
  }
  return null;
}

export const tmdbMetaId = (type: MediaType, id: number) => `tmdb:${type === "movie" ? "movie" : "tv"}:${id}`;
export const tmdbEpisodeId = (id: number, season: number, episode: number) => `tmdb:tv:${id}:${season}:${episode}`;
