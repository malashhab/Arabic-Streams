import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { bestMatch } from "../arabic/fuzzy.js";
import { hasArabic } from "../arabic/normalize.js";
import { TtlCache } from "../lib/cache.js";
import { httpRequest, type FetchLike } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { infoHashOfTorrent } from "../lib/torrent.js";
import { parseRelease } from "./release.js";
import type { Release, StreamProvider, StreamQuery, TorrentRelease } from "./types.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * "Show.Name.2024.S01E02.1080p.WEB-DL" -> "Show Name"; "الهيبة [كامل] [S01] [NF] [1080p] Al Hayba" -> "الهيبة Al Hayba".
 * Keeps the text before the first year / season / episode / quality marker and drops [bracket] groups and filler words.
 */
// Bracket groups that are metadata, not part of the title: quality, source, platform, "complete", season/episode, #hashtags, numbers
const NOISE_GROUP = /^(\d{3,4}p|fhd|uhd|hd|4k|web[- ]?dl|web[- ]?rip|blu-?ray|hdtv|dvdrip|h\.?26[45]|x26[45]|hevc|av1|nf|shahid|yango|netflix|amazon|disney\+?|tod|osn\+?|watch ?it|كامل|مترجم|مدبلج|مجمعة|تجميعة|[سم]\d+|s\d+(e\d+)?|e\d+.*|#.*|\d.*)$/i;
const FILLER = /^(مسلسل|فيلم|مترجم|مدبلج|series|movie|film)$/i;

export function cleanReleaseTitle(name: string): string {
  const spaced = name.replace(/[._]/g, " ");
  const n = spaced.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  const cut = n.search(/\b(19[4-9]\d|20[0-4]\d|S\d{1,2}\s?E\d{1,3}|S\d{1,2}|E(?:p|pisode)?\s?\d{1,3}|episode|\d{3,4}p|season|complete|web-?dl|bluray|hdtv)\b/i);
  const tidy = (t: string) => t.split(/\s+/).filter((w) => w && !w.startsWith("#") && !FILLER.test(w)).join(" ").trim();
  const head = tidy(cut > 0 ? n.slice(0, cut) : n);
  if (head.length >= 2) return head;
  // Some trackers put the whole title in brackets: "[عرب البوح] [1999] [1080p] [Web-DL]" -> the first group that is not metadata
  const group = [...spaced.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim()).find((g) => /\p{L}/u.test(g) && !NOISE_GROUP.test(g));
  return group ? tidy(group) : head;
}

/** Release names are often bilingual ("الهيبة ... Al Hayba"): compare the whole name and each script on its own. */
function titleVariants(cleaned: string): string[] {
  const words = cleaned.split(/\s+/).filter(Boolean);
  const ar = words.filter((w) => hasArabic(w)).join(" ");
  const lat = words.filter((w) => !hasArabic(w)).join(" ");
  return [...new Set([cleaned, ar, lat].filter((s) => s.length >= 2))];
}

export type MatchQuality = "exact" | "likely";

/**
 * How well does this release match what was asked for? null = does not match (wrong title, year, season or episode).
 *  - "exact": the title matches closely AND the year (movies) / season+episode (series, or a pack of that exact season) agree
 *  - "likely": plausible but not certain (fuzzy title, year off by one or missing, season implied rather than stated)
 */
export function matchQuality(title: string, q: StreamQuery, opts: { minScore?: number; titleTrusted?: boolean } = {}): MatchQuality | null {
  const info = parseRelease(title);
  // Strict comparison: a release called "Dark" must not be accepted for "Dark Phoenix" (or the reverse).
  // IMDb-id search results get a looser threshold, but never none: many indexers silently ignore imdbid.
  const score = titleVariants(cleanReleaseTitle(title)).reduce((best, v) => Math.max(best, bestMatch(v, q.titles, { strict: true })), 0);
  if (score < (opts.minScore ?? (opts.titleTrusted ? 0.5 : 0.78))) return null;
  const titleSure = score >= 0.9;
  if (q.type === "movie") {
    if (q.year && info.year && Math.abs(info.year - q.year) > 1) return null;
    return titleSure && !!q.year && info.year === q.year ? "exact" : "likely";
  }
  if (q.season === undefined) return titleSure ? "exact" : "likely";
  if (info.season === undefined) {
    // Episode number without a season ("E05", Arabic "episode 5"): season 1 is implied, so never better than "likely"
    if (info.episode !== undefined) return q.season === 1 && info.episode === q.episode ? "likely" : null;
    return info.pack ? "likely" : null; // complete-series pack
  }
  if (info.season !== q.season) return null;
  if (info.episode === undefined) return info.pack ? (titleSure ? "exact" : "likely") : null;
  const last = info.episodeEnd ?? info.episode; // "S01E01 E02" covers episodes 1 and 2
  if (q.episode === undefined || q.episode < info.episode || q.episode > last) return null;
  return titleSure ? "exact" : "likely";
}

/** Does this release plausibly match what was asked for? (title, year, season/episode) */
export function releaseMatches(title: string, q: StreamQuery, opts: { minScore?: number; titleTrusted?: boolean } = {}): boolean {
  return matchQuality(title, q, opts) !== null;
}

function attrs(item: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of asArray(item["torznab:attr"] as { "@_name"?: string; "@_value"?: string } | Array<{ "@_name"?: string; "@_value"?: string }> | undefined)) {
    if (a["@_name"] && a["@_value"] !== undefined) out[a["@_name"]] = String(a["@_value"]);
  }
  return out;
}

/** A search hit. Public trackers give a hash/magnet; private ones only a .torrent download link. */
export interface RawItem {
  title: string;
  match?: MatchQuality;
  infoHash?: string;
  torrentUrl?: string;
  size?: number;
  seeders?: number;
  indexer?: string;
}

export function parseTorznab(xml: string): RawItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const items = asArray(doc.rss?.channel?.item) as Array<Record<string, unknown>>;
  const out: RawItem[] = [];
  for (const item of items) {
    const a = attrs(item);
    const title = typeof item.title === "string" ? item.title : String(item.title ?? "");
    const link = typeof item.link === "string" ? item.link : undefined;
    const enclosure = (item.enclosure as { "@_url"?: string } | undefined)?.["@_url"];
    const magnet = a.magneturl ?? (link?.startsWith("magnet:") ? link : undefined);
    let hash = a.infohash?.toLowerCase();
    if (!hash && magnet) hash = magnet.match(/btih:([a-f0-9]{40})/i)?.[1]?.toLowerCase();
    if (hash && !/^[a-f0-9]{40}$/.test(hash)) hash = undefined;
    const fileUrl = [enclosure, link].find((u) => typeof u === "string" && /^https?:\/\//i.test(u));
    if (!title || (!hash && !fileUrl)) continue;
    const size = Number(a.size ?? item.size);
    const seeders = Number(a.seeders);
    out.push({
      title,
      ...(hash ? { infoHash: hash } : { torrentUrl: fileUrl }),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      ...(a.seeders !== undefined && Number.isFinite(seeders) ? { seeders } : {}),
      ...(typeof item.jackettindexer === "string" ? { indexer: item.jackettindexer } : typeof (item.prowlarrindexer as { "#text"?: string })?.["#text"] === "string" ? { indexer: (item.prowlarrindexer as { "#text": string })["#text"] } : {}),
    });
  }
  return out;
}

export interface TorznabConfig {
  url: string;
  apiKey?: string;
  /** Max private-tracker .torrent files downloaded per search to learn their info-hash (so TorBox can say what is cached). 0 = never. */
  hashLookups?: number;
  /** Longest the search waits for those downloads (ms); the rest finish in the background. Default 3000. */
  lookupWaitMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TORRENT_BYTES = 3 * 1024 * 1024;
const MAX_RESULTS = 15;
// link -> hash (null = the tracker refused). Remembered so the same release is downloaded at most once a day.
const hashCache = new TtlCache<string | null>(2000);
// raw Torznab answers, so repeated opens of the same title (or the same query from different episodes) do not hit the indexer again
const searchCache = new TtlCache<string>(300);
const SEARCH_TTL_MS = 10 * 60_000;
const RES_RANK: Record<string, number> = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };

/** For tests. */
export function resetTorrentHashCache(): void {
  hashCache.clear();
  searchCache.clear();
}

/** Download a .torrent from the index (same origin only) and return its bytes. */
export async function fetchTorrentFile(torrentUrl: string, indexUrl: string, fetchImpl?: FetchLike): Promise<Buffer> {
  if (new URL(torrentUrl).origin !== new URL(indexUrl).origin) throw new Error("torrent link points to a different host than the index");
  const res = await httpRequest(torrentUrl, { label: "Torrent file", timeoutMs: 8_000, retries: 0, fetchImpl });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_TORRENT_BYTES) throw new Error("unexpected torrent file size");
  return buf;
}

/** Torznab (Prowlarr / Jackett) provider: searches only the indexers the user has configured there. */
export class TorznabProvider implements StreamProvider {
  readonly id = "torznab";
  constructor(private readonly cfg: TorznabConfig) {}

  private async fetchXml(params: Record<string, string>): Promise<string> {
    const u = new URL(this.cfg.url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (this.cfg.apiKey) u.searchParams.set("apikey", this.cfg.apiKey);
    // cache key never contains the API key itself
    const key = createHash("sha256").update(this.cfg.url + "|" + (this.cfg.apiKey ?? "")).digest("hex").slice(0, 12) + "|" + new URLSearchParams(params).toString();
    return searchCache.wrap(key, SEARCH_TTL_MS, async () => {
      const res = await httpRequest(u.toString(), { label: "Torznab", timeoutMs: 8_000, retries: 0, fetchImpl: this.cfg.fetchImpl, sleep: this.cfg.sleep });
      return res.text();
    });
  }

  async search(q: StreamQuery): Promise<Release[]> {
    const tag = q.type === "series" && q.season !== undefined && q.episode !== undefined ? ` S${String(q.season).padStart(2, "0")}E${String(q.episode).padStart(2, "0")}` : "";
    const found = new Map<string, RawItem>(); // keyed by hash or download link
    const cat = q.type === "movie" ? "2000" : "5000";
    let attempts = 0;
    let failures = 0;
    let lastError: unknown;
    const run = async (params: Record<string, string>, titleTrusted: boolean) => {
      attempts++;
      try {
        const xml = await this.fetchXml(params);
        for (const r of parseTorznab(xml)) {
          const key = r.infoHash ?? r.torrentUrl ?? r.title;
          const match = matchQuality(r.title, q, { titleTrusted });
          if (match && !found.has(key)) found.set(key, { ...r, match });
        }
      } catch (e) {
        failures++;
        lastError = e;
        log.warn("torznab search failed", { error: e });
      }
    };

    // Private trackers answer one query at a time (~2 s each), so ask as few questions as possible:
    // stage 1 = the title's bare text search (the Arabic title when there is one: Arabic-first trackers index that) plus an IMDb-id lookup;
    // stage 2 only if that did not find what was asked for.
    const arTitle = q.titles.find((t) => hasArabic(t));
    const latTitle = q.titles.find((t) => !hasArabic(t));
    const main = arTitle ?? latTitle ?? q.titles[0];
    if (!main) return [];
    const stage1: Array<Promise<void>> = [];
    if (q.imdbId) {
      const base: Record<string, string> = { t: q.type === "movie" ? "movie" : "tvsearch", imdbid: q.imdbId, cat };
      if (q.type === "series" && q.season !== undefined && q.episode !== undefined) Object.assign(base, { season: String(q.season), ep: String(q.episode) });
      stage1.push(run(base, true));
    }
    stage1.push(run({ t: "search", q: main, cat }, false));
    await Promise.all(stage1);

    const hasExactEpisode = () => [...found.values()].some((r) => { const i = parseRelease(r.title); return i.episode === q.episode && (i.season === q.season || i.season === undefined); });
    const needMore = q.type === "series" ? !hasExactEpisode() : found.size === 0;
    if (needMore) {
      const stage2: Array<Promise<void>> = [];
      // long series: the bare search is capped (~30 results), so ask for the episode itself
      if (q.type === "series" && tag) stage2.push(run({ t: "search", q: main + tag, cat }, false));
      // nothing at all: try the other-language title (and the year for movies)
      if (found.size === 0 && latTitle && latTitle !== main) stage2.push(run({ t: "search", q: `${latTitle}${q.type === "movie" && q.year ? ` ${q.year}` : ""}`, cat }, false));
      await Promise.all(stage2);
    }

    if (found.size === 0 && failures === attempts && lastError) throw lastError;

    const origin = new URL(this.cfg.url).origin;
    const out: TorrentRelease[] = [];
    const seen = new Set<string>();
    for (const i of [...found.values()].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))) {
      // Download links must stay on the index's own host (they are fetched later, with the user's key attached).
      if (!i.infoHash && !(i.torrentUrl && new URL(i.torrentUrl).origin === origin)) continue;
      const id = i.infoHash ?? `${i.title}|${i.size ?? ""}`; // the same upload often appears under several category links
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: "torrent", title: i.title, size: i.size, seeders: i.seeders, indexer: i.indexer, infoHash: i.infoHash, torrentUrl: i.torrentUrl, match: i.match });
    }
    const top = out.slice(0, MAX_RESULTS);

    // Hash lookups for the best few private-tracker releases (best quality first), a handful in parallel, each remembered for a day.
    // A refusal is remembered for 30 minutes so a limited account is not hammered.
    let budget = this.cfg.hashLookups ?? 0;
    const candidates = top.filter((r) => !r.infoHash && r.torrentUrl).sort((a, b) => (RES_RANK[parseRelease(b.title).resolution ?? ""] ?? 0) - (RES_RANK[parseRelease(a.title).resolution ?? ""] ?? 0));
    const toFetch: TorrentRelease[] = [];
    for (const r of candidates) {
      const known = hashCache.get(r.torrentUrl!);
      if (known) r.infoHash = known;
      else if (known === undefined && budget > 0) {
        budget--;
        toFetch.push(r);
      }
    }
    const pending = Promise.all(
      toFetch.map(async (r) => {
        const link = r.torrentUrl!;
        try {
          const hash = infoHashOfTorrent(await fetchTorrentFile(link, this.cfg.url, this.cfg.fetchImpl));
          hashCache.set(link, hash, hash ? 24 * 3600_000 : 30 * 60_000);
          if (hash) r.infoHash = hash;
        } catch (e) {
          log.warn("could not read torrent file", { error: e });
          hashCache.set(link, null, 30 * 60_000);
        }
      }),
    );
    // Do not keep the user waiting on a slow tracker: whatever has not finished is completed in the background (and remembered), so the next open shows it.
    await Promise.race([pending, new Promise<void>((r) => setTimeout(r, this.cfg.lookupWaitMs ?? 3000))]);
    const final = new Set<string>();
    return top.filter((r) => {
      const id = r.infoHash ?? r.torrentUrl ?? r.title;
      return final.has(id) ? false : (final.add(id), true);
    });
  }
}
