import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const blank = (v: unknown) => (v === "" ? undefined : v);
const optStr = z.preprocess(blank, z.string().trim().optional());
const optDate = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional());
const optUrl = z.preprocess(blank, z.string().url().optional());

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7100),
  NODE_ENV: z.string().default("development"),
  BASE_URL: optUrl,
  CONFIG_SECRET: optStr,
  TMDB_READ_TOKEN: optStr,
  TORZNAB_URL: optUrl,
  TORZNAB_API_KEY: optStr,
  RAMADAN_2026_START: optDate,
  RAMADAN_2026_END: optDate,
  /** Public Stremio addons that can be used as extra sources. Comet's ElfHosted instance refuses non-debrid use, so another instance is the default. */
  TORRENTIO_URL: z.preprocess(blank, z.string().url().default("https://torrentio.strem.fun")),
  COMET_URL: z.preprocess(blank, z.string().url().default("https://comet.feels.legal")),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(120),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  ALLOW_PRIVATE_INDEXERS: z.preprocess((v) => v === "true" || v === "1", z.boolean()).default(false),
  SECRET_FILE: z.string().default("data/.secret"),
});

export type Env = Omit<z.infer<typeof schema>, "CONFIG_SECRET"> & { CONFIG_SECRET: string };

/** Use CONFIG_SECRET if set; otherwise create and persist a random one so install URLs survive restarts. */
function resolveSecret(explicit: string | undefined, file: string): string {
  if (explicit) {
    if (explicit.length < 16) throw new Error("CONFIG_SECRET must be at least 16 characters");
    return explicit;
  }
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const { CONFIG_SECRET, ...rest } = parsed.data;
  return { ...rest, BASE_URL: rest.BASE_URL?.replace(/\/+$/, ""), CONFIG_SECRET: resolveSecret(CONFIG_SECRET, rest.SECRET_FILE) };
}
