import { AddonError } from "../lib/errors.js";
import { httpJson, type FetchLike } from "../lib/http.js";
import { pickFile } from "./files.js";
import type { DebridFile, DebridService, ResolveSource, ResolveTarget } from "./types.js";

const BASE = "https://api.torbox.app/v1/api";

interface Envelope<T> {
  success?: boolean;
  detail?: string;
  data?: T;
}
interface TbTorrent {
  id: number;
  download_finished?: boolean;
  download_present?: boolean;
  progress?: number;
  download_state?: string;
  files?: Array<{ id: number; name: string; short_name?: string; size: number }>;
}

/** TorBox (https://api-docs.torbox.app): checkcached, createtorrent, mylist, requestdl. */
export class TorBoxService implements DebridService {
  readonly id = "torbox" as const;
  readonly label = "TorBox";
  readonly short = "TB";
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch, private readonly sleep?: (ms: number) => Promise<void>) {}

  private opts(extra: { method?: string; body?: BodyInit } = {}) {
    return { ...extra, headers: { authorization: `Bearer ${this.apiKey}` }, label: "TorBox", fetchImpl: this.fetchImpl, sleep: this.sleep };
  }

  async checkCached(hashes: string[]): Promise<Map<string, DebridFile[]>> {
    const cached = new Map<string, DebridFile[]>();
    for (let i = 0; i < hashes.length; i += 50) {
      const chunk = hashes.slice(i, i + 50);
      const r = await httpJson<Envelope<Record<string, { files?: Array<{ id?: number; name?: string; size?: number }> }> | unknown[] | false | null>>(
        `${BASE}/torrents/checkcached?hash=${chunk.join(",")}&format=object&list_files=true`,
        this.opts(),
      );
      const data = r.data;
      // Object format: cached hashes appear as keys; uncached ones are absent. Anything else means "nothing confirmed cached".
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [h, v] of Object.entries(data)) {
          const files = Array.isArray(v?.files) ? v.files.map((f, idx) => ({ id: f.id ?? idx, name: String(f.name ?? ""), size: Number(f.size ?? 0) })) : [];
          cached.set(h.toLowerCase(), files);
        }
      }
    }
    return cached;
  }

  async resolve(infoHash: string, target: ResolveTarget, source: ResolveSource = {}): Promise<{ url: string; filename?: string }> {
    const form = new FormData();
    if (source.torrentFile) form.set("file", new Blob([new Uint8Array(source.torrentFile)], { type: "application/x-bittorrent" }), `${infoHash}.torrent`);
    else form.set("magnet", `magnet:?xt=urn:btih:${infoHash}`);
    form.set("seed", "1");
    form.set("allow_zip", "false");
    const created = await httpJson<Envelope<{ torrent_id?: number; id?: number }>>(`${BASE}/torrents/createtorrent`, this.opts({ method: "POST", body: form }));
    const id = created.data?.torrent_id ?? created.data?.id;
    if (!created.success || !id) throw new AddonError("TorBox did not accept the torrent", 502, "upstream_error");

    const info = await httpJson<Envelope<TbTorrent>>(`${BASE}/torrents/mylist?id=${id}&bypass_cache=true`, this.opts());
    const t = info.data;
    if (!t || !(t.download_finished || t.download_present)) {
      const pct = t?.progress !== undefined ? ` (${Math.round(t.progress * 100)}%)` : "";
      throw new AddonError(`Not cached on TorBox: the download was queued in your account${pct}. Try again later.`, 503, "not_ready", 60);
    }
    const files = (t.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size }));
    const file = pickFile(files, target);
    if (!file) throw new AddonError("No matching video file found in this release", 404, "no_file");

    const dl = await httpJson<Envelope<string>>(`${BASE}/torrents/requestdl?token=${encodeURIComponent(this.apiKey)}&torrent_id=${id}&file_id=${file.id}&zip_link=false`, this.opts());
    if (!dl.success || typeof dl.data !== "string" || !/^https:\/\//.test(dl.data)) throw new AddonError("TorBox did not return a download link", 502, "upstream_error");
    return { url: dl.data, filename: file.name };
  }
}
