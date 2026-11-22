/** Stub: re-exports escapeMd from the canonical location. */
export { escapeMd } from "./notifications/format.js";

const DECIMAL_CHAT_ID = /^-?[1-9][0-9]*$|^0$/;

/**
 * Validates a Telegram chat identifier without converting it to a JS number.
 * Accepts `@channelusername` style handles and integer decimal strings (which may
 * be arbitrarily large or negative). Rejects fractional values, exponent notation,
 * whitespace, and anything else that could lose precision.
 */
export function normalizeTelegramChatId(input: string): string {
  const value = input.trim();
  if (value.startsWith("@")) {
    if (!/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(value)) {
      throw new Error(`Invalid Telegram channel username: ${input}`);
    }
    return value;
  }
  if (!DECIMAL_CHAT_ID.test(value)) {
    throw new Error(`Invalid Telegram chat ID: ${input}`);
  }
  return value;
}
