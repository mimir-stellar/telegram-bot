/** Inclusive ledger bounds shared by archive and JSONL compaction. */
export interface LedgerRange {
  /** Inclusive lower bound (ledger sequence number, >= 1). */
  firstLedger: number;
  /** Inclusive upper bound (ledger sequence number). */
  lastLedger: number;
}

/**
 * Validates an inclusive ledger range.
 *
 * @throws {RangeError} when a bound is not a safe integer or the range is
 * inverted. Ledger sequence numbers start at 1.
 */
export function validateLedgerRange(range: LedgerRange): void {
  const { firstLedger, lastLedger } = range;
  if (!Number.isSafeInteger(firstLedger) || !Number.isSafeInteger(lastLedger)) {
    throw new RangeError("firstLedger and lastLedger must be integers");
  }
  if (firstLedger < 1) {
    throw new RangeError(`firstLedger must be >= 1, got ${firstLedger}`);
  }
  if (firstLedger > lastLedger) {
    throw new RangeError(
      `firstLedger (${firstLedger}) must be <= lastLedger (${lastLedger})`,
    );
  }
}
