# On-Disk State Files

Operational reference describing all on-disk state files maintained by the Mimir Telegram notifier, their environment variables, default paths, writer modules, write patterns, and recovery behaviors.

## State Files Reference Table

| File | Environment Variable | Default Path (Relative / Resolved) | Writer Module | Write Pattern | Behavior if Deleted | Behavior if Corrupt |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Cursor File** | `CURSOR_FILE` | `./data/cursor.json` | `src/poller.ts` | Atomic (write temporary file `${CURSOR_FILE}.tmp` then rename) | Treated as cold start: poller starts scanning `START_LOOKBACK_LEDGERS` (default 60) behind chain tip. A fresh cursor file is written on the next successful cycle. | Quarantined to `${CURSOR_FILE}.corrupt.<timestamp>` to preserve forensics, then treated as cold start (`START_LOOKBACK_LEDGERS` behind tip). |
| **Cursor Backup Copy** | None (derived from cursor file) | `./data/cursor.json.bak` | `src/poller.ts` | Direct copy (`copyFile` from committed primary cursor file after each write) | Harmless during runtime. Available as a manual recovery fallback if the primary cursor is lost or quarantined. | Non-fatal during runtime. Ignored by poller startup (poller loads primary `CURSOR_FILE`). Operators should replace or delete the bad backup. |
| **Cursor Backup Metadata** | None (derived from cursor file) | `./data/cursor.json.backup-meta.json` | `src/poller.ts`, `src/cursor-cli.ts` | Atomic write-then-rename (`.tmp` then rename) | Non-fatal. Poller falls back to reading `.bak` copy for rollback detection if present. | Non-fatal. Unreadable metadata is logged and skipped without halting startup. |
| **Cursor Quarantine Copy** | None (derived from cursor file) | `./data/cursor.json.corrupt.<timestamp>` | `src/poller.ts` | Atomic rename of the live corrupt cursor file | Safe to delete once post-incident forensics and diagnosis are complete. Not loaded by runtime. | N/A (forensic artifact preserved for investigation; runtime ignores quarantine files). |
| **Dead-Letter Queue File** | `DEAD_LETTER_FILE` | `./data/dead-letter.json` | `src/deadLetter.ts` | Atomic (write temporary file `${DEAD_LETTER_FILE}.tmp` then rename) | Treated as empty queue on boot. If deleted while running, re-created on the next failed send enqueue or persist. Unsent parked messages previously queued are lost unless recovered from backups. | Logged with a warning (`[dead-letter] unreadable queue... starting empty`). Queue initializes empty in memory; subsequent persists overwrite with valid state. |
| **Audit Trail File** | `AUDIT_FILE` | `./data/audit.jsonl` | `src/audit.ts` | Append (`appendFile` with JSON line per entry) | If absent, automatically created on next append. Historical audit records prior to deletion are lost. | `/audit` skips unreadable/malformed lines (`unreadableLines` count incremented) and processes valid lines. poller append operations continue appending new entries. |
| **Archive Manifest File** | `ARCHIVE_MANIFEST_FILE` | `./data/archive.manifest.json` | `src/stellar/archive.ts` | Atomic (write temporary file `${ARCHIVE_MANIFEST_FILE}.tmp` then rename) | Archive verification reports the manifest as missing; exported archives without a manifest cannot be verified and must be re-exported. | Verification fails closed with a manifest-parse error; the corrupt manifest is never used to accept records. Re-export to regenerate. |
| **Status Snapshot File** | `STATUS_FILE` | `./data/status.json` | `src/status.ts` | Atomic (write temporary file `${STATUS_FILE}.tmp` then rename) | Harmless to poller loop. Recreated atomically on the next poll cycle. CLI `--status` command will fail to find status until rewritten. | Overwritten atomically on the next poll cycle. External tools or CLI reading corrupt file before next cycle encounter parse errors. |
| **Instance Lock File** | `INSTANCE_LOCK_FILE` | `./data/poller.lock` | `src/instanceLock.ts` | Exclusive file creation (`O_EXCL` / `wx` flag via `open`) | Poller will re-acquire lock on next startup if no other instance holds it. During runtime, removal removes concurrency protection against double instances. | Stale or unparseable lock payload (non-JSON, bad schema, or dead PID) is warned and automatically unlinked by next acquiring instance. |
| **Operational JSONL Log** *(optional)* | `LOG_FILE` (`LOG_FILE_MAX_BYTES`, `LOG_FILE_MAX_FILES`) | Disabled unless `LOG_FILE` is set (10 MiB, 5 files) | `src/logger.ts` | Serialized append with size rotation (`<LOG_FILE>` + `.1`..`.N-1`) | Recreated on the next log emission; rotated history is not restored. | Malformed historical lines are ignored by rotation; disk failures are reported distinctly on stderr and counted in `Logger.getJsonlStats()`. |

---

## Detailed Component Behaviors

### 1. Cursor File (`CURSOR_FILE`)
- **Writer Module**: [`src/poller.ts`](../src/poller.ts) (`saveCursors`, `loadCursors`, `quarantineCorruptCursorFile`)
- **Default Path**: `./data/cursor.json` (configured via `DEFAULTS.cursorFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Atomic write-then-rename (`${cursorFile}.tmp` -> `${cursorFile}`) on every successful scan commit, graceful shutdown flush, or schema migration.
- **Deleted**: Poller logs that no cursor was found and falls back to a cold start lookback `START_LOOKBACK_LEDGERS` (default: 60 ledgers) behind the chain tip.
- **Corrupt**: If JSON is invalid or fails schema validation (or references an unsupported future schema version), `quarantineCorruptCursorFile` moves the corrupt file aside to `${cursorFile}.corrupt.<timestamp>` and starts cold.
- **Recovery Generation & Rollback Detection**: Includes a monotonic `recoveryGeneration` counter. On boot, poller compares this generation and target ledger positions against companion backup metadata (`${cursorFile}.backup-meta.json` or `${cursorFile}.bak`). If an older backup has replaced the live cursor without explicit operator acknowledgement (`ACKNOWLEDGE_CURSOR_REPLAY=true` or restore `--ack-replay`), startup is aborted to prevent unintended duplicate notification delivery.
- **Recovery History**: Retains an optional, additive `recoveryHistory` array (bounded to the 20 most-recent entries) recording automatic floor rewinds (`floor_rewind`), operator restores (`restore`), and corrupt-file quarantines (`quarantine`) with UTC timestamp, reason, and before/after position metadata only (no event payloads, event IDs, or secrets). Malformed history entries are dropped on load without discarding resume positions.

### 2. Cursor Backup Copy & Backup Metadata
- **Writer Module**: [`src/poller.ts`](../src/poller.ts) (`saveCursors`), [`src/cursor-cli.ts`](../src/cursor-cli.ts) (`backupCursor`)
- **Default Paths**: `${cursorFile}.bak` and companion metadata `${cursorFile}.backup-meta.json`
- **Write Pattern**: Direct copy (`copyFile`) to `.bak` and atomic write of `.backup-meta.json` after primary cursor commit.
- **Recovery Role**: Acts as an offline recovery snapshot and records monotonic recovery generation and position watermarks for startup rollback detection.

### 3. Cursor Quarantine Copy
- **Writer Module**: [`src/poller.ts`](../src/poller.ts) (`quarantineCorruptCursorFile`)
- **Default Path**: `${cursorFile}.corrupt.<YYYY-MM-DDTHH-mm-ss-sssZ>`
- **Write Pattern**: Atomic `rename` of the corrupt primary cursor file.
- **Recovery Role**: Preserves corrupt bytes for forensic examination without blocking the poller from starting cold.

### 4. Dead-Letter Queue File (`DEAD_LETTER_FILE`)
- **Writer Module**: [`src/deadLetter.ts`](../src/deadLetter.ts) (`createDeadLetterQueue`)
- **Default Path**: `./data/dead-letter.json` (configured via `DEFAULTS.deadLetterFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Atomic write-then-rename (`${filePath}.tmp` -> `${filePath}`) on message enqueue, failed replay, or successful delivery.
- **Deleted**: Treated as empty queue on startup; created upon first persisted failure.
- **Corrupt**: Emits warning `[dead-letter] unknown or corrupt queue... starting empty` and starts empty without throwing into the poll loop.

### 5. Audit Trail File (`AUDIT_FILE`)
- **Writer Module**: [`src/audit.ts`](../src/audit.ts) (`appendAuditFile`)
- **Default Path**: `./data/audit.jsonl` (configured via `DEFAULTS.auditFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Append-only (`appendFile`) with newline-delimited JSON (`JSONL`).
- **Deleted**: Missing file is automatically created upon next audit flush.
- **Corrupt**: Reading via `readAuditFile` counts and skips corrupt lines without aborting. Appending continues normally.

### 6. Archive Manifest File (`ARCHIVE_MANIFEST_FILE`)
- **Writer Module**: [`src/stellar/archive.ts`](../src/stellar/archive.ts) (manifest writer and verifier)
- **Default Path**: `./data/archive.manifest.json` (configured via `DEFAULTS.archiveManifestFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Atomic write-then-rename (`${file}.tmp` -> `${file}`) when an event archive is exported.
- **Content**: A hash-chained manifest binding each ordered record (by SHA-256 chain link), the network passphrase, and the first/last ledger bounds of the archive to a single root digest.
- **Verification**: Missing, reordered, or altered records cause verification to fail; the manifest is never trusted to accept records it does not cover.
- **Deleted**: Archive verification reports the manifest as missing. Exported archives without a manifest cannot be verified and must be re-exported.
- **Corrupt**: Verification fails closed with a manifest-parse error. Re-export to regenerate.

### 7. Status Snapshot File (`STATUS_FILE`)
- **Writer Module**: [`src/status.ts`](../src/status.ts) (`writeStatusFile`)
- **Default Path**: `./data/status.json` (configured via `DEFAULTS.statusFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Atomic write-then-rename (`${file}.tmp` -> `${file}`) on each poll cycle.
- **Deleted**: Recreated on next poll cycle.
- **Corrupt**: Replaced atomically on next cycle write.

### 8. Instance Lock File (`INSTANCE_LOCK_FILE`)
- **Writer Module**: [`src/instanceLock.ts`](../src/instanceLock.ts) (`acquireInstanceLock`)
- **Default Path**: `./data/poller.lock` (configured via `DEFAULTS.lockFile` in [`src/config.ts`](../src/config.ts))
- **Write Pattern**: Exclusive file descriptor open (`open(lockFile, "wx")`).
- **Deleted**: Frees lock if deleted while stopped. If deleted while running, secondary processes could race.
- **Corrupt**: Stale lock cleanup checks whether PID is running; if file cannot be parsed or PID is dead/unresponsive, the lock is unlinked and reclaimed.

### 8. Event Archive Files
- **Writer Module**: [`src/stellar/archive.ts`](../src/stellar/archive.ts) (`createEventArchive`, `readArchive`)
- **Default Path**: Configured archive directory (`events-<timestamp>-<index>.jsonl`)
- **Write Pattern**: Rotating JSON Lines (`JSONL`) files with `0o600` permissions. Each record is explicitly stamped with `schemaVersion: 1`.
- **Deleted**: Directory and files are recreated on subsequent append operations.
- **Corrupt / Unknown Version**: `readArchive` validates JSON and schema versions using migration adapters (`migrateArchivedRecord`, `adaptArchivedTypedEvent`, `adaptArchivedGenericEvent`). Legacy unversioned formats (including `blockTime`, `txIndex`, and unversioned envelopes) are transparently migrated to schema version 1. Unknown schema versions reject and throw `UnsupportedArchiveVersionError` without leaking payload contents; passing `retainCommitted: true` yields valid preceding records.
