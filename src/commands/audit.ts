/**
 * `/audit`: a bounded, redacted report of recent administrative operations and
 * poller state changes, for the operator. The standalone `npm run audit` CLI is
 * the credential-free path for anyone with machine access.
 */

import {
  AUDIT_REPORT_MAX_ENTRIES,
  readAuditFile,
  renderAuditReport,
  type AuditFileSummary,
} from "../audit.js";
import { messagesFor, type Locale } from "../i18n.js";
import { safeErrorMessage } from "../notifications/format.js";
import { defineCommand, type CommandAvailabilityContext } from "./registry.js";

/** How many recent audit lines `/audit` renders. A chat message is not a file. */
const AUDIT_TAIL = 10;

function auditUnavailableReason({ config, deps }: CommandAvailabilityContext): string | null {
  const hasLiveAudit = deps?.audit !== undefined && deps.audit !== null;
  if (hasLiveAudit) {
    return null;
  }
  const explicitDepsFile =
    deps !== undefined && "auditFile" in deps ? deps.auditFile : undefined;
  const file = explicitDepsFile !== undefined ? explicitDepsFile : config?.auditFile;
  if (typeof file === "string" && file.trim() === "") {
    return "Audit trail is disabled (AUDIT_FILE is empty and no in-memory audit log is attached)";
  }
  if (deps !== undefined && "audit" in deps && "auditFile" in deps && !file) {
    return "Audit trail is disabled (no in-memory audit log or audit file configured)";
  }
  return null;
}

/**
 * Render the audit report for Telegram. The report is plain text — audit lines
 * are arbitrary redacted strings and MarkdownV2 would mangle them — so nothing
 * here goes through MarkdownV2 escaping; this message is sent without a parse
 * mode. Bounded twice over: the file read is capped and only the tail renders.
 */
export function renderAuditForTelegram(
  summary: AuditFileSummary,
  tail: number,
  locale?: Locale,
): string {
  const header = `*Audit* — ${summary.file}`;
  const report = renderAuditReport(summary, { tail });
  return `${header}\n\n${report}\n\n${messagesFor(locale).auditCliHint}`;
}

export const auditCommand = defineCommand({
  command: "audit",
  operatorOnly: true,
  availability: (context) => {
    const reason = auditUnavailableReason(context);
    return reason === null ? { available: true } : { available: false, reason };
  },
  handler: async (ctx, deps) => {
    const { config } = deps;
    const unavailableReason = auditUnavailableReason({ config, deps });
    if (unavailableReason !== null) {
      await ctx.reply(`Audit report is disabled: ${unavailableReason}.`, {
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    try {
      const file = deps.auditFile ?? config.auditFile;
      const summary = await readAuditFile(file);

      // The in-memory window also holds entries recorded since the last flush;
      // append any of those the file does not already contain (same entries
      // serialise identically) so the report is current without duplicates.
      const seen = new Set(summary.entries.map((e) => JSON.stringify(e)));
      const live = (deps.audit ? deps.audit.tail(AUDIT_TAIL) : []).filter(
        (e) => !seen.has(JSON.stringify(e)),
      );

      const merged: AuditFileSummary = {
        ...summary,
        entries: [...summary.entries, ...live].slice(-AUDIT_REPORT_MAX_ENTRIES),
      };
      await ctx.reply(renderAuditForTelegram(merged, AUDIT_TAIL, config.locale), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      await ctx.reply(`Audit report failed: ${safeErrorMessage(err, [config.botToken])}`);
    }
  },
});
