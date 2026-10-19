import { pickFile } from "../debrid/files.js";
import type { DebridFile, DebridService } from "../debrid/types.js";
import { RealDebridService } from "../debrid/realdebrid.js";
import { TorBoxService } from "../debrid/torbox.js";
import { sealString, type UserConfig } from "../config/userConfig.js";
import { AddonError } from "../lib/errors.js";
import type { FetchLike } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { assertSafeUserUrl } from "../lib/ssrf.js";
import { looksArabic, originalTitleOf, titleOf, yearOf } from "../metadata/mapper.js";
import { ARAB_COUNTRIES } from "../catalogs/definitions.js";
import { parseId, type ParsedId } from "../metadata/ids.js";
import type { TmdbClient } from "../metadata/tmdb.js";
import type { MediaType } from "../catalogs/definitions.js";
import { InternetArchiveProvider } from "../providers/internetArchive.js";
import { formatSize, parseRelease } from "../providers/release.js";
import { StremioAddonProvider } from "../providers/stremioAddon.js";
import { TorznabProvider } from "../providers/torznab.js";
import type { Release, StreamProvider, StreamQuery, TorrentRelease } from "../providers/types.js";
import type { Stream } from "../protocol/responses.js";

export interface StreamDeps {
  tmdb: TmdbClient;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Server-wide default indexer (operator-controlled, trusted). */
  defaultTorznab?: { url: string; apiKey?: string };
  allowPrivateIndexers?: boolean;
  /** Public base URL of this addon, used for resolve links and the "fix your settings" link. */
  baseUrl: string;
  /** The opaque encrypted config token from the request path. */
  token: string;
  /** Server secret, used to seal private download links into resolve URLs. */
  secret: string;
  /** Base URLs of the public addons used for the torrentio / comet options. */
  externalAddons?: { torrentio?: string; comet?: string };
}

export function createDebrid(cfg: UserConfig, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>): DebridService | null {
  if (cfg.debrid === "none" || !cfg.debridKey) return null;
  return cfg.debrid === "torbox" ? new TorBoxService(cfg.debridKey, fetchImpl, sleep) : new RealDebridService(cfg.debridKey, fetchImpl, sleep);
}

/** Work out what to search for from a Stremio id, using TMDB metadata only. */
export async function buildQuery(id: ParsedId, type: MediaType, tmdb: TmdbClient, arabicOnly = false): Promise<StreamQuery | null> {
  let tmdbType: MediaType;
  let tmdbId: number;
  if (id.kind === "tmdb") {
    tmdbType = id.type;
    tmdbId = id.tmdbId;
  } else {
    const found = await tmdb.findByImdb(id.imdbId);
    if (!found) return null;
    tmdbType = found.type;
    tmdbId = found.id;
  }
  if (tmdbType !== type) return null;
  const [ar, en] = await Promise.all([tmdb.details(tmdbType, tmdbId, "ar-SA"), tmdb.details(tmdbType, tmdbId, "en-US").catch(() => undefined)]);
  if (arabicOnly && id.kind === "imdb" && !looksArabic(ar, ARAB_COUNTRIES)) return null;
  const titles = [...new Set([en && titleOf(en), originalTitleOf(ar), titleOf(ar)].filter((t): t is string => !!t))];
  const imdbId = id.kind === "imdb" ? id.imdbId : ar.external_ids?.imdb_id || undefined;
  return { type: tmdbType, titles, year: yearOf(ar), imdbId, season: id.season, episode: id.episode };
}

const RES_ORDER = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 } as const;

type CacheState = "cached" | "not-cached" | "unknown";

const RES_LABEL: Record<string, string> = { "2160p": "💎 4K", "1080p": "🚀 1080p", "720p": "📺 720p", "480p": "📼 480p" };

/** Card layout: header in "name", details in "description" (works in Stremio and Stremio-compatible clients). */
function card(r: TorrentRelease, state: CacheState, short: string, episodeFile?: DebridFile, isPack = false): { name: string; description: string } {
  const p = parseRelease(r.title);
  const stateIcon = state === "cached" ? "⚡" : state === "not-cached" ? "⏳" : "❔";
  const stateText = state === "cached" ? "Cached" : state === "not-cached" ? "Not cached" : "Cache unknown";
  const total = formatSize(r.size);
  const file = formatSize(episodeFile?.size);
  const lines = [
    r.title,
    [isPack ? "📚 Season pack" : "", p.source ? "🎬 " + p.source : "", p.codec ? p.codec : "", p.hdr ? "HDR" : ""].filter(Boolean).join(" · "),
    [total ? "📦 " + (file ? file + " / " : "") + total : "", r.seeders ? "👤 " + r.seeders : ""].filter(Boolean).join(" • "),
    r.warning ? "⚠️ " + r.warning : "",
    "📡 " + (r.indexer ?? "Index") + " • 🔍 Arabic Addon" + (r.match === "exact" ? " • ✅ Exact" : r.match === "likely" ? " • ⚠️ Possible match" : ""),
    `${stateIcon} ${stateText} (${short})`,
  ].filter(Boolean);
  return { name: `${RES_LABEL[p.resolution ?? ""] ?? "❔ Unknown"} | ${stateIcon} ${short}`, description: lines.join("\n") };
}

export async function getStreams(id: string, type: MediaType, cfg: UserConfig, deps: StreamDeps): Promise<Stream[]> {
  const parsed = parseId(id);
  if (!parsed) return [];
  const query = await buildQuery(parsed, type, deps.tmdb, cfg.arabicOnly);
  if (!query) return [];

  const providers: StreamProvider[] = [];
  const indexer = cfg.torznabUrl ? { url: cfg.torznabUrl, apiKey: cfg.torznabKey, user: true } : deps.defaultTorznab ? { ...deps.defaultTorznab, user: false } : undefined;
  if (indexer) {
    if (indexer.user) await assertSafeUserUrl(indexer.url, !!deps.allowPrivateIndexers);
    // Only TorBox can say what is cached, so only then is it worth reading a few .torrent files to learn their hashes.
    const hashLookups = cfg.debrid === "torbox" && cfg.debridKey ? 3 : 0;
    providers.push(new TorznabProvider({ url: indexer.url, apiKey: indexer.apiKey, hashLookups, fetchImpl: deps.fetchImpl, sleep: deps.sleep }));
  }
  const ext = { fetchImpl: deps.fetchImpl, sleep: deps.sleep };
  if (cfg.torrentio && deps.externalAddons?.torrentio) providers.push(new StremioAddonProvider("Torrentio", deps.externalAddons.torrentio, ext));
  if (cfg.comet && deps.externalAddons?.comet) providers.push(new StremioAddonProvider("Comet", deps.externalAddons.comet, ext));
  if (cfg.internetArchive) providers.push(new InternetArchiveProvider(deps.fetchImpl, deps.sleep));

  const noIndexer = !indexer;
  const settled = await Promise.allSettled(providers.map((p) => p.search(query)));
  const releases: Release[] = [];
  const notices: Stream[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      for (const r of s.value) {
        if (r.kind === "notice") notices.push(notice(deps, `⚠️ ${providers[i]?.id}`, r.message));
        else releases.push(r);
      }
    }
    else {
      log.warn("provider failed", { provider: providers[i]?.id, error: s.reason });
      if (s.reason instanceof AddonError) {
        const name = String(providers[i]?.id);
        const say: Record<string, string> = {
          rate_limited: "Rate limited, try again in a minute",
        };
        const msg = say[s.reason.code];
        if (msg) notices.push(notice(deps, `⚠️ ${name}`, msg));
      }
    }
  });

  const streams: Stream[] = [];

  // Directly playable public files need nothing from the user.
  for (const r of releases) {
    if (r.kind !== "direct") continue;
    const size = formatSize(r.size);
    streams.push({ url: r.url, name: r.source, title: `${r.title}${size ? `\n${size}` : ""}`, behaviorHints: { notWebReady: false } });
  }

  // The same upload can come from two sources (e.g. a Torznab index and Torrentio): keep one, preferring the surer match.
  const byKey = new Map<string, TorrentRelease>();
  for (const r of releases) {
    if (r.kind !== "torrent") continue;
    const key = r.infoHash ?? `${r.title.toLowerCase()}|${r.size ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || (prev.match !== "exact" && r.match === "exact") || (!prev.infoHash && r.infoHash)) byKey.set(key, r);
  }
  const torrents = [...byKey.values()];
  if (torrents.length > 0) {
    const debrid = createDebrid(cfg, deps.fetchImpl, deps.sleep);
    if (!debrid) {
      notices.push(notice(deps, "⚠️ Debrid needed", `${torrents.length} release(s) found. Add your TorBox or Real-Debrid key in the addon settings to play them.`));
    } else {
      let cached: Map<string, DebridFile[]> | null = null;
      let failed = false;
      try {
        cached = await debrid.checkCached(torrents.map((t) => t.infoHash).filter((h): h is string => !!h));
      } catch (e) {
        failed = true;
        log.warn("debrid cache check failed", { service: debrid.id, error: e });
        const ae = e instanceof AddonError ? e : undefined;
        notices.push(
          notice(deps, `⚠️ ${debrid.label}`, ae?.code === "unauthorized" ? "API key rejected - check it in the addon settings" : ae?.code === "rate_limited" ? "Rate limited by the provider, try again shortly" : "Could not check availability right now"),
        );
      }
      if (!failed) {
        const wantsEpisode = parsed.season !== undefined;
        const packOf = (t: TorrentRelease) => wantsEpisode && !!parseRelease(t.title).pack;
        // cached first, then single-episode releases before season packs, then by quality
        const rank = (t: TorrentRelease) => (t.infoHash && cached?.has(t.infoHash) ? 100 : 0) + (packOf(t) ? 0 : 30) + (RES_ORDER[parseRelease(t.title).resolution ?? "480p"] ?? 0) * 5 + Math.min(t.seeders ?? 0, 9) / 10;
        for (const t of [...torrents].sort((a, b) => rank(b) - rank(a))) {
          const isCached = !!t.infoHash && cached?.has(t.infoHash) === true;
          // Private-tracker releases have no hash yet, so they cannot be checked; Real-Debrid has no check at all. Never claimed.
          const checkable = cached !== null && !!t.infoHash;
          if (checkable && !isCached && !cfg.showUncached) continue;
          // A season pack that is not confirmed cached would make the debrid service download the whole season.
          const pack = packOf(t);
          if (pack && cfg.hidePacks && checkable && !isCached) continue; // unknown ones are checked at click time instead
          const state: CacheState = isCached ? "cached" : checkable ? "not-cached" : "unknown";
          const episodeFile = isCached && t.infoHash ? pickFile(cached?.get(t.infoHash) ?? [], { season: parsed.season, episode: parsed.episode }) : undefined;
          const tail = parsed.season !== undefined ? `/${parsed.season}/${parsed.episode}` : "";
          streams.push({
            url: (() => {
              const q = new URLSearchParams();
              if (t.torrentUrl && !isCached) q.set("t", sealString(t.torrentUrl, deps.secret));
              if (pack && cfg.hidePacks && !isCached) q.set("pk", "1"); // season pack: verify it is cached on TorBox before uploading it
              const qs = q.toString();
              return `${deps.baseUrl}/${deps.token}/resolve/${t.infoHash ?? "file"}${tail}${qs ? `?${qs}` : ""}`;
            })(),
            ...card(t, state, debrid.short, episodeFile, pack),
            behaviorHints: { bingeGroup: `arabic-${debrid.id}-${parseRelease(t.title).resolution ?? "any"}`, videoSize: t.size },
          });
        }
      }
    }
  }
  // Explain an empty result instead of leaving the user guessing.
  if (noIndexer && torrents.length === 0) {
    notices.push(notice(deps, "ℹ️ No release source", "No torrent index (Torznab / Prowlarr) is set up, so only public Internet Archive files can be found. Open settings to add one."));
  }
  return [...streams, ...notices];
}

function notice(deps: StreamDeps, name: string, message: string): Stream {
  return { name, description: message, externalUrl: `${deps.baseUrl}/configure` };
}
