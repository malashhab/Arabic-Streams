import type { MediaType } from "../catalogs/definitions.js";

/** What a provider is asked to find. Built from TMDB metadata, never from user-supplied URLs. */
export interface StreamQuery {
  type: MediaType;
  /** Candidate titles to search for (Arabic title, original title, English title). */
  titles: string[];
  year?: number;
  imdbId?: string;
  season?: number;
  episode?: number;
}

/** A torrent release found by an index. Needs a debrid service to play. */
export interface TorrentRelease {
  kind: "torrent";
  /** Lowercase 40-hex. Absent for private-tracker releases: it is only learned when the user clicks (one download). */
  infoHash?: string;
  title: string;
  size?: number;
  seeders?: number;
  indexer?: string;
  /** The release's details page on the index (no secrets in it). Used to read the info-hash without downloading a .torrent. */
  detailsUrl?: string;
  /** Shown on the stream card when something may stop this release from playing. */
  warning?: string;
  /** How sure we are this is the requested title/season/episode/year (set by the source). */
  match?: "exact" | "likely";
  /**
   * Private trackers only offer a .torrent file (no magnet). This is the index's download link for it
   * (same origin as the configured index). It can contain secrets, so it only ever travels sealed (encrypted).
   * It is NOT downloaded while searching, so browsing never hits the tracker's download limits.
   */
  torrentUrl?: string;
}

/** A directly playable public file (e.g. Internet Archive). Needs no debrid. */
export interface DirectRelease {
  kind: "direct";
  url: string;
  title: string;
  size?: number;
  source: string;
}

/** A message for the user from a source (e.g. "daily download limit reached"). */
export interface NoticeRelease {
  kind: "notice";
  message: string;
}

export type Release = TorrentRelease | DirectRelease | NoticeRelease;

export interface StreamProvider {
  readonly id: string;
  search(q: StreamQuery): Promise<Release[]>;
}
