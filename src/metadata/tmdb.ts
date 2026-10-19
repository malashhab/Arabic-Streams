import { TtlCache } from "../lib/cache.js";
import { AddonError } from "../lib/errors.js";
import { httpJson, type FetchLike } from "../lib/http.js";
import type { MediaType } from "../catalogs/definitions.js";

const BASE = "https://api.themoviedb.org/3";
export const IMG_POSTER = "https://image.tmdb.org/t/p/w500";
export const IMG_BACKDROP = "https://image.tmdb.org/t/p/w1280";

export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  origin_country?: string[];
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  vote_average?: number;
}

export interface TmdbDetails extends TmdbListItem {
  genres?: Array<{ id: number; name: string }>;
  runtime?: number;
  episode_run_time?: number[];
  production_countries?: Array<{ iso_3166_1: string }>;
  seasons?: Array<{ season_number: number; episode_count: number }>;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  imdb_id?: string | null;
  status?: string;
}

export interface TmdbEpisode {
  episode_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  still_path?: string | null;
}

export interface TmdbPage<T> {
  results: T[];
  page: number;
  total_pages: number;
}

const DAY = 24 * 3600_000;

/** Thin TMDB v3 client (Bearer "API Read Access Token"). Caches only public metadata. */
export class TmdbClient {
  private cache = new TtlCache<unknown>(2000);

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  get configured(): boolean {
    return !!this.token;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>, ttlMs: number): Promise<T> {
    const token = this.token;
    if (!token) {
      throw new AddonError("TMDB is not configured (set TMDB_READ_TOKEN on the server or add a token in the addon settings)", 503, "tmdb_not_configured");
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    qs.sort();
    const url = `${BASE}${path}?${qs}`;
    // The token is deliberately not part of the cache key: this is public metadata, identical for every user.
    // Two TMDB credential types exist: the long JWT "Read Access Token" (Bearer header) and the 32-char v3 "API Key" (query param).
    const isBearer = token.startsWith("eyJ");
    return (await this.cache.wrap(url, ttlMs, () =>
      httpJson<T>(isBearer ? url : `${url}&api_key=${encodeURIComponent(token)}`, {
        headers: isBearer ? { authorization: `Bearer ${token}` } : {},
        label: "TMDB",
        fetchImpl: this.fetchImpl,
        sleep: this.sleep,
      }),
    )) as T;
  }

  discover(type: MediaType, params: Record<string, string | number | undefined>, page: number): Promise<TmdbPage<TmdbListItem>> {
    return this.get(`/discover/${type === "movie" ? "movie" : "tv"}`, { language: "ar-SA", include_adult: "false", page, ...params }, 3600_000);
  }

  search(type: MediaType, query: string, page = 1, language = "ar-SA"): Promise<TmdbPage<TmdbListItem>> {
    return this.get(`/search/${type === "movie" ? "movie" : "tv"}`, { query, language, include_adult: "false", page }, 6 * 3600_000);
  }

  details(type: MediaType, id: number, language = "ar-SA"): Promise<TmdbDetails> {
    return this.get(`/${type === "movie" ? "movie" : "tv"}/${id}`, { language, append_to_response: "external_ids" }, DAY);
  }

  season(tvId: number, season: number, language = "ar-SA"): Promise<{ episodes: TmdbEpisode[] }> {
    return this.get(`/tv/${tvId}/season/${season}`, { language }, DAY);
  }

  async findByImdb(imdbId: string): Promise<{ type: MediaType; id: number } | null> {
    const r = await this.get<{ movie_results?: TmdbListItem[]; tv_results?: TmdbListItem[] }>(`/find/${imdbId}`, { external_source: "imdb_id" }, 7 * DAY);
    const tv = r.tv_results?.[0];
    if (tv) return { type: "series", id: tv.id };
    const m = r.movie_results?.[0];
    return m ? { type: "movie", id: m.id } : null;
  }

  /** IMDb id for a TMDB title, or undefined when TMDB has none (we never invent one). */
  async imdbIdOf(type: MediaType, id: number): Promise<string | undefined> {
    const r = await this.get<{ imdb_id?: string | null }>(`/${type === "movie" ? "movie" : "tv"}/${id}/external_ids`, {}, 7 * DAY);
    return r.imdb_id && /^tt\d{5,10}$/.test(r.imdb_id) ? r.imdb_id : undefined;
  }

  async genreMap(type: MediaType): Promise<Map<number, string>> {
    const r = await this.get<{ genres: Array<{ id: number; name: string }> }>(`/genre/${type === "movie" ? "movie" : "tv"}/list`, { language: "ar" }, 7 * DAY);
    return new Map(r.genres.map((g) => [g.id, g.name]));
  }
}
