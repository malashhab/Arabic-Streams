// Parsing facts out of release names. Quality is only reported when the release name actually says so.

export interface ParsedRelease {
  resolution?: "480p" | "720p" | "1080p" | "2160p";
  source?: string; // BluRay, WEB-DL, WEBRip, HDTV, DVDRip ...
  codec?: string;
  hdr?: boolean;
  season?: number;
  episode?: number;
  /** Last episode of a multi-episode release ("S01E01 E02", "S01E01-E02"). */
  episodeEnd?: number;
  /** True when the release covers a whole season (S01 with no episode) or a complete series. */
  pack?: boolean;
  year?: number;
}

export function parseRelease(name: string): ParsedRelease {
  const n = name.replace(/[._]/g, " ");
  const out: ParsedRelease = {};

  if (/\b(2160p|4k|uhd)\b/i.test(n)) out.resolution = "2160p";
  else if (/\b1080[pi]\b/i.test(n)) out.resolution = "1080p";
  else if (/\b720p\b/i.test(n)) out.resolution = "720p";
  else if (/\b(480p|576p|dvdrip|dvd rip)\b/i.test(n)) out.resolution = "480p";

  const src = n.match(/\b(blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|remux)\b/i);
  if (src?.[1]) out.source = src[1].replace(/^web-?dl$/i, "WEB-DL").replace(/^blu-?ray$/i, "BluRay");

  const codec = n.match(/\b(x265|hevc|h ?265|x264|h ?264|av1)\b/i);
  if (codec?.[1]) out.codec = /265|hevc/i.test(codec[1]) ? "HEVC" : /264/i.test(codec[1]) ? "H.264" : "AV1";
  if (/\b(hdr(?:10)?\+?|dolby vision|dv)\b/i.test(n)) out.hdr = true;

  const se = n.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) ?? n.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (se) {
    out.season = Number(se[1]);
    out.episode = Number(se[2]);
    const after = n.slice((se.index ?? 0) + se[0].length).match(/^[\s-]*E?(\d{1,3})(?!\d)/i);
    if (after && Number(after[1]) > out.episode && Number(after[1]) - out.episode < 10) out.episodeEnd = Number(after[1]);
  } else {
    // Arabic series often carry only an episode number ("E05", "Ep 5", "الحلقة 5") with no season: season 1 is implied.
    const epOnly = n.match(/(?:\bE(?:p|pisode)?\s?|\u0627\u0644\u062D\u0644\u0642\u0629\s?|\u062D\u0644\u0642\u0629\s?)(\d{1,3})(?!\d)/i);
    const sOnly = n.match(/\bS(?:eason)?\s?(\d{1,2})\b(?!\s?E\d)/i);
    if (epOnly && !/\bS(?:eason)?\s?\d/i.test(n)) out.episode = Number(epOnly[1]);
    else if (sOnly) {
      out.season = Number(sOnly[1]);
      out.pack = true;
    } else if (/\b(complete|collection|كامل)\b/i.test(n)) out.pack = true;
  }

  // Arabic season marker: "[م2]" or "الموسم 2" (season 2)
  const arSeason = n.match(/(?:^|[\s\[(])(?:م|الموسم\s?|موسم\s?)(\d{1,2})(?=[\s\]).]|$)/);
  if (arSeason && out.season === undefined) {
    out.season = Number(arSeason[1]);
    if (out.episode === undefined) out.pack = true;
  }

  const year = n.match(/\b(19[4-9]\d|20[0-4]\d)\b/);
  if (year?.[1]) out.year = Number(year[1]);
  return out;
}

export function formatSize(bytes: number | undefined): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm|wmv)$/i;
