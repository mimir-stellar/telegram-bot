# RPC Network Passphrase Verification Implementation (#36)

## Overview

This implementation adds verification that the RPC's reported network passphrase matches the configured value (`STELLAR_NETWORK_PASSPHRASE`). The check runs once at boot, as a safety-critical configuration validation, ensuring the read-only notifier remains reliable and cannot inadvertently emit notifications on the wrong Stellar network.

## Changes Made

### 1. Core Implementation (`src/stellar/client.ts`)

#### New Error Type
- **`NetworkPassphraseMismatchError`**: Extends Error with a `problem` discriminant
  - Three problem types:
    - `"mismatch"`: RPC passphrase does not match configured value
    - `"missing"`: getNetwork() call failed or passphrase was not in response
    - `"malformed"`: Response passphrase is not a string or is missing

#### New Type
- **`NetworkPassphraseProblem`**: Union type of the three problem values above

#### New Function
- **`validateNetworkPassphrase(server: rpc.Server, config: StellarConfig): Promise<void>`**
  - Calls `server.getNetwork()` to fetch the RPC's network configuration
  - Validates the response contains a string `passphrase` field
  - Performs exact case-sensitive comparison against `config.networkPassphrase`
  - Throws `NetworkPassphraseMismatchError` on any validation failure
  - Never leaks actual passphrases in error messages—only character counts for diagnostic context

#### Helper Function
- **`boundedRemoteError(err: unknown): string`**
  - Safely renders error messages from remote calls without echoing unbounded payloads
  - Truncates to 100 characters, collapses whitespace
  - Used for sanitizing `getNetwork()` exceptions in error messages

### 2. Boot Integration (`src/index.ts`)

- Imported `validateNetworkPassphrase` from `src/stellar/client.ts`
- Added validation call immediately after `waitForStartupHealth()` succeeds
- Wraps call in try-catch:
  - **Success**: Logs `[boot] network passphrase verified`
  - **Failure**: Logs `[fatal]` message and exits with code 1 (fail-fast)

### 3. Testing (`tests/network-passphrase.test.mjs`)

21 comprehensive tests covering:

**Positive cases:**
- Passphrase match succeeds without throwing
- Empty string passphrase matches when configured as empty

**Negative cases:**
- Passphrase mismatch: bounded error with character counts
- Missing passphrase field: malformed response
- Non-string passphrase: malformed response  
- Null passphrase: malformed response
- RPC error: network failure
- Empty object response: malformed response

**Boundary & safety cases:**
- Case-sensitive comparison (not tolerant of case differences)
- Whitespace significance (exact string match required)
- Error messages never contain actual passphrases (bounded to ~100 chars)
- Error object has correct name and problem discriminant

**Result:** 21/21 tests passing, no regressions (725/725 total)

## Failure Modes & Handling

### Scenario 1: RPC Pointed at Wrong Network
**Problem:** `STELLAR_RPC_URL` points to Public Stellar, but `STELLAR_NETWORK_PASSPHRASE` is configured for Testnet.

**Detection:** `validateNetworkPassphrase()` sees RPC passphrase "Public Global Stellar Network..." but config has "Test SDF Network...".

**Output:** Boot log:
```
[fatal] network passphrase verification failed: RPC network passphrase does not match the configured value (configured=34 chars, received=28 chars)
```

**Result:** Process exits code 1, preventing silent misconfiguration.

### Scenario 2: Wrong Configuration
**Problem:** `STELLAR_NETWORK_PASSPHRASE` is mistyped or mismatched against actual RPC network.

**Detection:** Same as Scenario 1 (bounded detection, either way).

**Output:** Identical error with character counts—operator can quickly verify the value by counting characters.

**Result:** Process exits code 1, configuration is fixed in `.env` before retry.

### Scenario 3: RPC Network Endpoint Fails
**Problem:** `getNetwork()` call fails (connection timeout, 500 error, transient network failure).

**Output:** Boot log:
```
[fatal] network passphrase verification failed: getNetwork failed: connection refused (truncated if needed)
```

**Result:** Process exits code 1. Operator checks RPC connectivity and retries.

### Scenario 4: RPC Response Malformed
**Problem:** `getNetwork()` returns valid JSON but lacks `passphrase` or it's not a string (e.g., `{ protocolVersion: "22.1.0" }`).

**Output:** Boot log:
```
[fatal] network passphrase verification failed: RPC getNetwork returned a malformed passphrase (expected a string; got undefined)
```

**Result:** Process exits code 1. Indicates RPC version mismatch or corruption.

---

## Design Principles Applied

1. **Fail-Fast for Safety**: Network passphrase is a safety-critical misconfiguration; failing at boot prevents silent notification on the wrong chain.

2. **Bounded Error Messages**: No raw RPC payloads or actual passphrases in logs. Only character counts, bounded lengths (~100 chars), sanitized error text.

3. **Read-Only Preservation**: The check uses only `getNetwork()` (read-only), no signing or key material ever touched.

4. **Exact Comparison**: Case-sensitive, character-for-character match. Testnet and Public passphrases are standardized strings; no fuzzy matching.

5. **Operator-Friendly Diagnostics**: When a mismatch occurs, the character counts let operators verify by counting or comparing the actual passphrases in their config and on the chain.

---

## Compatibility

- **Backward Compatible**: No schema changes, no breaking API changes to existing functions.
- **Configuration**: Uses existing `STELLAR_NETWORK_PASSPHRASE` env var (already loaded in config).
- **RPC API**: Calls only `getNetwork()`, supported by all Stellar Soroban RPC implementations.
- **Cursor/Poller**: No impact on cursor schema, event processing, or persistence.

---

## Testing & Verification

- ✅ **TypeScript typecheck**: No errors
- ✅ **Build**: Successful
- ✅ **All tests**: 725/725 passing (includes 21 new passphrase verification tests)
- ✅ **No regressions**: All existing tests remain green

---

## Deployment Impact

**On First Deploy (with this change):**
- Boot sequence: `getHealth()` → `validateNetworkPassphrase()` → proceed or exit
- If misconfigured: Process exits with clear error, deploy fails fast
- If correct: Single log line `[boot] network passphrase verified`, no latency

**On Subsequent Deploys:**
- Existing deployments already have correct `STELLAR_NETWORK_PASSPHRASE` set—verification passes silently
- New deployments catch configuration errors before becoming a running-but-broken notifier

---

## Rollback

If needed, simply redeploy the previous version. The check is additive and non-disruptive:
- No cursor format changes
- No configuration schema changes
- Previous build will simply omit this verification
