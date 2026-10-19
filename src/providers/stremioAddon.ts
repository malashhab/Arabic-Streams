import { httpJson, type FetchLike } from "../lib/http.js";
import { matchQuality } from "./torznab.js";
import type { Release, StreamProvider, StreamQuery } from "./types.js";

interface AddonStream {
  name?: string;
  title?: string;
  description?: string;
  infoHash?: string;
  behaviorHints?: { filename?: string; videoSize?: number };
}

const UNIT = { kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 } as const;

/** "💾 1.09 GB" -> bytes */
function sizeOf(text: string): number | undefined {
  const m = text.match(/💾\s*([\d.]+)\s*(KB|MB|GB|TB)/i);
  return m ? Math.round(Number(m[1]) * UNIT[m[2]!.toLowerCase() as keyof typeof UNIT]) : undefined;
}

/**
 * Another Stremio addon (Torrentio, Comet, ...) used as a source. Its stream endpoint is public and takes only the IMDb id,
 * so no key or personal data leaves this server. Only results with an info-hash are used: those can be checked on TorBox.
 */
export class StremioAddonProvider implements StreamProvider {
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async search(q: StreamQuery): Promise<Release[]> {
    if (!q.imdbId) return [];
    const vid = q.type === "series" && q.season !== undefined && q.episode !== undefined ? `${q.imdbId}:${q.season}:${q.episode}` : q.imdbId;
    const data = await httpJson<{ streams?: AddonStream[] }>(`${this.baseUrl.replace(/\/+$/, "")}/stream/${q.type}/${vid}.json`, {
      label: this.id,
      timeoutMs: 15000,
      retries: 1,
      headers: { "user-agent": "Mozilla/5.0 (compatible; ArabicStreamsAddon)" },
      fetchImpl: this.opts.fetchImpl,
      sleep: this.opts.sleep,
    });
    const out: Release[] = [];
    for (const s of data.streams ?? []) {
      const hash = s.infoHash?.toLowerCase();
      if (!hash || !/^[a-f0-9]{40}$/.test(hash)) continue;
      const text = s.title ?? s.description ?? "";
      // Torrentio: "Release name\n👤 12 💾 1 GB ⚙️ Site"; Comet: "📄 file name\n... 👤 12 💾 1 GB 🔎 Site"
      const first = text.split("\n")[0]?.replace(/^📄\s*/, "").trim();
      const title = s.behaviorHints?.filename || first;
      if (!title) continue;
      const match = matchQuality(title, q, { titleTrusted: true });
      if (!match) continue;
      const seeders = text.match(/👤\s*(\d+)/)?.[1];
      const site = text.match(/(?:⚙|🔎)️?\s*([^\n]+)$/u)?.[1]?.trim();
      const size = s.behaviorHints?.videoSize ?? sizeOf(text);
      out.push({
        kind: "torrent",
        infoHash: hash,
        title,
        match,
        indexer: site ? `${this.id} · ${site}` : this.id,
        ...(size ? { size } : {}),
        ...(seeders ? { seeders: Number(seeders) } : {}),
      });
    }
    return out;
  }
}
