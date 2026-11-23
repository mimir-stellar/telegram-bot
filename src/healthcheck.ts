/**
 * Container healthcheck script.
 * 
 * Designed to be run periodically by a container supervisor (like Docker HEALTHCHECK or K8s liveness/readiness probes).
 * It reads the same HEALTH_HOST and HEALTH_PORT environment variables used by the main process
 * and issues an HTTP GET to /health.
 * 
 * Exits 0 if the health endpoint returns HTTP 200.
 * Exits 1 otherwise.
 *
 * Offline mode (`--report <status-file>`): reads a persisted status snapshot
 * (see STATUS_FILE) and prints it as `key: value` lines without contacting a
 * server, for incident review when the process is down. Exits 1 when the file
 * is missing or malformed.
 */

import http from "node:http";
import { readFileSync } from "node:fs";

function formatReportValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function offlineReport(file: string | undefined): never {
  if (!file) {
    console.error("[healthcheck] --report requires a status file path");
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`[healthcheck] Cannot read status file ${file}: ${(err as Error).message}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[healthcheck] Status file ${file} is malformed (not valid JSON)`);
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[healthcheck] Status file ${file} is malformed (expected a JSON object)`);
    process.exit(1);
  }
  console.log(`[healthcheck] Offline report from ${file}`);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    console.log(`${key}: ${formatReportValue(value)}`);
  }
  process.exit(0);
}

function main() {
  const reportIndex = process.argv.indexOf("--report");
  if (reportIndex !== -1) {
    offlineReport(process.argv[reportIndex + 1]);
  }

  const host = process.env.HEALTH_HOST || "127.0.0.1";
  const portRaw = process.env.HEALTH_PORT;
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : 8787;

  if (Number.isNaN(port) || port === 0) {
    console.log("[healthcheck] Disabled (HEALTH_PORT=0 or invalid)");
    process.exit(0);
  }

  const req = http.request(
    {
      host,
      port,
      path: "/health",
      method: "GET",
      timeout: 2000,
      headers: {
        Connection: "close",
      },
    },
    (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[healthcheck] OK");
          process.exit(0);
        } else {
          console.error(`[healthcheck] Failed: HTTP ${res.statusCode} - ${body.trim()}`);
          process.exit(1);
        }
      });
    }
  );

  req.on("error", (err) => {
    console.error(`[healthcheck] Request failed: ${err.message}`);
    process.exit(1);
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[healthcheck] Request timed out");
    process.exit(1);
  });

  req.end();
}

main();
