import assert from "node:assert/strict";
import test from "node:test";
import { paginatedGetEvents } from "../dist/stellar/events.js";

test("stale cursor is dropped and falls back to startLedger / oldestLedger", async () => {
  const fakeServer = {
    getHealth: async () => ({
      oldestLedger: 5000,
      latestLedger: 5100,
    }),
    getEvents: async (req) => {
      // If the stale cursor is used, it should have been discarded!
      if (req.cursor === "4000-1") {
        throw new Error("RPC should not be called with stale cursor");
      }
      return {
        events: [],
        latestLedger: 5100,
        cursor: "5100-1"
      };
    }
  };

  const scan = await paginatedGetEvents(fakeServer, [], { cursor: "4000-1", maxPages: 1 });
  assert.equal(scan.oldestLedger, 5000);
  assert.equal(scan.cursor, "5100-1");
});
