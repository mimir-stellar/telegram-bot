/**
 * Address book for labeling known Stellar addresses.
 *
 * Loads a JSON file of `{ address, label }` entries, validates strkeys and
 * labels, and watches for file changes with debounced reload. Parse errors
 * keep the previous book intact and report line context.
 *
 * Labels are sanitized and bounded before display: whitespace is trimmed,
 * length is capped, and special characters are restricted to printable ASCII.
 */

import { readFile } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";

import { shortAddress } from "./decode.js";

/** Maximum label length in characters. */
const MAX_LABEL_CHARS = 64;

/** Minimum label length in characters. */
const MIN_LABEL_CHARS = 1;

/** Allowed characters in labels: printable ASCII, excluding control chars. */
const LABEL_RE = /^[\x20-\x7E]+$/;

/** Stellar account strkey pattern (G...). */
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

/** Stellar contract strkey pattern (C...). */
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;

/** Debounce delay for file changes (milliseconds). */
const RELOAD_DEBOUNCE_MS = 1000;

/**
 * A single address book entry.
 */
export interface AddressEntry {
  /** Full Stellar address strkey (G... or C...). */
  address: string;
  /** Human-readable label. */
  label: string;
}

/**
 * Error during address book parsing with line context.
 */
export interface AddressBookParseError {
  line: number;
  reason: string;
}

/**
 * Snapshot of the address book state for diagnostics.
 */
export interface AddressBookSnapshot {
  /** Number of valid entries loaded. */
  entryCount: number;
  /** Parse errors from the last load attempt. */
  errors: AddressBookParseError[];
  /** File path being watched (if any). */
  filePath: string | null;
}

/**
 * Options for creating an address book.
 */
export interface AddressBookOptions {
  /** Debounce delay for file changes in milliseconds. */
  reloadDebounceMs?: number;
}

/**
 * Address book with hot-reload support.
 *
 * Loads addresses from a JSON file, validates each entry, and watches for
 * changes. Invalid entries are skipped and reported with line context.
 * Parse errors never replace a working book.
 */
export class AddressBook {
  entries: Map<string, string> = new Map();
  private filePath: string | null = null;
  private fsWatcher: FSWatcher | null = null;
  watcher: AbortController | null = null;
  private reloadTimeout: NodeJS.Timeout | null = null;
  private lastErrors: AddressBookParseError[] = [];
  private readonly reloadDebounceMs: number;

  constructor(options: AddressBookOptions = {}) {
    this.reloadDebounceMs = options.reloadDebounceMs ?? RELOAD_DEBOUNCE_MS;
  }

  /**
   * Load addresses from a JSON file.
   *
   * The file should contain an array of `{ address, label }` objects.
   * Invalid entries are skipped and reported. Parse errors keep the previous
   * book intact.
   *
   * @param filePath Path to the JSON file
   * @returns Number of valid entries loaded
   */
  async load(filePath: string): Promise<number> {
    if (!existsSync(filePath)) {
      this.lastErrors = [
        { line: 0, reason: "File does not exist" },
      ];
      return 0;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        this.lastErrors = [
          { line: 1, reason: "Root must be an array" },
        ];
        return 0;
      }

      const newEntries = new Map<string, string>();
      const errors: AddressBookParseError[] = [];

      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        const line = i + 1;

        if (!entry || typeof entry !== "object") {
          errors.push({ line, reason: "Entry must be an object" });
          continue;
        }

        const { address, label } = entry;

        if (typeof address !== "string") {
          errors.push({ line, reason: "address must be a string" });
          continue;
        }

        if (typeof label !== "string") {
          errors.push({ line, reason: "label must be a string" });
          continue;
        }

        const addressError = this.validateAddress(address);
        if (addressError) {
          errors.push({ line, reason: addressError });
          continue;
        }

        const labelError = this.validateLabel(label);
        if (labelError) {
          errors.push({ line, reason: labelError });
          continue;
        }

        const sanitized = this.sanitizeLabel(label);
        newEntries.set(address, sanitized);
      }

      // Only replace the book if we successfully parsed at least one entry
      if (newEntries.size > 0 || errors.length === 0) {
        this.entries = newEntries;
        this.lastErrors = errors;
      } else {
        this.lastErrors = errors;
      }

      return this.entries.size;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastErrors = [
        { line: 0, reason: `Parse error: ${message}` },
      ];
      return this.entries.size;
    }
  }

  /**
   * Load and watch a file for changes.
   *
   * Reloads the file when it changes, with debouncing to avoid rapid reloads.
   * If the file is missing or fails to parse, the previous book is kept.
   *
   * @param filePath Path to the JSON file
   */
  async watch(filePath: string): Promise<void> {
    await this.stopWatching();
    this.filePath = filePath;
    this.watcher = new AbortController();

    try {
      await this.load(filePath);

      // Use fs.watch instead of watchFile (which doesn't exist in fs/promises)
      this.fsWatcher = watch(filePath, (eventType) => {
        if (eventType === "change") {
          this.scheduleReload();
        }
      });
    } catch (err) {
      // Watch failures are logged but don't crash the process
      console.error(`[address-book] watch failed: ${err}`);
    }
  }

  /**
   * Stop watching the file (if any).
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      this.watcher.abort();
      this.watcher = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
    this.filePath = null;
  }

  /**
   * Get a labeled representation of an address.
   *
   * Returns `"label (GABC…XYZ)"` for known addresses, or the short address
   * form `"GABC…XYZ"` for unknown addresses.
   *
   * @param address Stellar address strkey
   * @returns Labeled or short address
   */
  labelFor(address: string): string {
    const label = this.entries.get(address);
    if (label) {
      return `${label} (${shortAddress(address)})`;
    }
    return shortAddress(address);
  }

  /**
   * Get a snapshot of the address book state.
   */
  snapshot(): AddressBookSnapshot {
    return {
      entryCount: this.entries.size,
      errors: [...this.lastErrors],
      filePath: this.filePath,
    };
  }

  /**
   * Validate a Stellar address strkey.
   *
   * @param address Address to validate
   * @returns Error message or null if valid
   */
  validateAddress(address: string): string | null {
    if (ACCOUNT_RE.test(address)) return null;
    if (CONTRACT_RE.test(address)) return null;
    return "Invalid Stellar strkey (must be G... or C...)";
  }

  /**
   * Validate a label string.
   *
   * @param label Label to validate
   * @returns Error message or null if valid
   */
  validateLabel(label: string): string | null {
    const trimmed = label.trim();
    if (trimmed.length < MIN_LABEL_CHARS) {
      return `Label too short (minimum ${MIN_LABEL_CHARS} character)`;
    }
    if (trimmed.length > MAX_LABEL_CHARS) {
      return `Label too long (maximum ${MAX_LABEL_CHARS} characters)`;
    }
    if (!LABEL_RE.test(trimmed)) {
      return "Label contains invalid characters (printable ASCII only)";
    }
    return null;
  }

  /**
   * Sanitize a label for display.
   *
   * Trims whitespace and clamps to maximum length.
   *
   * @param label Label to sanitize
   * @returns Sanitized label
   */
  sanitizeLabel(label: string): string {
    const trimmed = label.trim();
    return trimmed.slice(0, MAX_LABEL_CHARS);
  }

  /**
   * Schedule a debounced reload of the watched file.
   */
  private scheduleReload(): void {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
    }
    this.reloadTimeout = setTimeout(() => {
      void this.reload();
    }, this.reloadDebounceMs);
  }

  /**
   * Reload the watched file (called after debounce).
   */
  private async reload(): Promise<void> {
    if (this.filePath) {
      await this.load(this.filePath);
    }
  }
}

/**
 * Create an address book.
 */
export function createAddressBook(options: AddressBookOptions = {}): AddressBook {
  return new AddressBook(options);
}
