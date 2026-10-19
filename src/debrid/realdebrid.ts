import { AddonError } from "../lib/errors.js";
import { httpJson, type FetchLike } from "../lib/http.js";
import { pickFile } from "./files.js";
import type { DebridService, ResolveSource, ResolveTarget } from "./types.js";

const BASE = "https://api.real-debrid.com/rest/1.0";

interface RdInfo {
  id: string;
  status: string; // magnet_error, magnet_conversion, waiting_files_selection, queued, downloading, downloaded, error, virus, compressing, uploading, dead
  progress?: number;
  files?: Array<{ id: number; path: string; bytes: number; selected: number }>;
  links?: string[];
}

/**
 * Real-Debrid (https://api.real-debrid.com). Real-Debrid disabled its instant-availability endpoint in Nov 2024,
 * so there is no reliable cache check: checkCached() returns null and the addon never claims "cached" for RD.
 */
export class RealDebridService implements DebridService {
  readonly id = "realdebrid" as const;
  readonly label = "Real-Debrid";
  readonly short = "RD";
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch, private readonly sleep?: (ms: number) => Promise<void>) {}

  private opts(extra: { method?: string; body?: BodyInit } = {}) {
    return { ...extra, headers: { authorization: `Bearer ${this.apiKey}` }, label: "Real-Debrid", fetchImpl: this.fetchImpl, sleep: this.sleep };
  }

  async checkCached(): Promise<null> {
    return null;
  }

  private async info(id: string): Promise<RdInfo> {
    return httpJson<RdInfo>(`${BASE}/torrents/info/${id}`, this.opts());
  }

  async resolve(infoHash: string, target: ResolveTarget, source: ResolveSource = {}): Promise<{ url: string; filename?: string }> {
    // Reuse the torrent if it is already in the account, otherwise add it.
    const list = await httpJson<Array<{ id: string; hash: string }>>(`${BASE}/torrents?limit=100`, this.opts());
    let id = list.find((t) => t.hash.toLowerCase() === infoHash)?.id;
    if (!id) {
      const added = source.torrentFile
        ? await httpJson<{ id?: string }>(`${BASE}/torrents/addTorrent`, { ...this.opts({ method: "PUT", body: new Uint8Array(source.torrentFile) }), headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/x-bittorrent" } })
        : await httpJson<{ id?: string }>(`${BASE}/torrents/addMagnet`, this.opts({ method: "POST", body: new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${infoHash}` }) }));
      if (!added.id) throw new AddonError("Real-Debrid did not accept the torrent", 502, "upstream_error");
      id = added.id;
    }

    let info = await this.info(id);
    if (info.status === "waiting_files_selection") {
      const file = pickFile((info.files ?? []).map((f) => ({ id: f.id, name: f.path, size: f.bytes })), target);
      if (!file) throw new AddonError("No matching video file found in this release", 404, "no_file");
      await httpJson(`${BASE}/torrents/selectFiles/${id}`, { ...this.opts({ method: "POST", body: new URLSearchParams({ files: String(file.id) }) }) }).catch((e: unknown) => {
        // selectFiles answers 204 No Content, which is not JSON; treat only real errors as failures.
        if (e instanceof AddonError && e.code === "bad_upstream_response") return;
        throw e;
      });
      info = await this.info(id);
    }

    if (["magnet_error", "error", "virus", "dead"].includes(info.status)) throw new AddonError(`Real-Debrid reports this torrent as "${info.status}"`, 502, "upstream_error");
    if (info.status !== "downloaded") {
      const pct = info.progress !== undefined ? ` (${info.progress}%)` : "";
      throw new AddonError(`Real-Debrid is still processing this torrent: ${info.status}${pct}. Try again later.`, 503, "not_ready", 60);
    }

    // links[] lines up with the selected files, in file order.
    const selected = (info.files ?? []).filter((f) => f.selected === 1);
    const wanted = pickFile(selected.map((f) => ({ id: f.id, name: f.path, size: f.bytes })), target);
    const idx = wanted ? selected.findIndex((f) => f.id === wanted.id) : -1;
    const link = idx >= 0 ? info.links?.[idx] : undefined;
    if (!link) throw new AddonError("No matching video file found in this release", 404, "no_file");

    const un = await httpJson<{ download?: string; filename?: string }>(`${BASE}/unrestrict/link`, this.opts({ method: "POST", body: new URLSearchParams({ link }) }));
    if (!un.download || !/^https:\/\//.test(un.download)) throw new AddonError("Real-Debrid did not return a download link", 502, "upstream_error");
    return { url: un.download, filename: un.filename };
  }
}
