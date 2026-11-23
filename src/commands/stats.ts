import { escapeMd } from "../notifications/format.js";
import { defineCommand, type CommandDeps } from "./registry.js";
import { replyMarkdown } from "./runtime.js";

export interface StatsSnapshot {
  notificationsSent?: number;
  notificationsFailed?: number;
  notificationsSkipped?: number;
  rpcCalls?: number;
  rpcErrors?: number;
  startedAtMs?: number;
  [key: string]: number | undefined;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function presentCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function statsMessage(snapshot: StatsSnapshot, nowMs: number): string {
  const sent = presentCount(snapshot.notificationsSent);
  const failed = presentCount(snapshot.notificationsFailed);
  const skipped = presentCount(snapshot.notificationsSkipped);
  const rpcCalls = presentCount(snapshot.rpcCalls);
  const rpcErrors = presentCount(snapshot.rpcErrors);
  const startedAtMs = count(snapshot.startedAtMs);
  const uptime = formatUptime(nowMs - startedAtMs);

  const lines = [
    "*Stats*",
    `${escapeMd("Notifications")}: sent ${sent}, failed ${failed}, skipped ${skipped}`,
    `${escapeMd("RPC")}: calls ${rpcCalls}, errors ${rpcErrors}`,
    `${escapeMd("Uptime")}: ${escapeMd(uptime)}`,
  ];

  return lines.join("\n");
}

/**
 * Build a {@link StatsSnapshot} from live command dependencies.
 *
 * The injected `metrics` registry is authoritative: its counters are updated
 * by the poller and notifier on every cycle, so consecutive `/stats` calls
 * reflect live traffic. Minimal harnesses that do not inject `metrics` fall
 * back to the poller's status counters. A status `startedAt` of `0` means the
 * poller has not started, so uptime renders as `0s` instead of epoch elapsed.
 */
export function statsSnapshotFromDeps(deps: CommandDeps, nowMs: number): StatsSnapshot {
  const status = deps.status();
  const startedAtMs =
    typeof status?.startedAt === "number" && Number.isFinite(status.startedAt) && status.startedAt > 0
      ? status.startedAt
      : nowMs;

  if (deps.metrics !== undefined) {
    return {
      notificationsSent: deps.metrics.notificationsSent.value(),
      notificationsFailed: deps.metrics.notificationsFailed.value(),
      notificationsSkipped: deps.metrics.eventsSkipped.value(),
      rpcCalls: deps.metrics.rpcRequests.value(),
      rpcErrors: deps.metrics.rpcErrors.value(),
      startedAtMs,
    };
  }

  return {
    notificationsSent: status?.sinceStart?.notificationsSent ?? status?.notificationsSent ?? 0,
    notificationsFailed: status?.sinceStart?.notificationsFailed ?? status?.notificationsFailed ?? 0,
    notificationsSkipped: status?.sinceStart?.eventsSkipped ?? status?.eventsSkipped ?? 0,
    rpcCalls: 0,
    rpcErrors: 0,
    startedAtMs,
  };
}

export const statsCommand = defineCommand({
  command: "stats",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const nowMs = deps.now?.() ?? Date.now();
    await replyMarkdown(ctx, statsMessage(statsSnapshotFromDeps(deps, nowMs), nowMs));
  },
});
