/**
 * Unknown-command handler for private chats.
 *
 * When a user types a command that the bot does not recognise, rather than
 * silently ignoring it (which is correct in groups — replying to every
 * misfire would be noisy), a private chat gets a short hint that names the
 * closest known command by Levenshtein edit distance.
 *
 * Rate-limiting: at most one hint per chat per HINT_COOLDOWN_MS. Hints in
 * rapid succession (typo-correction loops) are dropped silently so the bot
 * cannot be used to spam a chat with its own replies.
 */

/** How long to suppress repeated hints to the same chat, in milliseconds. */
export const HINT_COOLDOWN_MS = 30_000;

/** Cooldown map: chatId → timestamp of last hint sent. */
const lastHintAt = new Map<number, number>();

/**
 * Returns the Levenshtein edit distance between two strings.
 * Bounded at `Math.max(a.length, b.length)` — no allocation for the full
 * matrix when the strings diverge early.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row rolling matrix; O(|b|) space.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Indices stay within 0..b.length, so every read below is defined.
      curr[j] = Math.min(
        curr[j - 1]! + 1,       // insert
        prev[j]! + 1,           // delete
        prev[j - 1]! + cost,    // substitute
      );
    }
    // Swap rows: curr becomes the new prev for the next iteration.
    [prev, curr] = [curr, prev];
  }

  return prev[b.length]!;
}

/**
 * Closest command suggestion for `text`, or `null` when the input is too
 * far from every known command to be a useful suggestion.
 *
 * Rules:
 * - `text` should be the bare command name (no leading `/`, no `@bot` suffix).
 * - Only suggests when the edit distance is ≤ 3 (avoids wild guesses).
 * - Ties are broken by the order of `knownCommands`.
 */
export function closestCommand(
  text: string,
  knownCommands: readonly string[],
): string | null {
  if (knownCommands.length === 0) return null;

  const input = text.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;

  for (const cmd of knownCommands) {
    const dist = levenshtein(input, cmd.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }

  // Never suggest when the input is completely unlike every known command.
  return bestDist <= 3 ? best : null;
}

/**
 * The hint text sent to a private chat.
 *
 * @param typed        - The command the user typed (without leading `/`).
 * @param suggestion   - The closest known command (without leading `/`), or
 *                       null when no good match exists.
 * @returns A plain-text string ready to send.
 */
export function unknownCommandReply(
  typed: string,
  suggestion: string | null,
): string {
  const base = `Unknown command: /${typed}`;
  if (suggestion === null) return `${base}. Type /help to see available commands.`;
  return `${base}. Did you mean /${suggestion}?`;
}

/**
 * Returns true when the hint throttle allows sending to `chatId` at `nowMs`.
 * Calling this does NOT record the send — call `recordHint` after the reply
 * succeeds to keep the rate-limit state consistent.
 */
export function canSendHint(chatId: number, nowMs: number = Date.now()): boolean {
  const last = lastHintAt.get(chatId);
  return last === undefined || nowMs - last >= HINT_COOLDOWN_MS;
}

/** Record that a hint was sent to `chatId` at `nowMs`. */
export function recordHint(chatId: number, nowMs: number = Date.now()): void {
  lastHintAt.set(chatId, nowMs);
}

/**
 * Clear the rate-limit state for a specific chat, or for all chats when
 * called with no argument. Intended for tests only.
 */
export function clearHintState(chatId?: number): void {
  if (chatId === undefined) {
    lastHintAt.clear();
  } else {
    lastHintAt.delete(chatId);
  }
}
