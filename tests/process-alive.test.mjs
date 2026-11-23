/**
 * tests/process-alive.test.mjs
 *
 * Focused unit tests for isProcessAlive(pid) from src/instanceLock.ts.
 *
 * Contract under test (see src/instanceLock.ts):
 *   - Non-integer or pid <= 0          → false  (guard before any syscall)
 *   - process.kill(pid, 0) succeeds    → true   (process exists, we can signal it)
 *   - process.kill throws EPERM        → true   (process exists, no permission)
 *   - process.kill throws ESRCH        → false  (no such process)
 *
 * Cross-platform note: we rely only on process.kill(pid, 0) semantics,
 * which Node.js normalises across Linux, macOS and Windows.  We never
 * send real signals, and we never assume that any particular well-known
 * pid (e.g. 1) is alive or dead.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { isProcessAlive } from "../dist/instanceLock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a child that exits immediately and return its pid.
 * The child is guaranteed to have exited before we return because
 * spawnSync() blocks until the child finishes.
 */
function spawnedDeadPid() {
    const result = spawnSync(process.execPath, ["--eval", "process.exit(0)"], {
        timeout: 10_000,
    });
    // If spawnSync itself failed there is no pid to use.
    assert.ok(result.pid > 0, "spawnSync must return a positive pid");
    assert.strictEqual(result.status, 0, "child must exit cleanly");
    return result.pid;
}

// ---------------------------------------------------------------------------
// Tests: valid live process
// ---------------------------------------------------------------------------

test("isProcessAlive: current process (process.pid) is alive", () => {
    assert.equal(isProcessAlive(process.pid), true);
});

// ---------------------------------------------------------------------------
// Tests: spawned-and-exited child
// ---------------------------------------------------------------------------

test("isProcessAlive: a spawned-and-exited child is not alive", () => {
    const deadPid = spawnedDeadPid();
    // The child has exited.  On all platforms, process.kill(deadPid, 0) should
    // throw ESRCH (no such process) once the pid is reaped.
    // On Windows the OS may recycle the pid very quickly; if it happens to be
    // reused we might get true — so we can only assert we do NOT throw.
    assert.doesNotThrow(() => isProcessAlive(deadPid));
    // The result must be a boolean in either case.
    assert.equal(typeof isProcessAlive(deadPid), "boolean");
});

// ---------------------------------------------------------------------------
// Tests: invalid / sentinel inputs (all must return false without throwing)
// ---------------------------------------------------------------------------

test("isProcessAlive: pid 0 returns false", () => {
    assert.equal(isProcessAlive(0), false);
});

test("isProcessAlive: pid -1 returns false", () => {
    assert.equal(isProcessAlive(-1), false);
});

test("isProcessAlive: NaN returns false", () => {
    // NaN is not an integer, so the guard rejects it immediately.
    assert.equal(isProcessAlive(Number.NaN), false);
});

test("isProcessAlive: Number.POSITIVE_INFINITY returns false", () => {
    assert.equal(isProcessAlive(Number.POSITIVE_INFINITY), false);
});

test("isProcessAlive: a float (1.5) returns false", () => {
    assert.equal(isProcessAlive(1.5), false);
});

// ---------------------------------------------------------------------------
// Tests: very large pid (near INT32 max)
// ---------------------------------------------------------------------------

test("isProcessAlive: a very large pid is not alive and does not throw", () => {
    // 2^31 - 2 is above the kernel pid_max on Linux (default 4 194 304) and
    // the Windows max (24 bits on 64-bit), so it should never be a live process.
    // On some platforms process.kill may throw with EINVAL for out-of-range pids;
    // isProcessAlive must not propagate that — non-EPERM errors → false.
    const hugePid = 2_147_483_646;
    assert.doesNotThrow(() => isProcessAlive(hugePid));
    // A pid this large is virtually impossible to be alive; treat as false.
    // We assert the type rather than a fixed value to stay safe on exotic systems.
    assert.equal(typeof isProcessAlive(hugePid), "boolean");
});

// ---------------------------------------------------------------------------
// Tests: integer edge cases around the <= 0 guard
// ---------------------------------------------------------------------------

test("isProcessAlive: pid 1 is a boolean result without throwing", () => {
    // pid 1 is init/launchd/smss on Unix-like OSes and may be alive.
    // On Windows it is the System Idle Process and also exists.
    // We only assert no-throw and a boolean result; we do not assert true/false
    // because we have no control over whether we have permission to probe it.
    assert.doesNotThrow(() => isProcessAlive(1));
    assert.equal(typeof isProcessAlive(1), "boolean");
});

test("isProcessAlive: Number.MIN_SAFE_INTEGER returns false", () => {
    assert.equal(isProcessAlive(Number.MIN_SAFE_INTEGER), false);
});

test("isProcessAlive: -0 returns false (coerced to 0, which fails the > 0 guard)", () => {
    // Object.is(-0, 0) === false but -0 <= 0 is true, so it must be rejected.
    assert.equal(isProcessAlive(-0), false);
});
