import express, { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import { CATALOGS, findCatalog } from "../catalogs/definitions.js";
import { CatalogService, type CatalogExtra } from "../catalogs/service.js";
import { DEFAULT_USER_CONFIG, decryptConfig, encryptConfig, openString, userConfigSchema, type UserConfig } from "../config/userConfig.js";
import type { Env } from "../config/env.js";
import { AddonError } from "../lib/errors.js";
import { httpRequest, type FetchLike } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { assertSafeUserUrl } from "../lib/ssrf.js";
import { parseId } from "../metadata/ids.js";
import { looksArabic, toMeta } from "../metadata/mapper.js";
import { ARAB_COUNTRIES } from "../catalogs/definitions.js";
import { TmdbClient, type TmdbEpisode } from "../metadata/tmdb.js";
import { buildManifest } from "../protocol/manifest.js";
import { catalogResponseSchema, metaResponseSchema, streamResponseSchema } from "../protocol/responses.js";
import { createDebrid, getStreams } from "../streams/service.js";
import { infoHashOfTorrent } from "../lib/torrent.js";
import { fetchTorrentFile } from "../providers/torznab.js";
import { LOGO_SVG, configurePage } from "./configurePage.js";

export interface AppContext {
  env: Env;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const TOKEN_ROUTE = "/:token(c_[A-Za-z0-9_-]{20,})";

export function createApp(ctx: AppContext): express.Express {
  const { env } = ctx;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(express.json({ limit: "16kb" }));

  // Stremio web / other clients fetch from a different origin.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => log.info("request", { method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Date.now() - started }));
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, limit: env.RATE_LIMIT_PER_MINUTE, standardHeaders: true, legacyHeaders: false }));

  // ---- shared clients -------------------------------------------------------------------
  const sharedTmdb = new TmdbClient(env.TMDB_READ_TOKEN, ctx.fetchImpl, ctx.sleep);
  const userTmdb = new Map<string, TmdbClient>();
  const tmdbFor = (cfg: UserConfig): TmdbClient => {
    if (!cfg.tmdbReadToken) return sharedTmdb;
    const key = createHash("sha256").update(cfg.tmdbReadToken).digest("hex");
    let c = userTmdb.get(key);
    if (!c) {
      if (userTmdb.size >= 50) userTmdb.delete(userTmdb.keys().next().value!);
      c = new TmdbClient(cfg.tmdbReadToken, ctx.fetchImpl, ctx.sleep);
      userTmdb.set(key, c);
    }
    return c;
  };
  const catalogService = (cfg: UserConfig) =>
    new CatalogService(tmdbFor(cfg), { ramadanOverrides: { start: env.RAMADAN_2026_START, end: env.RAMADAN_2026_END }, now: ctx.now });

  const baseUrlOf = (req: Request): string => {
    if (env.BASE_URL) return env.BASE_URL;
    const host = req.get("host") ?? "";
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new AddonError("Bad Host header", 400, "bad_request");
    return `${req.protocol}://${host}`;
  };

  /** Config from the (optional) token in the path. A token that does not decrypt is rejected, never silently defaulted. */
  const configOf = (req: Request): { cfg: UserConfig; token?: string } => {
    const token = req.params.token;
    if (!token) return { cfg: DEFAULT_USER_CONFIG };
    const cfg = decryptConfig(token, env.CONFIG_SECRET);
    if (!cfg) throw new AddonError("This install URL is invalid or was created with a different server secret. Please re-install.", 400, "invalid_config");
    return { cfg, token };
  };

  const router = Router({ mergeParams: true });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);
  const json = (res: Response, body: unknown, maxAge: number) => {
    res.setHeader("Cache-Control", maxAge > 0 ? `public, max-age=${maxAge}` : "no-store");
    res.json(body);
  };

  router.get("/manifest.json", wrap(async (req, res) => {
    const { cfg } = configOf(req);
    json(res, buildManifest(cfg, { configured: !!req.params.token, now: ctx.now?.(), baseUrl: baseUrlOf(req) }), 300);
  }));

  const extraOf = (req: Request): CatalogExtra => {
    // Read the raw segment so an encoded "&" inside a search term is not mistaken for a separator.
    const m = req.originalUrl.split("?")[0]!.match(/\/catalog\/[^/]+\/[^/]+\/(.+)\.json$/);
    const out: CatalogExtra = {};
    for (const pair of (m?.[1] ?? "").split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      let k: string, v: string;
      try {
        k = decodeURIComponent(pair.slice(0, eq));
        v = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        throw new AddonError("Bad request", 400, "bad_request");
      }
      if (k === "genre") out.genre = v.slice(0, 20);
      else if (k === "search") out.search = v;
      else if (k === "skip") out.skip = /^\d{1,5}$/.test(v) ? Number(v) : 0;
    }
    return out;
  };

  const catalogHandler = wrap(async (req, res) => {
    const { cfg } = configOf(req);
    const def = findCatalog(String(req.params.id), String(req.params.type));
    if (!def) throw new AddonError("Unknown catalog", 404, "not_found");
    const extra = extraOf(req);
    if (def.kind === "search" && !extra.search) throw new AddonError("search is required", 400, "bad_request");
    const result = await catalogService(cfg).getCatalog(def, extra, { arabicOnly: cfg.arabicOnly });
    const body = catalogResponseSchema.parse({ metas: result.metas, cacheMaxAge: result.cacheMaxAge });
    json(res, body, result.cacheMaxAge);
  });
  router.get("/catalog/:type/:id.json", catalogHandler);
  router.get("/catalog/:type/:id/:extra.json", catalogHandler);

  router.get("/meta/:type/:id.json", wrap(async (req, res) => {
    const { cfg } = configOf(req);
    const parsed0 = parseId(String(req.params.id));
    if (!parsed0 || (parsed0.kind === "imdb" && (parsed0.season !== undefined))) throw new AddonError("Unknown id", 404, "not_found");
    const tmdb = tmdbFor(cfg);
    let parsed: { type: "movie" | "series"; tmdbId: number };
    if (parsed0.kind === "tmdb") parsed = parsed0;
    else {
      const found = await tmdb.findByImdb(parsed0.imdbId);
      if (!found) throw new AddonError("Unknown id", 404, "not_found");
      parsed = { type: found.type, tmdbId: found.id };
    }
    const [d, en] = await Promise.all([tmdb.details(parsed.type, parsed.tmdbId, "ar-SA"), tmdb.details(parsed.type, parsed.tmdbId, "en-US").catch(() => undefined)]);
    const episodes = new Map<number, TmdbEpisode[]>();
    if (parsed.type === "series") {
      const seasons = (d.seasons ?? []).filter((s) => s.season_number > 0).slice(0, 40);
      const results = await Promise.all(seasons.map((s) => tmdb.season(parsed.tmdbId, s.season_number, "ar-SA").catch(() => undefined)));
      seasons.forEach((s, i) => results[i] && episodes.set(s.season_number, results[i]!.episodes));
    }
    // IMDb ids can be any title in the world: stay out of the way (404 -> client falls back to its default meta addon) unless Arabic.
    if (parsed0.kind === "imdb" && cfg.arabicOnly && !looksArabic(d, ARAB_COUNTRIES)) throw new AddonError("Not an Arabic title", 404, "not_found");
    const meta = toMeta(d, parsed.type, episodes, en?.overview, parsed0.kind === "imdb");
    json(res, metaResponseSchema.parse({ meta, cacheMaxAge: 86400 }), 86400);
  }));

  router.get("/stream/:type/:id.json", wrap(async (req, res) => {
    const { cfg, token } = configOf(req);
    const type = req.params.type === "movie" ? "movie" : req.params.type === "series" ? "series" : null;
    if (!type) throw new AddonError("Unknown type", 404, "not_found");
    // Without a token there are no credentials, so no resolve links are ever produced.
    const streams = await getStreams(String(req.params.id), type, token ? cfg : { ...cfg, debrid: "none" }, {
      tmdb: tmdbFor(cfg),
      fetchImpl: ctx.fetchImpl,
      sleep: ctx.sleep,
      defaultTorznab: env.TORZNAB_URL ? { url: env.TORZNAB_URL, apiKey: env.TORZNAB_API_KEY } : undefined,
      allowPrivateIndexers: env.ALLOW_PRIVATE_INDEXERS,
      baseUrl: baseUrlOf(req),
      token: token ?? "",
      secret: env.CONFIG_SECRET,
      externalAddons: { torrentio: env.TORRENTIO_URL, comet: env.COMET_URL },
    });
    // User-specific links: never cache in shared caches.
    res.setHeader("Cache-Control", "private, no-store");
    res.json(streamResponseSchema.parse({ streams }));
  }));

  const resolveLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const resolveHandler = wrap(async (req, res) => {
    const { cfg, token } = configOf(req);
    if (!token) throw new AddonError("Missing configuration", 400, "invalid_config");
    const hashParam = String(req.params.hash).toLowerCase();
    // "file" = private-tracker release: the hash is read from the .torrent downloaded just now (once, on click)
    if (hashParam !== "file" && !/^[a-f0-9]{40}$/.test(hashParam)) throw new AddonError("Bad hash", 400, "bad_request");
    const season = req.params.season === undefined ? undefined : Number(req.params.season);
    const episode = req.params.episode === undefined ? undefined : Number(req.params.episode);
    if ([season, episode].some((n) => n !== undefined && !Number.isInteger(n))) throw new AddonError("Bad season/episode", 400, "bad_request");
    const debrid = createDebrid(cfg, ctx.fetchImpl, ctx.sleep);
    if (!debrid) throw new AddonError("No debrid service is configured. Open the addon settings and add your API key.", 400, "no_credentials");
    // Private trackers: the release has no magnet, so fetch the .torrent from the user's own index and hand the file over.
    let torrentFile: Buffer | undefined;
    const sealed = typeof req.query.t === "string" ? req.query.t : undefined;
    const privateRelease = !!sealed;
    // Hash already known and uploads are not allowed: the file is never needed, so it is not downloaded (that would spend a daily tracker download).
    if (sealed && (hashParam === "file" || cfg.allowPrivateUpload)) {
      const link = openString(sealed, env.CONFIG_SECRET);
      const indexUrl = cfg.torznabUrl ?? env.TORZNAB_URL;
      if (!link) throw new AddonError("Invalid download link", 400, "bad_request");
      try {
        if (indexUrl) torrentFile = await fetchTorrentFile(link, indexUrl, ctx.fetchImpl);
        else throw new AddonError("Invalid download link", 400, "bad_request");
      } catch (e) {
        if (e instanceof AddonError && (e.code === "invalid_credentials" || e.code === "manual_verification" || e.code === "bad_request")) throw e;
        log.warn("torrent file fetch failed", { error: e });
        throw new AddonError("Could not download the .torrent from your index (is Prowlarr running?)", 502, "upstream_error");
      }
    }
    let hash = hashParam;
    if (hashParam === "file") {
      const h = torrentFile && infoHashOfTorrent(torrentFile);
      if (!h) throw new AddonError("The index did not return a valid .torrent file (it may be refusing downloads: check your account/limits on the tracker)", 502, "upstream_error");
      hash = h;
    } else if (torrentFile && infoHashOfTorrent(torrentFile) !== hash) throw new AddonError("The torrent on the index changed; search again", 409, "mismatch");
    // Private-tracker release (we hold its .torrent, which contains the member's tracker key): play it only if the debrid service
    // already has it cached, and then WITHOUT sending the file. Uploading an uncached one usually stalls and is often against tracker rules.
    if (privateRelease && !cfg.allowPrivateUpload) {
      const cached = debrid.id === "torbox" ? await debrid.checkCached([hash]) : null;
      if (!cached || !cached.has(hash)) {
        const pack = req.query.pk === "1" ? " It is also a whole-season pack." : "";
        const why = debrid.id === "torbox" ? "TorBox does not have this release cached." : "Real-Debrid cannot tell whether this release is cached.";
        throw new AddonError(`${why} It comes from a private tracker, so uploading it would hand your tracker key to the debrid service and usually stalls.${pack} Try a release that shows ⚡ Cached, or allow uploads in the addon settings (not recommended).`, 409, "not_cached_private");
      }
      torrentFile = undefined; // cached: resolve by hash alone, the file stays on this server
    }
    // A season pack that TorBox does not have cached would make it download the whole season (30-50 GB): check first.
    if (req.query.pk === "1" && cfg.hidePacks && debrid.id === "torbox") {
      const cached = await debrid.checkCached([hash]);
      if (cached && !cached.has(hash)) {
        throw new AddonError("This is a whole-season pack and TorBox does not have it cached, so playing it would download the entire season. Choose a single-episode release, or untick 'Hide season packs that are not cached' in the addon settings.", 409, "pack_not_cached");
      }
    }
    const { url } = await debrid.resolve(hash, { season, episode }, { torrentFile });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, url);
  });
  router.get("/resolve/:hash", resolveLimiter, resolveHandler);
  router.get("/resolve/:hash/:season/:episode", resolveLimiter, resolveHandler);

  app.use(TOKEN_ROUTE, router);
  app.use("/", router);

  // ---- landing / configure / health -------------------------------------------------------
  app.get("/health", (_req, res) => void res.json({ status: "ok", tmdbConfigured: sharedTmdb.configured }));
  app.get(["/", "/configure", `${TOKEN_ROUTE}/configure`], (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    res.send(configurePage(CATALOGS.filter((c) => c.kind !== "search")));
  });

  const configLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  app.post("/api/config", configLimiter, wrap(async (req, res) => {
    const parsed = userConfigSchema.safeParse(req.body);
    if (!parsed.success) throw new AddonError("Invalid settings: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "), 400, "bad_request");
    const cfg = parsed.data;
    if (cfg.debrid !== "none" && !cfg.debridKey) throw new AddonError("Enter your API key for the selected debrid service", 400, "bad_request");
    if (cfg.torznabUrl) await assertSafeUserUrl(cfg.torznabUrl, env.ALLOW_PRIVATE_INDEXERS);
    const token = encryptConfig(cfg, env.CONFIG_SECRET);
    const base = baseUrlOf(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ manifestUrl: `${base}/${token}/manifest.json`, stremioUrl: `${base.replace(/^https?/, "stremio")}/${token}/manifest.json` });
  }));

  // "Test" buttons on the settings page. Secrets travel in the POST body only and are never logged.
  app.post("/api/test", configLimiter, wrap(async (req, res) => {
    const kind = String(req.body?.kind ?? "");
    const key = typeof req.body?.key === "string" ? req.body.key.trim().slice(0, 200) : "";
    const opts = (headers?: Record<string, string>) => ({ headers, label: kind, timeoutMs: 8000, retries: 0, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
    const explain = (e: unknown): never => {
      if (e instanceof AddonError && e.code === "unauthorized") throw new AddonError("The service rejected this key", 400, "bad_request");
      if (e instanceof AddonError && e.code === "rate_limited") throw new AddonError("Rate limited by the service, try again in a minute", 400, "bad_request");
      if (e instanceof AddonError && e.status < 500) throw e;
      throw new AddonError("Could not reach the service", 400, "bad_request");
    };
    res.setHeader("Cache-Control", "no-store");
    if (kind === "torbox" || kind === "realdebrid") {
      if (!key) throw new AddonError("Enter the API key first", 400, "bad_request");
      const url = kind === "torbox" ? "https://api.torbox.app/v1/api/user/me" : "https://api.real-debrid.com/rest/1.0/user";
      try {
        await httpRequest(url, opts({ authorization: `Bearer ${key}` }));
      } catch (e) {
        explain(e);
      }
      return void res.json({ ok: true, message: `${kind === "torbox" ? "TorBox" : "Real-Debrid"} key accepted` });
    }
    if (kind === "torznab") {
      const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (!raw) throw new AddonError("Enter the Torznab URL first", 400, "bad_request");
      const url = await assertSafeUserUrl(raw, env.ALLOW_PRIVATE_INDEXERS);
      url.searchParams.set("t", "caps");
      if (key) url.searchParams.set("apikey", key);
      let body = "";
      try {
        body = await (await httpRequest(url.toString(), opts())).text();
      } catch (e) {
        explain(e);
      }
      if (!/<caps[\s>]/i.test(body)) throw new AddonError("That URL answered, but not like a Torznab index", 400, "bad_request");
      return void res.json({ ok: true, message: "Torznab index reachable" });
    }
    throw new AddonError("Choose a debrid service first", 400, "bad_request");
  }));

  app.get("/logo.svg", (_req, res) => {
    res.type("image/svg+xml").setHeader("Cache-Control", "public, max-age=86400");
    res.send(LOGO_SVG);
  });

  app.use((_req, res) => void res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    if (err instanceof AddonError) {
      if (err.status >= 500) log.warn("request failed", { path: req.path, code: err.code, error: err });
      if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
      const wantsText = req.path.includes("/resolve/");
      return void (wantsText ? res.status(err.status).type("text/plain").send(err.message) : res.status(err.status).json({ error: err.code, message: err.message }));
    }
    if (err instanceof Error && err.name === "ZodError") {
      log.error("response failed schema validation", { path: req.path, error: err });
      return void res.status(502).json({ error: "bad_response", message: "Upstream data could not be converted" });
    }
    log.error("unhandled error", { path: req.path, error: err });
    res.status(500).json({ error: "internal_error", message: "Something went wrong" });
  });

  return app;
}
