import type { MediaType } from "../catalogs/definitions.js";
import { tmdbEpisodeId, tmdbMetaId } from "./ids.js";
import { IMG_BACKDROP, IMG_POSTER, type TmdbDetails, type TmdbEpisode, type TmdbListItem } from "./tmdb.js";

export interface MetaPreview {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
}

export interface Video {
  id: string;
  title: string;
  season: number;
  episode: number;
  released: string;
  overview?: string;
  thumbnail?: string;
}

export interface Meta extends MetaPreview {
  language?: string;
  country?: string;
  runtime?: string;
  videos?: Video[];
  links?: Array<{ name: string; category: string; url: string }>;
  originalName?: string;
  imdb_id?: string;
}

export const titleOf = (i: TmdbListItem) => i.title ?? i.name ?? i.original_title ?? i.original_name ?? "";
export const originalTitleOf = (i: TmdbListItem) => i.original_title ?? i.original_name ?? "";
export const yearOf = (i: TmdbListItem): number | undefined => {
  const d = i.release_date || i.first_air_date;
  return d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined;
};

export function toPreview(item: TmdbListItem, type: MediaType, genres?: Map<number, string>): MetaPreview {
  const year = yearOf(item);
  const names = (item.genre_ids ?? []).map((g) => genres?.get(g)).filter((g): g is string => !!g);
  return {
    id: tmdbMetaId(type, item.id),
    type,
    // Prefer the (Arabic) localised title; TMDB falls back to the original title itself.
    name: titleOf(item),
    ...(item.poster_path ? { poster: IMG_POSTER + item.poster_path } : {}),
    ...(item.backdrop_path ? { background: IMG_BACKDROP + item.backdrop_path } : {}),
    ...(item.overview ? { description: item.overview } : {}),
    ...(year ? { releaseInfo: String(year) } : {}),
    ...(names.length ? { genres: names } : {}),
  };
}

/** True when the item looks Arabic: original language "ar" or an Arabic-speaking origin country. */
export function looksArabic(item: TmdbListItem, arabCountries: readonly string[]): boolean {
  if (item.original_language === "ar") return true;
  return (item.origin_country ?? []).some((c) => arabCountries.includes(c));
}

export function toMeta(d: TmdbDetails, type: MediaType, episodesBySeason: Map<number, TmdbEpisode[]>, fallbackOverview?: string, useImdbId = false): Meta {
  const base = toPreview(d, type);
  const imdb = d.external_ids?.imdb_id || d.imdb_id || undefined;
  // When the client asked for an IMDb id (catalog ids are IMDb where TMDB knows them) answer with the same id.
  if (useImdbId && imdb) base.id = imdb;
  const runtime = type === "movie" ? d.runtime : d.episode_run_time?.[0];
  const countries = d.origin_country?.length ? d.origin_country : (d.production_countries ?? []).map((c) => c.iso_3166_1);
  const original = originalTitleOf(d);
  const meta: Meta = {
    ...base,
    ...(d.overview || fallbackOverview ? { description: d.overview || fallbackOverview } : {}),
    genres: (d.genres ?? []).map((g) => g.name),
    ...(original && original !== base.name ? { originalName: original } : {}),
    ...(d.original_language ? { language: d.original_language } : {}),
    ...(countries.length ? { country: countries.join(", ") } : {}),
    ...(runtime ? { runtime: `${runtime} min` } : {}),
    ...(imdb ? { imdb_id: imdb } : {}),
    links: [
      { name: "TMDB", category: "TMDB", url: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${d.id}` },
      ...(imdb ? [{ name: "IMDb", category: "imdb", url: `https://www.imdb.com/title/${imdb}/` }] : []),
    ],
  };
  if (type === "series") {
    const videos: Video[] = [];
    for (const [season, eps] of [...episodesBySeason.entries()].sort((a, b) => a[0] - b[0])) {
      for (const e of eps) {
        if (!e.air_date) continue; // Stremio needs a release date for each video
        videos.push({
          id: useImdbId && imdb ? `${imdb}:${season}:${e.episode_number}` : tmdbEpisodeId(d.id, season, e.episode_number),
          title: e.name || `Episode ${e.episode_number}`,
          season,
          episode: e.episode_number,
          released: new Date(e.air_date).toISOString(),
          ...(e.overview ? { overview: e.overview } : {}),
          ...(e.still_path ? { thumbnail: IMG_POSTER + e.still_path } : {}),
        });
      }
    }
    meta.videos = videos;
  }
  return meta;
}
