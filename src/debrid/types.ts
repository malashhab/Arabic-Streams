export interface DebridFile {
  id: number;
  name: string;
  size: number;
}

/** Private-tracker releases have no magnet: the .torrent file itself is sent to the debrid service. */
export interface ResolveSource {
  torrentFile?: Buffer;
}

export interface ResolveTarget {
  season?: number;
  episode?: number;
}

/** Integration with a user's own debrid account. Instances are created per request from the caller's credentials. */
export interface DebridService {
  readonly id: "torbox" | "realdebrid";
  readonly label: string;
  /** Two-letter tag shown on stream cards, e.g. "TB". */
  readonly short: string;
  /**
   * Ask the provider which hashes are instantly available (hash -> the files inside, when the provider lists them).
   * Returns null when the provider has no reliable way to say (Real-Debrid removed its endpoint in Nov 2024),
   * in which case callers must NOT claim anything is cached.
   */
  checkCached(hashes: string[]): Promise<Map<string, DebridFile[]> | null>;
  /**
   * Turn a release into a playable HTTPS URL on the user's account.
   * Throws AddonError(code "not_ready") if the provider has not finished downloading it.
   */
  resolve(infoHash: string, target: ResolveTarget, source?: ResolveSource): Promise<{ url: string; filename?: string }>;
}
