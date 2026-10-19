import { createHash } from "node:crypto";

// Minimal bencode reader, just enough to find the byte range of the top-level "info" dictionary
// in a .torrent file. The info-hash is the SHA-1 of exactly those bytes.

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  private int(): number {
    const end = this.buf.indexOf(0x65, this.pos); // 'e'
    if (end < 0) throw new Error("bad int");
    const n = Number(this.buf.toString("latin1", this.pos + 1, end));
    this.pos = end + 1;
    return n;
  }

  private str(): Buffer {
    const colon = this.buf.indexOf(0x3a, this.pos); // ':'
    if (colon < 0) throw new Error("bad string");
    const len = Number(this.buf.toString("latin1", this.pos, colon));
    if (!Number.isInteger(len) || len < 0 || colon + 1 + len > this.buf.length) throw new Error("bad string length");
    this.pos = colon + 1 + len;
    return this.buf.subarray(colon + 1, this.pos);
  }

  /** Skip one value of any type. */
  skip(depth = 0): void {
    if (depth > 20) throw new Error("too deep");
    const c = this.buf[this.pos];
    if (c === 0x69) this.int(); // i
    else if (c === 0x6c) { // l
      this.pos++;
      while (this.buf[this.pos] !== 0x65) this.skip(depth + 1);
      this.pos++;
    } else if (c === 0x64) { // d
      this.pos++;
      while (this.buf[this.pos] !== 0x65) {
        this.str();
        this.skip(depth + 1);
      }
      this.pos++;
    } else if (c !== undefined && c >= 0x30 && c <= 0x39) this.str();
    else throw new Error("bad bencode");
  }

  topLevelInfoRange(): [number, number] {
    if (this.buf[0] !== 0x64) throw new Error("not a torrent");
    this.pos = 1;
    while (this.buf[this.pos] !== 0x65) {
      const key = this.str().toString("latin1");
      const start = this.pos;
      this.skip();
      if (key === "info") return [start, this.pos];
    }
    throw new Error("no info dictionary");
  }
}

/** 40-char lowercase info-hash of a .torrent file, or null if it is not a valid torrent. */
export function infoHashOfTorrent(buf: Buffer): string | null {
  try {
    const [s, e] = new Reader(buf).topLevelInfoRange();
    return createHash("sha1").update(buf.subarray(s, e)).digest("hex");
  } catch {
    return null;
  }
}
