/**
 * `/health`: operational readiness — RPC reachability, chain clock, cursor
 * staleness, restart gaps, and which config sources were used. Unlike
 * `/status`, it is written for someone deciding whether to act.
 */

import { escapeMd } from "../notifications/format.js";
import { formatProvenanceSummary, networkLabel, type BotConfig } from "../config.js";
import { buildHealthReport, chainClockLabel } from "../health.js";
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

export function healthMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const report = buildHealthReport(config, status, nowMs);
  const statusLabel = report.status.toUpperCase();

  const lines: string[] = [
    `*Health* — ${escapeMd(statusLabel)} on Stellar ${networkLabel(config)}`,
    "",
    `Status: \`${report.status}\` \\(${report.ok ? "ok" : "action required"}\\)`,
    `Poller: ${report.poller.running ? "running" : "stopped"}`,
    `Uptime: ${report.uptimeMs > 0 ? ago(nowMs - report.uptimeMs, nowMs) : "0s"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Last successful poll: ${ago(status.lastSuccessAt, nowMs)}`,
    `Chain tip: ${report.poller.latestLedger ?? "unknown"}`,
    `Chain clock skew: ${escapeMd(chainClockLabel(status.chainClockAt, nowMs))}`,
    `Cycles: ${report.poller.cycles} · consecutive failures: ${report.poller.consecutiveFailures}`,
    `Notifications: sent ${report.poller.notificationsSent} · failed ${report.poller.notificationsFailed} · skipped ${report.poller.eventsSkipped}`,
    "",
    "*Watched Contracts*",
  ];

  for (const target of report.poller.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursorPreview ?? "none (cold start)"}\``,
    );
    if (target.cursorStale) {
      lines.push(
        target.rewindFromLedger === null
          ? "  ALERT: RPC rejected this cursor as stale; its position is unchanged"
          : `  ALERT: stale cursor recovery from ledger ${target.rewindFromLedger}`,
      );
    }
    if (target.gapLedgers > 0) {
      lines.push(
        `  restart gap: ${target.gapLedgers} ledger(s) unrecoverable at the last recovery`,
      );
    }
    if (target.cursorUnreadable) {
      lines.push("  cursor ledger unreadable: position forwarded unchanged");
    }
    if (target.hasError) {
      const targetState = status.targets.find((t) => t.source === target.source);
      if (targetState?.lastError) {
        lines.push(`  last error: ${escapeMd(targetState.lastError)}`);
      }
    }
  }

  if (report.poller.restartGaps > 0) {
    const gap = report.poller.lastRestartGap;
    lines.push(
      escapeMd(
        `Restart gaps since start: ${report.poller.restartGaps}` +
          (gap ? ` (last: ${gap.missedLedgers} ledger(s) unrecoverable on ${gap.source})` : ""),
      ),
    );
  }

  if (report.poller.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError?.at ?? null, nowMs)}\\): ${escapeMd(report.poller.lastError.message)}`,
    );
  }

  // Origins, never values: an operator can confirm this process is reading the
  // intended .env / profile without a secret being typed into a chat. The
  // summary is interpolated into a code span unescaped on purpose — it is built
  // only from key names, source names, and counts (see config.ts), so it has no
  // MarkdownV2 reserved character to escape and stays copy-pasteable.
  lines.push("", `Config: \`${formatProvenanceSummary(report.config)}\``);
  if (report.config.warnings.length > 0) {
    lines.push(`Config notes: ${escapeMd(report.config.warnings.join("; "))}`);
  }

  return lines.join("\n");
}

export const healthCommand = defineCommand({
  // Config-only, so this never fails on account of poller or RPC state —
  // unlike /status, it has nothing to report failure on.
  command: "health",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    await ctx.reply(healthMessage(deps.config, deps.status()), TELEGRAM_OPTIONS);
  },
});
