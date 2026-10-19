import { z } from "zod";
import { CATALOGS, ramadanYearOptions, yearOptions, type CatalogDef } from "../catalogs/definitions.js";
import type { UserConfig } from "../config/userConfig.js";
import { enabledCatalogIds } from "../config/userConfig.js";

// Schemas follow https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api/responses

const extraSchema = z.object({
  name: z.string(),
  isRequired: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  optionsLimit: z.number().int().positive().optional(),
});

export const manifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  name: z.string().min(1),
  description: z.string().min(1),
  resources: z.array(z.union([z.string(), z.object({ name: z.string(), types: z.array(z.string()), idPrefixes: z.array(z.string()).optional() })])),
  types: z.array(z.string()),
  idPrefixes: z.array(z.string()).optional(),
  catalogs: z.array(z.object({ type: z.string(), id: z.string(), name: z.string(), extra: z.array(extraSchema).optional() })),
  behaviorHints: z.object({ configurable: z.boolean().optional(), configurationRequired: z.boolean().optional(), adult: z.boolean().optional(), p2p: z.boolean().optional() }).optional(),
  logo: z.string().optional(),
  background: z.string().optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const ADDON_VERSION = "1.0.0";

function catalogEntry(def: CatalogDef, cfg: UserConfig, now: Date) {
  switch (def.kind) {
    case "search":
      return { type: def.type, id: def.id, name: def.name, extra: [{ name: "search", isRequired: true }] };
    case "year":
      return { type: def.type, id: def.id, name: def.name, extra: [{ name: "genre", options: yearOptions(now), isRequired: false }, { name: "skip" }] };
    case "ramadan":
      return { type: def.type, id: def.id, name: def.name, extra: [{ name: "genre", options: ramadanYearOptions(now, cfg.ramadanYears), isRequired: false }, { name: "skip" }] };
    default:
      return { type: def.type, id: def.id, name: def.name, extra: [{ name: "skip" }] };
  }
}

/**
 * Stremio has no manifest flag to hide catalogs, so "hideable" is implemented the way the protocol allows:
 * the manifest served for a user's install URL only lists the catalogs they enabled. Users can additionally
 * hide any catalog from Home inside their Stremio client.
 */
export function buildManifest(cfg: UserConfig, opts: { configured: boolean; now?: Date; baseUrl?: string }): Manifest {
  const now = opts.now ?? new Date();
  const enabled = enabledCatalogIds(cfg);
  const manifest: Manifest = {
    id: "community.arabic.streams",
    version: ADDON_VERSION,
    name: "Arabic Movies & Series",
    description: "Arabic-first discovery: latest releases, by year, Ramadan seasons and Saudi/Gulf, Egyptian, Levantine and Maghreb productions, with Arabic and transliterated search. Streams only from sources you configure (TorBox / Real-Debrid with your own indexer, or public-domain Internet Archive).",
    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series"], idPrefixes: ["tmdb:", "tt"] },
      { name: "stream", types: ["movie", "series"], idPrefixes: ["tmdb:", "tt"] },
    ],
    types: ["movie", "series"],
    catalogs: CATALOGS.filter((c) => enabled.has(c.id)).map((c) => catalogEntry(c, cfg, now)),
    behaviorHints: { configurable: true, configurationRequired: false },
    ...(opts.baseUrl ? { logo: `${opts.baseUrl}/logo.svg` } : {}),
  };
  return manifestSchema.parse(manifest);
}
