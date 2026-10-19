import { beforeEach } from "vitest";
import { resetTorrentHashCache } from "../src/providers/torznab.js";

// Search/hash results and login sessions are cached in memory (by design); start every test from a clean slate.
beforeEach(() => {
  resetTorrentHashCache();
});
