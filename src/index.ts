import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { configureLogger, log } from "./lib/logger.js";
import { createApp } from "./server/app.js";

const env = loadEnv();
configureLogger(env.LOG_LEVEL);

if (!env.TMDB_READ_TOKEN) log.warn("TMDB_READ_TOKEN is not set: catalogs only work for users who supply their own TMDB token in settings");

const app = createApp({ env });
const server = app.listen(env.PORT, () => log.info("addon listening", { port: env.PORT }));

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then exit.
function shutdown(signal: string): void {
  log.info("shutting down", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
