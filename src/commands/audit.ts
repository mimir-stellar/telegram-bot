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
import { defineCommand } from "./registry.js";

/** How many recent audit lines `/audit` renders. A chat message is not a file. */
const AUDIT_TAIL = 10;

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
  handler: async (ctx, deps) => {
    const { config } = deps;
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
