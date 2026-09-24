/**
 * Local HTTP health endpoint for process supervisors and deploy checks.
 *
 * Bound to loopback by default so it is never an accidental public surface.
 * Responses are JSON-only operational status: no bot tokens, private keys,
 * chat ids, or raw remote payloads.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

export interface HealthDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

export interface HealthServer {
  /** Resolved listen URL, e.g. http://127.0.0.1:8787. Null when disabled. */
  url: string | null;
  /** Port actually bound (0 when disabled). */
  port: number;
  close(): Promise<void>;
}

/** Safe, redacted snapshot for HTTP clients. Never includes secrets. */
export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "stopped";
  service: "mimir-telegram-bot";
  network: string;
  uptimeMs: number;
  checkedAt: string;
  poller: {
    running: boolean;
    /** Intentional operator pause; process is ready but scheduling is stopped. */
    paused: boolean;
    cycles: number;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    latestLedger: number | null;
    oldestLedger: number | null;
    notificationsSent: number;
    notificationsFailed: number;
    eventsSkipped: number;
    consecutiveFailures: number;
    lastError: { at: string; message: string } | null;
    targets: Array<{
      source: string;
      /** Public contract id (on-chain). */
      contractId: string;
      lastEventLedger: number | null;
      /** Opaque resume cursor; not a secret. Truncated for readability. */
      cursorPreview: string | null;
      hasError: boolean;
    }>;
  };
}

const CURSOR_PREVIEW_LEN = 24;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function previewCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (cursor.length <= CURSOR_PREVIEW_LEN) return cursor;
  return `${cursor.slice(0, CURSOR_PREVIEW_LEN)}…`;
}

/**
 * Build a health report from poller status.
 *
 * - `ok` / HTTP 200 when the poller is running and has not exceeded the
 *   consecutive-failure budget (and, once it has succeeded at least once,
 *   a successful poll happened within `healthStaleMs`).
 * - `degraded` / HTTP 503 when running but stale or failing repeatedly.
 * - `stopped` / HTTP 503 when the poller is not running.
 */
export function buildHealthReport(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number = Date.now(),
): HealthReport {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;

  let status: HealthReport["status"];
  if (!poller.running) {
    status = "stopped";
  } else if (poller.paused) {
    // A deliberate operator pause is healthy, not a stale or failing poller.
    status = "ok";
  } else {
    const failureBudget = Math.max(3, Math.ceil(60_000 / Math.max(config.pollIntervalMs, 1)));
    const tooManyFailures = poller.consecutiveFailures >= failureBudget;
    const hasEverSucceeded = poller.lastSuccessAt !== null;
    const stale =
      hasEverSucceeded &&
      config.healthStaleMs > 0 &&
      nowMs - (poller.lastSuccessAt as number) > config.healthStaleMs;
    status = tooManyFailures || stale ? "degraded" : "ok";
  }

  return {
    ok: status === "ok",
    status,
    service: "mimir-telegram-bot",
    network: networkLabel(config),
    uptimeMs,
    checkedAt: new Date(nowMs).toISOString(),
    poller: {
      running: poller.running,
      paused: poller.paused === true,
      cycles: poller.cycles,
      lastPollAt: iso(poller.lastPollAt),
      lastSuccessAt: iso(poller.lastSuccessAt),
      latestLedger: poller.latestLedger,
      oldestLedger: poller.oldestLedger,
      notificationsSent: poller.notificationsSent,
      notificationsFailed: poller.notificationsFailed,
      eventsSkipped: poller.eventsSkipped,
      consecutiveFailures: poller.consecutiveFailures,
      lastError: poller.lastError
        ? { at: new Date(poller.lastError.at).toISOString(), message: poller.lastError.message }
        : null,
      targets: poller.targets.map((t) => ({
        source: t.source,
        contractId: t.contractId,
        lastEventLedger: t.lastEventLedger,
        cursorPreview: previewCursor(t.cursor),
        hasError: t.lastError !== null,
      })),
    },
  };
}

/**
 * Render poller status as Prometheus metrics.
 */
export function buildMetricsReport(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;
  const network = networkLabel(config);

  const lines: string[] = [
    `# HELP mimir_telegram_uptime_ms Uptime in milliseconds`,
    `# TYPE mimir_telegram_uptime_ms gauge`,
    `mimir_telegram_uptime_ms{network="${network}"} ${uptimeMs}`,
    ``,
    `# HELP mimir_telegram_poller_running Whether the poller is currently running (1) or stopped/paused (0)`,
    `# TYPE mimir_telegram_poller_running gauge`,
    `mimir_telegram_poller_running{network="${network}"} ${poller.running && !poller.paused ? 1 : 0}`,
    ``,
    `# HELP mimir_telegram_poller_cycles_total Total number of completed poll cycles`,
    `# TYPE mimir_telegram_poller_cycles_total counter`,
    `mimir_telegram_poller_cycles_total{network="${network}"} ${poller.cycles}`,
    ``,
    `# HELP mimir_telegram_notifications_sent_total Total number of Telegram messages successfully sent`,
    `# TYPE mimir_telegram_notifications_sent_total counter`,
    `mimir_telegram_notifications_sent_total{network="${network}"} ${poller.notificationsSent}`,
    ``,
    `# HELP mimir_telegram_notifications_failed_total Total number of Telegram messages that failed to send after retries`,
    `# TYPE mimir_telegram_notifications_failed_total counter`,
    `mimir_telegram_notifications_failed_total{network="${network}"} ${poller.notificationsFailed}`,
    ``,
    `# HELP mimir_telegram_events_skipped_total Total number of events skipped (unrecognized, unformatted, or rate-limited)`,
    `# TYPE mimir_telegram_events_skipped_total counter`,
    `mimir_telegram_events_skipped_total{network="${network}"} ${poller.eventsSkipped}`,
    ``,
    `# HELP mimir_telegram_consecutive_failures Current number of consecutive failed poll cycles`,
    `# TYPE mimir_telegram_consecutive_failures gauge`,
    `mimir_telegram_consecutive_failures{network="${network}"} ${poller.consecutiveFailures}`,
  ];

  if (poller.latestLedger !== null) {
    lines.push(
      ``,
      `# HELP mimir_telegram_latest_ledger Highest ledger seen by the poller`,
      `# TYPE mimir_telegram_latest_ledger gauge`,
      `mimir_telegram_latest_ledger{network="${network}"} ${poller.latestLedger}`
    );
  }

  const targetsWithLedgers = poller.targets.filter((t) => t.lastEventLedger !== null);
  if (targetsWithLedgers.length > 0) {
    lines.push(
      ``,
      `# HELP mimir_telegram_target_last_event_ledger Highest ledger in which an event was processed for a target`,
      `# TYPE mimir_telegram_target_last_event_ledger gauge`,
    );
    for (const target of targetsWithLedgers) {
      lines.push(
        `mimir_telegram_target_last_event_ledger{network="${network}",source="${target.source}",contract="${target.contractId}"} ${target.lastEventLedger}`
      );
    }
  }

  return lines.join("\\n") + "\\n";
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Start the local health HTTP server.
 *
 * `HEALTH_PORT=0` (or a resolved port of 0) disables the listener entirely —
 * useful for unit tests and one-shot CLI runs that must not bind a port.
 */
export function startHealthServer(deps: HealthDeps): HealthServer {
  const { config, status } = deps;
  const now = deps.now ?? Date.now;

  if (config.healthPort === 0) {
    console.log("[health] disabled (HEALTH_PORT=0)");
    return { url: null, port: 0, close: async () => undefined };
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.healthHost}`);

    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      const report = buildHealthReport(config, status(), now());
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    if (method === "GET" && (url.pathname === "/health/live" || url.pathname === "/livez")) {
      // Liveness: the process is up and the HTTP server can answer. Do not
      // reflect poller degradation here — supervisors use /health for that.
      sendJson(res, 200, {
        ok: true,
        status: "live",
        service: "mimir-telegram-bot",
        checkedAt: new Date(now()).toISOString(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/metrics") {
      const metrics = buildMetricsReport(config, status(), now());
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(metrics),
      });
      res.end(metrics);
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        service: "mimir-telegram-bot",
        health: "/health",
        live: "/health/live",
        metrics: "/metrics",
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  // Failures after listen (e.g. client aborts) must not take down the notifier.
  server.on("error", (err) => {
    console.error(`[health] server error: ${err instanceof Error ? err.message : err}`);
  });

  server.listen(config.healthPort, config.healthHost);

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.healthPort;
  const url = `http://${config.healthHost}:${port}`;
  console.log(`[health] listening on ${url} (GET /health, GET /health/live)`);

  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
