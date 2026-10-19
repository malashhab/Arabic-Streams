import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CATALOG_IDS } from "../catalogs/definitions.js";

/**
 * Per-user settings. They are encrypted (AES-256-GCM) into the opaque token that forms part of the
 * install URL, so API keys never appear in plain text in URLs, logs or stream links.
 */
export const userConfigSchema = z.object({
  debrid: z.enum(["none", "torbox", "realdebrid"]).default("none"),
  debridKey: z.string().trim().max(200).optional(),
  tmdbReadToken: z.string().trim().max(2000).optional(),
  torznabUrl: z.string().url().max(500).optional(),
  torznabKey: z.string().trim().max(200).optional(),
  /**
   * Private-tracker releases (from your own Torznab index) come as .torrent files that contain your personal tracker key. By default they are only played
   * when the debrid service ALREADY has them cached (then no file is sent). Turn this on to let the addon upload uncached ones anyway
   * (usually they stall, and many trackers forbid it).
   */
  allowPrivateUpload: z.boolean().default(false),
  /** Catalog ids to show; empty/omitted = all. */
  catalogs: z.array(z.string()).max(60).optional(),
  /** Only keep results that look Arabic (original language ar or Arabic-speaking origin country). */
  arabicOnly: z.boolean().default(true),
  internetArchive: z.boolean().default(true),
  /** Also ask the public Torrentio / Comet addons (by IMDb id only) for releases. Their results are checked on TorBox like any other. */
  torrentio: z.boolean().default(false),
  comet: z.boolean().default(false),
  /** Also list releases that are not confirmed cached (TorBox) / cannot be checked (Real-Debrid). */
  showUncached: z.boolean().default(true),
  /** Season packs that are not confirmed cached would download the whole season (30-50 GB): hidden unless turned off. */
  hidePacks: z.boolean().default(true),
  ramadanYears: z.array(z.number().int().min(1990).max(2100)).max(20).optional(),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

export const DEFAULT_USER_CONFIG: UserConfig = userConfigSchema.parse({});

const PREFIX = "c_";

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptConfig(cfg: UserConfig, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(cfg), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns null when the token is missing, tampered with, or was made with a different secret. */
export function decryptConfig(token: string | undefined, secret: string): UserConfig | null {
  if (!token || !token.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = userConfigSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Short, non-reversible id for a user's credentials; safe for cache keys and logs. */
export function configFingerprint(cfg: UserConfig): string {
  return createHash("sha256").update(JSON.stringify([cfg.debrid, cfg.debridKey, cfg.torznabUrl, cfg.torznabKey])).digest("hex").slice(0, 12);
}

export function enabledCatalogIds(cfg: UserConfig): Set<string> {
  const ids = cfg.catalogs && cfg.catalogs.length ? cfg.catalogs : [...CATALOG_IDS];
  return new Set(ids);
}

// ---- sealed strings: short opaque tokens for values that must travel in a URL (e.g. an index's .torrent link) ----
const SEAL = "t_";

export function sealString(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEAL + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openString(token: string | undefined, secret: string): string | null {
  if (!token || !token.startsWith(SEAL)) return null;
  try {
    const raw = Buffer.from(token.slice(SEAL.length), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
