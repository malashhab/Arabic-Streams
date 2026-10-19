import { bestMatch, MATCH_THRESHOLD } from "../arabic/fuzzy.js";
import { normalizeQuery } from "../arabic/normalize.js";
import { AddonError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { looksArabic, originalTitleOf, titleOf, toPreview, type MetaPreview } from "../metadata/mapper.js";
import type { TmdbClient, TmdbListItem } from "../metadata/tmdb.js";
import { ARAB_COUNTRIES, PAGE_SIZE, REGIONS, type CatalogDef, type MediaType } from "./definitions.js";
import { ramadanQueryWindow, ramadanRange } from "./ramadan.js";

export interface CatalogExtra {
  genre?: string;
  search?: string;
  skip?: number;
}

export interface CatalogResult {
  metas: MetaPreview[];
  cacheMaxAge: number;
}

export interface CatalogOptions {
  arabicOnly: boolean;
  ramadanOverrides?: { start?: string; end?: string };
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Builds catalog responses from TMDB discover/search. Everything here is public data and safe to share between users. */
export class CatalogService {
  constructor(private readonly tmdb: TmdbClient, private readonly opts: Pick<CatalogOptions, "ramadanOverrides" | "now"> = {}) {}

  async getCatalog(def: CatalogDef, extra: CatalogExtra, options: Pick<CatalogOptions, "arabicOnly">): Promise<CatalogResult> {
    const now = this.opts.now?.() ?? new Date();
    const skip = Math.max(0, Math.floor(extra.skip ?? 0));
    const page = Math.floor(skip / PAGE_SIZE) + 1;
    const isMovie = def.type === "movie";
    const today = iso(now);
    const dateField = isMovie ? "primary_release_date" : "first_air_date";
    const base: Record<string, string | number | undefined> = { with_original_language: "ar" };

    if (def.kind === "search") return this.search(def, extra.search ?? "", page, options.arabicOnly);

    let params: Record<string, string | number | undefined>;
    let cacheMaxAge = 3600 * 6;
    switch (def.kind) {
      case "latest":
        params = { ...base, sort_by: `${dateField}.desc`, [`${dateField}.lte`]: today, "vote_count.gte": isMovie ? 1 : undefined };
        cacheMaxAge = 3600 * 3;
        break;
      case "year": {
        const year = this.parseYear(extra.genre, now.getFullYear());
        params = { ...base, sort_by: "popularity.desc", [isMovie ? "primary_release_year" : "first_air_date_year"]: year };
        break;
      }
      case "ramadan": {
        const year = this.parseYear(extra.genre, Math.max(now.getFullYear(), 2026));
        const range = ramadanRange(year, this.opts.ramadanOverrides);
        if (!range) throw new AddonError("Could not determine Ramadan dates for that year", 400, "bad_request");
        const w = ramadanQueryWindow(range);
        params = { ...base, sort_by: "popularity.desc", "first_air_date.gte": w.gte, "first_air_date.lte": w.lte };
        break;
      }
      case "region": {
        const countries = REGIONS[def.region!].countries;
        params = { ...base, with_origin_country: countries.join("|"), sort_by: "popularity.desc", [`${dateField}.lte`]: today };
        break;
      }
      default:
        throw new AddonError("Unknown catalog", 404, "not_found");
    }

    const [pageData, genres] = await Promise.all([this.tmdb.discover(def.type, params, page), this.tmdb.genreMap(def.type).catch(() => undefined)]);
    return { metas: await this.withImdbIds(pageData.results.map((r) => toPreview(r, def.type, genres)), def.type), cacheMaxAge };
  }

  /**
   * Prefer IMDb ids in catalogs: Stremio/Nuvio then also ask every stream addon the user has installed
   * (Torrentio, Comet, ...) for this title. Titles TMDB has no IMDb id for keep their tmdb: id.
   */
  private async withImdbIds(metas: MetaPreview[], type: MediaType): Promise<MetaPreview[]> {
    return Promise.all(
      metas.map(async (m) => {
        const tmdbId = Number(m.id.split(":")[2]);
        const imdb = await this.tmdb.imdbIdOf(type, tmdbId).catch(() => undefined);
        return imdb ? { ...m, id: imdb } : m;
      }),
    );
  }

  private parseYear(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d{4}$/.test(raw)) throw new AddonError("Invalid year", 400, "bad_request");
    return Number(raw);
  }

  async search(def: CatalogDef, rawQuery: string, page: number, arabicOnly: boolean): Promise<CatalogResult> {
    const query = rawQuery.trim().slice(0, 100);
    if (query.length < 2) return { metas: [], cacheMaxAge: 60 };
    const normalized = normalizeQuery(query);

    // Ask TMDB for both the raw and the normalised spelling (أ/إ/آ → ا etc.), plus an English-language pass,
    // because TMDB indexes alternative titles including common transliterations.
    const variants = [...new Set([query, normalized])].filter(Boolean);
    const passes = await Promise.all([
      ...variants.map((q) => this.tmdb.search(def.type, q, page, "ar-SA")),
      this.tmdb.search(def.type, normalized, page, "en-US"),
    ]);

    const seen = new Map<number, { item: TmdbListItem; rank: number }>();
    for (const p of passes) {
      p.results.forEach((item, rank) => {
        const prev = seen.get(item.id);
        if (!prev || rank < prev.rank) seen.set(item.id, { item, rank });
      });
    }

    const scored = [...seen.values()]
      .filter(({ item }) => !arabicOnly || looksArabic(item, ARAB_COUNTRIES))
      .map(({ item, rank }) => ({ item, rank, score: bestMatch(query, [titleOf(item), originalTitleOf(item)]) }))
      // Keep close textual matches, plus TMDB's own top hits (it may have matched an alternative title we cannot see).
      .filter((s) => s.score >= MATCH_THRESHOLD || (s.rank < 3 && s.score >= 0.4))
      .sort((a, b) => b.score - a.score || a.rank - b.rank);

    log.debug("search", { type: def.type, in: passes.reduce((n, p) => n + p.results.length, 0), out: scored.length });
    const genres = await this.tmdb.genreMap(def.type).catch(() => undefined);
    return { metas: await this.withImdbIds(scored.slice(0, PAGE_SIZE).map((s) => toPreview(s.item, def.type, genres)), def.type), cacheMaxAge: 3600 };
  }
}
