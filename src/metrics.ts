/**
 * Prometheus-compatible metrics for the Mimir Telegram notifier.
 *
 * This module exports a single Registry and all metric objects. Nothing here
 * touches the network; the HTTP endpoint that serves `/metrics` is started by
 * the entry point when `config.metricsEnabled` is true.
 *
 * ── Design rationale ─────────────────────────────────────────────────────────
 *
 * A single registry owned by this module keeps metric names in one place and
 * avoids the "duplicate metric" errors that a per-instance registry can produce
 * during hot-reload in development. Every module that needs to record
 * observations imports the metric objects directly.
 *
 * Default process/GC metrics are collected via `collectDefaultMetrics`. They
 * are cheap, widely expected by Prometheus users, and require no extra code to
 * use.
 */

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

export const registry = new Registry();

// Opt Node.js default metrics (event-loop lag, GC, memory, fd counts) into our
// registry rather than the global default, so there is no cross-contamination
// if tests instantiate a second registry.
collectDefaultMetrics({ register: registry });

// ── Poll-loop counters ────────────────────────────────────────────────────────

/** Incremented at the start of each poll cycle, regardless of outcome. */
export const pollCyclesTotal = new Counter({
  name: "mimir_poll_cycles_total",
  help: "Total number of poll cycles attempted.",
  registers: [registry],
});

/**
 * Notification outcomes, broken out by `status`:
 *  - `sent`    — message delivered to Telegram
 *  - `failed`  — Telegram send returned an error
 *  - `skipped` — event decoded as unknown/admin, or cycle burst-cap reached
 */
export const notificationsTotal = new Counter({
  name: "mimir_notifications_total",
  help: "Notification delivery outcomes.",
  labelNames: ["status"] as const,
  registers: [registry],
});

/** Incremented each time the per-cycle burst cap is hit and an event is dropped. */
export const burstCapHitsTotal = new Counter({
  name: "mimir_burst_cap_hits_total",
  help: "Number of events dropped because MAX_NOTIFICATIONS_PER_CYCLE was reached.",
  registers: [registry],
});

// ── RPC call metrics ──────────────────────────────────────────────────────────

/**
 * RPC call outcomes, labelled by `contract` (`market` | `squad`) and
 * `status` (`ok` | `error`).
 */
export const rpcCallsTotal = new Counter({
  name: "mimir_rpc_calls_total",
  help: "Soroban RPC scan outcomes.",
  labelNames: ["contract", "status"] as const,
  registers: [registry],
});

/**
 * End-to-end duration of one `readContractEvents` call (all pages), in seconds.
 * Labelled by `contract`.
 */
export const rpcCallDurationSeconds = new Histogram({
  name: "mimir_rpc_call_duration_seconds",
  help: "Duration of a full contract event scan (all pages) in seconds.",
  labelNames: ["contract"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// ── Event decode counters ─────────────────────────────────────────────────────

/**
 * Every decoded event, labelled by `contract` and `event_name`.
 * Unknown/undecodable events are counted under their raw topic[0] name.
 */
export const eventsDecodedTotal = new Counter({
  name: "mimir_events_decoded_total",
  help: "Contract events decoded and observed, by contract and event name.",
  labelNames: ["contract", "event_name"] as const,
  registers: [registry],
});

// ── Health gauges ─────────────────────────────────────────────────────────────

/** Current consecutive failed cycle count. Reset to 0 on the first success. */
export const consecutiveFailures = new Gauge({
  name: "mimir_consecutive_failures",
  help: "Number of consecutive poll cycles that resulted in no successful RPC scan.",
  registers: [registry],
});

/**
 * Seconds since the last event was seen per contract.
 * Set to 0 on a cold start (no event seen yet).
 *
 * A high value indicates the RPC is returning events but none match the
 * contract — or that the chain has genuinely gone quiet. A value growing
 * without bound while `mimir_rpc_calls_total{status="ok"}` is also not moving
 * points to a stuck cursor rather than real silence.
 */
export const staleCursorSeconds = new Gauge({
  name: "mimir_stale_cursor_seconds",
  help: "Seconds since the last event was observed for this contract. 0 if no event has ever been seen.",
  labelNames: ["contract"] as const,
  registers: [registry],
});

/**
 * How many ledgers behind the chain tip the last observed event is, per
 * contract. Formula: `latestLedger - lastEventLedger`. 0 if no event seen.
 *
 * A value growing larger than the RPC's retained window (~120 960 ledgers)
 * means the cursor is stuck and events are being silently dropped.
 */
export const cursorLagLedgers = new Gauge({
  name: "mimir_cursor_lag_ledgers",
  help: "Ledgers between the chain tip and the last seen event ledger. 0 if no event seen.",
  labelNames: ["contract"] as const,
  registers: [registry],
});

/** Unix timestamp (seconds) of the last poll attempt. 0 before the first cycle. */
export const lastPollTimestampSeconds = new Gauge({
  name: "mimir_last_poll_timestamp_seconds",
  help: "Unix timestamp of the most recent poll cycle start.",
  registers: [registry],
});

/** Unix timestamp (seconds) of the last cycle that had at least one successful RPC scan. */
export const lastSuccessTimestampSeconds = new Gauge({
  name: "mimir_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent poll cycle where at least one RPC scan succeeded.",
  registers: [registry],
});
