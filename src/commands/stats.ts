import { escapeMd } from "../notifications/format.js";

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
