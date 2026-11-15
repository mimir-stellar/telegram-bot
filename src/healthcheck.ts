/**
 * Container healthcheck & offline incident-bundle health report CLI.
 *
 * Online container probe (default):
 *   Reads HEALTH_HOST and HEALTH_PORT and issues an HTTP GET to /health.
 *   Exits 0 if HTTP 200 (or HEALTH_PORT=0), 1 otherwise.
 *
 * Offline incident-bundle report (`--offline` / `npm run health:report`):
 *   Reads the persisted STATUS_FILE schema directly from disk without opening
 *   an HTTP server or contacting Stellar/Telegram, explicitly identifying
 *   missing, malformed, stale, stopped, degraded, or healthy status snapshots.
 */

import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveStatusFile } from "./config.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./exitCodes.js";
import {
  formatOfflineHealthReport,
  readOfflineHealthReport,
} from "./health.js";

export interface OfflineCliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const OFFLINE_HELP = `Usage: npm run health:report -- [options]
       node dist/healthcheck.js --offline [options]

Read a persisted status snapshot (STATUS_FILE) offline for incident bundles
without opening a server or requiring Telegram/RPC credentials.

Options:
  --offline           Run offline against the persisted status file
  --file <path>       Path to status snapshot JSON (default: STATUS_FILE or ./data/status.json)
  --stale-ms <ms>     Staleness threshold in ms; 0 disables staleness check
  --now <ms|iso>      Reference timestamp (unix ms or ISO-8601) for deterministic bundle checks
  --json              Emit machine-readable OfflineHealthReport JSON
  --help, -h          Show this help message
`;

function parseNowArg(raw: string): number | null {
  if (/^\d+$/.test(raw.trim())) {
    const num = Number(raw.trim());
    return Number.isSafeInteger(num) ? num : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Run the offline incident-bundle health report command without opening any
 * HTTP listener or network socket. Returns a process exit code.
 */
export async function runOfflineHealthCli(
  args: readonly string[] = process.argv.slice(2),
  io: OfflineCliIo = {},
): Promise<number> {
  const out = io.stdout ?? ((line: string) => console.log(line));
  const err = io.stderr ?? ((line: string) => console.error(line));

  let file: string | undefined;
  let staleMs: number | undefined;
  let nowMs: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--offline" || arg === "--report") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out(OFFLINE_HELP.trimEnd());
      return EXIT_OK;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--file") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        err("[health:offline] --file requires a path argument");
        return EXIT_USAGE;
      }
      file = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === "--stale-ms") {
      const next = args[i + 1];
      if (next === undefined || !/^\d+$/.test(next.trim())) {
        err("[health:offline] --stale-ms must be a non-negative integer");
        return EXIT_USAGE;
      }
      const parsed = Number(next.trim());
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        err("[health:offline] --stale-ms must be a non-negative safe integer");
        return EXIT_USAGE;
      }
      staleMs = parsed;
      i += 1;
      continue;
    }
    if (arg === "--now") {
      const next = args[i + 1];
      if (!next) {
        err("[health:offline] --now requires a unix ms or ISO-8601 timestamp");
        return EXIT_USAGE;
      }
      const parsed = parseNowArg(next);
      if (parsed === null) {
        err(`[health:offline] invalid --now timestamp: ${next}`);
        return EXIT_USAGE;
      }
      nowMs = parsed;
      i += 1;
      continue;
    }
    err(`[health:offline] unknown option: ${arg}`);
    return EXIT_USAGE;
  }

  const targetFile = file ?? resolveStatusFile();
  const report = await readOfflineHealthReport(targetFile, {
    ...(staleMs !== undefined ? { staleMs } : {}),
    ...(nowMs !== undefined ? { nowMs } : {}),
  });

  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    const formatted = formatOfflineHealthReport(report);
    if (report.ok) out(formatted);
    else err(formatted);
  }

  return report.ok ? EXIT_OK : EXIT_ERROR;
}

function runOnlineProbe(): void {
  const host = process.env.HEALTH_HOST || "127.0.0.1";
  const portRaw = process.env.HEALTH_PORT;
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : 8787;

  if (Number.isNaN(port) || port === 0) {
    console.log("[healthcheck] Disabled (HEALTH_PORT=0 or invalid)");
    process.exit(EXIT_OK);
  }

  const req = http.request(
    {
      host,
      port,
      path: "/health",
      method: "GET",
      timeout: 2000,
    },
    (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[healthcheck] OK");
          process.exit(EXIT_OK);
        } else {
          console.error(`[healthcheck] Failed: HTTP ${res.statusCode} - ${body.trim()}`);
          process.exit(EXIT_ERROR);
        }
      });
    },
  );

  req.on("error", (err) => {
    console.error(`[healthcheck] Request failed: ${err.message}`);
    process.exit(EXIT_ERROR);
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[healthcheck] Request timed out");
    process.exit(EXIT_ERROR);
  });

  req.end();
}

function isOfflineInvocation(args: readonly string[]): boolean {
  return (
    args.includes("--offline") ||
    args.includes("--report") ||
    args.includes("--file") ||
    args.includes("--help") ||
    args.includes("-h")
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const cliArgs = process.argv.slice(2);
  if (isOfflineInvocation(cliArgs)) {
    runOfflineHealthCli(cliArgs)
      .then((code) => {
        process.exit(code);
      })
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(EXIT_ERROR);
      });
  } else {
    runOnlineProbe();
  }
}
