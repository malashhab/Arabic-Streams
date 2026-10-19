// Tiny structured (JSON-lines) logger that redacts secrets before anything is written.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SENSITIVE_KEY = /(key|token|secret|authorization|password|apikey|auth)/i;

/** Remove credentials from URLs / free text: query params, bearer tokens and our opaque config tokens. */
export function redactString(input: string): string {
  return input
    .replace(/([?&](?:apikey|api_key|token|auth_token|key|password)=)[^&\s"']+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/\/c_[A-Za-z0-9_-]{20,}/g, "/c_***");
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 5) return value;
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

let threshold: number = LEVELS.info;
let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

export function configureLogger(level: Level, out?: (line: string) => void): void {
  threshold = LEVELS[level] ?? LEVELS.info;
  if (out) sink = out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  sink(JSON.stringify({ t: new Date().toISOString(), level, msg: redactString(msg), ...(redact(fields) as object) }));
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};
