import { formatUsdc } from '../stellar/decode.js';

export interface DisplayUsdoptions {
  minDecimals?: number;
  maxDecimals?: number;
}

const USDC_DECIMALS = 7;
const DEFAULT_MIN_DECIMALS = 0;
const DEFAULT_MAX_DECIMALS = 2;

/**
 * Format a USDC amount (in strops) for human-display in notifications.
 *
 * Unlike `formatUsdc`, this groups integer digits with commas and trims
 * trailing zeros down to `minDecimals`. It never converts to `number`, so
 * large (> 2^63) and sub-cent amounts remain exact.
 */
export function displayUsdc(
  units: bigint | string,
  options: DisplayUsdoptions = {},
): string {
  const minDecimals = normalizeDecimals(
    options.minDecimals,
    DEFAULT_MIN_DECIMALS,
    'minDecimals',
  );
  const maxDecimals = normalizeDecimals(
    options.maxDecimals,
    DEFAULT_MAX_DECIMALS,
    'maxDecimals',
  );

  if (minDecimals > maxDecimals) {
    throw new RangeError(
      `minDecimals (${minDecimals}) must not exceed maxDecimals (${maxDecimals})`,
    );
  }

  // BigInt("") and BigInt("  ") are 0n; an empty amount is a caller bug, not
  // zero, so it must not render as "0".
  if (typeof units === 'string' && units.trim() === '') {
    throw new SyntaxError('USDC amount must not be empty');
  }
  const raw = formatUsdc(typeof units === 'bigint' ? units : BigInt(units));
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [parts, fractionPart = ''] = unsigned.split('.');
  const integerPart = parts ?? '0';

  // formatUsdc always emits USDC_DECIMALS fraction digits. Trim trailing
  // zeros down to minDecimals, and cap at maxDecimals.
  const padded = fractionPart.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  const capped = padded.slice(0, maxDecimals);
  let trimmed = capped.replace(/0+$/, '');
  if (trimmed.length < minDecimals) {
    trimmed = capped.slice(0, minDecimals);
  }

  const grouped = groupDigits(integerPart);
  const body = trimmed.length > 0 ? `${grouped}.${trimmed}` : grouped;
  return negative ? `-${body}` : body;
}

/**
 * Escape a string for Telegram MarkdownV2: every reserved character
 * (`_*[]()~\`>#+-=|{}.!`) gets a backslash. `-` matters most here, since a
 * negative amount would otherwise be rejected by Telegram's entity parser.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (match) => `\\${match}`);
}

/**
 * Format and then MarkdownV2-escape a USDC amount for notification rendering.
 */
export function displayUsdcMarkdownV2(
  units: bigint | string,
  options: DisplayUsdoptions = {},
): string {
  return escapeMarkdownV2(displayUsdc(units, options));
}

function normalizeDecimals(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0 || value > USDC_DECIMALS) {
    throw new RangeError(
      `${name} must be an integer between 0 and ${USDC_DECIMALS}`,
    );
  }
  return value;
}

function groupDigits(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (i - digits.length) % 3 === 0) {
      out += ',';
    }
    out += digits[i];
  }
  return out;
}
