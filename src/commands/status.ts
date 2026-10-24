/**
 * `/status`: what the bot is watching, how far it has read, and how the last
 * cycles went. Reads poller state only — never the chain — so answering stays
 * cheap even mid-cycle.
 */

import { performance } from "node:perf_hooks";

import {
  escapeMd,
  formatLastEvent,
} from "../notifications/format.js";
import { networkLabel, type BotConfig } from "../config.js";
import { chainClockLabel } from "../health.js";
import { formatFeatureFlags } from "../notifications/featureFlags.js";
import type { PollerStatus } from "../poller.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

function ago(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function cursorPreview(cursor: string | null): string {
  if (cursor === null) return "none (cold start)";
  const compact = cursor.replace(/\s+/g, " ").replace(/[`\\]/g, "?").trim() || "empty";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

export function statusMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const lifecycle = status.stopping
    ? "stopping"
    : status.paused
      ? "paused"
      : status.running
        ? "running"
        : "stopped";

  const lines: string[] = [
    `*Status* — ${lifecycle} on Stellar ${networkLabel(config)}`,
    `Channel preview: ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped} · deduped ${status.eventsDeduplicated ?? 0}` +
      (status.notificationsDropped
        ? ` · dropped during shutdown ${status.notificationsDropped}`
        : ""),
    `RPC pages: ${status.pagesScanned} total · ${status.emptyPages} empty` +
      (status.lastCyclePages > 0
        ? ` · last cycle ${status.lastCycleEmptyPages}/${status.lastCyclePages} empty`
        : ""),
    `Feature flags: ${escapeMd(formatFeatureFlags(config.featureFlags))}`,
    "",
    "*Watching*",
  ];

  // Only shown when the queue is holding or has replayed something, so an
  // ordinary /status is unchanged.
  if (status.deadLetter && (status.deadLetter.depth > 0 || status.deadLetter.replayed > 0)) {
    lines.push(
      `Parked sends: ${status.deadLetter.depth} waiting \u00b7 ` +
        `${status.deadLetter.replayed} replayed \u00b7 ${status.deadLetter.dropped} dropped`,
      "",
    );
  }

  // Only shown after an automatic recovery, so an ordinary /status is unchanged.
  if (status.cursorRewinds > 0) {
    lines.push(
      `Cursors rewound to the retained floor: ${status.cursorRewinds}`,
      "",
    );
  }

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \\(${escapeMd(target.version ?? "v1")}\\) \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${cursorPreview(target.cursor)}\``,
    );
    if (target.cursorStalled) {
      lines.push(
        `  cursor stalled: unchanged for ${target.cyclesWithoutAdvance} successful cycles while behind tip`,
      );
    }
    if (target.gapLedgers > 0) {
      lines.push(
        `  restart gap: ${target.gapLedgers} ledger${target.gapLedgers === 1 ? "" : "s"} unrecoverable, ` +
          `cursor reset ${ago(target.cursorResetAt, nowMs)}`,
      );
    }
    if (target.cursorUnreadable) {
      lines.push("  cursor ledger unreadable: position left untouched");
    }
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at, nowMs)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }
  if (status.restartGaps > 0) {
    lines.push(`Restart gaps detected since start: ${status.restartGaps}`);
  }

  if (status.stopping) {
    lines.push(
      "",
      "Graceful shutdown in progress: no new cycles, unsent notifications dropped" +
        (status.pendingFlush ? ", cursor flush still pending" : ", cursor flushed") +
        "\\.",
    );
  }

  return lines.join("\n");
}

export function lastEventMessage(config: BotConfig, status: PollerStatus): string {
  const lines = [`*Last observed events* — Stellar ${networkLabel(config)}`, ""];

  for (const target of status.targets) {
    lines.push(`*mimir\\-${target.source}*`);
    if (!target.lastEvent) {
      lines.push("No event has been observed since this process started\\.", "");
      continue;
    }
    lines.push(formatLastEvent(config, target.lastEvent), "");
  }

  if (status.targets.length === 0) {
    lines.push("No contract scan has completed yet\\.");
  }
  return lines.join("\n").trimEnd();
}

export const statusCommand = defineCommand({
  command: "status",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const startedAt = performance.now();
    let sent = false;
    try {
      await ctx.reply(statusMessage(deps.config, deps.status()), TELEGRAM_OPTIONS);
      sent = true;
    } finally {
      const latencyMs = Math.max(0, performance.now() - startedAt);
      console.info(
        `[bot] /status ${sent ? "sent" : "failed"} in ${latencyMs.toFixed(1)}ms`,
      );
    }
  },
});
