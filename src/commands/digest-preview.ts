/**
 * Hidden operator digest preview command (`/digest_preview`) and shared helper
 * used by `/preview digest`.
 *
 * Protected by `operatorOnly: true` (central registrar gate) so non-operators
 * receive silent ignore and cannot inspect pending digest state.
 */

import {
  renderOperatorDigestPreview,
  type PendingDigestSnapshot,
} from "../notifications/digest-grouping.js";
import { defineCommand, type CommandDeps } from "./registry.js";
import { replyMarkdown } from "./runtime.js";

export function renderPendingDigestForCommand(
  deps: Pick<CommandDeps, "pendingDigest">,
  nowMs?: number,
): string {
  const provider = deps.pendingDigest;
  if (!provider) {
    const empty: PendingDigestSnapshot = { events: [] };
    return renderOperatorDigestPreview(empty, { nowMs });
  }
  const source = typeof provider === "function" ? provider() : provider;
  return renderOperatorDigestPreview(source, { nowMs });
}

export const digestPreviewCommand = defineCommand({
  command: "digest_preview",
  hidden: true,
  operatorOnly: true,
  handler: async (ctx, deps) => {
    await replyMarkdown(ctx, renderPendingDigestForCommand(deps));
  },
});
