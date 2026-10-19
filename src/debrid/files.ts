import { VIDEO_EXT, parseRelease } from "../providers/release.js";
import type { DebridFile, ResolveTarget } from "./types.js";

/** Pick the file to play: the matching episode for series, otherwise the largest video file. */
export function pickFile(files: DebridFile[], target: ResolveTarget): DebridFile | undefined {
  const videos = files.filter((f) => VIDEO_EXT.test(f.name));
  if (videos.length === 0) return undefined;
  const bySize = (a: DebridFile, b: DebridFile) => b.size - a.size;
  if (target.season !== undefined && target.episode !== undefined) {
    const matches = videos.filter((f) => {
      const p = parseRelease(f.name.split("/").pop() ?? f.name);
      // "E05" / "الحلقة 5" with no season means season 1
      return p.episode === target.episode && (p.season === target.season || (p.season === undefined && target.season === 1));
    });
    // Season/episode asked for but not found in the torrent: do not guess a random file.
    return matches.sort(bySize)[0];
  }
  return [...videos].sort(bySize)[0];
}
