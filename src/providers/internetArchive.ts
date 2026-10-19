import { bestMatch } from "../arabic/fuzzy.js";
import { httpJson, type FetchLike } from "../lib/http.js";
import { VIDEO_EXT } from "./release.js";
import type { Release, StreamProvider, StreamQuery } from "./types.js";

interface SearchResp {
  response?: { docs?: Array<{ identifier: string; title?: string; year?: string | number }> };
}
interface MetaResp {
  files?: Array<{ name: string; format?: string; size?: string }>;
}

/**
 * Internet Archive (archive.org) public search + download API. No key, no debrid: files are served by the archive
 * directly over HTTPS. Only item titles that closely match the requested title are returned (movies only).
 * Whether a given item may be watched is the archive's/uploader's responsibility; this provider can be switched off.
 */
export class InternetArchiveProvider implements StreamProvider {
  readonly id = "internet-archive";
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly sleep?: (ms: number) => Promise<void>) {}

  async search(q: StreamQuery): Promise<Release[]> {
    if (q.type !== "movie") return [];
    const title = q.titles[0];
    if (!title) return [];
    const safe = title.replace(/["\\()[\]{}:^~*?/]/g, " ").trim();
    if (safe.length < 3) return [];
    const params = new URLSearchParams({ q: `title:("${safe}") AND mediatype:movies`, rows: "8", output: "json" });
    for (const f of ["identifier", "title", "year"]) params.append("fl[]", f);
    const found = await httpJson<SearchResp>(`https://archive.org/advancedsearch.php?${params}`, { label: "Internet Archive", fetchImpl: this.fetchImpl, sleep: this.sleep });
    const out: Release[] = [];
    for (const doc of found.response?.docs ?? []) {
      if (!/^[A-Za-z0-9._-]+$/.test(doc.identifier)) continue;
      if (bestMatch(doc.title ?? "", q.titles) < 0.85) continue;
      if (q.year && doc.year && Math.abs(Number(doc.year) - q.year) > 1) continue;
      const meta = await httpJson<MetaResp>(`https://archive.org/metadata/${doc.identifier}`, { label: "Internet Archive", fetchImpl: this.fetchImpl, sleep: this.sleep }).catch(() => undefined);
      const file = (meta?.files ?? []).filter((f) => VIDEO_EXT.test(f.name) && /mpeg4|h\.264|matroska|webm|ogg video/i.test(f.format ?? "mp4")).sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
      if (!file) continue;
      out.push({
        kind: "direct",
        title: doc.title ?? doc.identifier,
        url: `https://archive.org/download/${doc.identifier}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
        ...(file.size ? { size: Number(file.size) } : {}),
        source: "Internet Archive",
      });
    }
    return out;
  }
}
