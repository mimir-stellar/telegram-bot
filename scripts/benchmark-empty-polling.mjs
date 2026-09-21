import { performance } from "node:perf_hooks";

import { paginatedGetEvents } from "../src/stellar/events.ts";

const EMPTY_PAGES = 1_000;
const ITERATIONS = 20;
const health = { oldestLedger: 1, latestLedger: 1_000_000 };

function fakeServer() {
  let requests = 0;

  return {
    requests: () => requests,
    getHealth: async () => health,
    getEvents: async ({ cursor }) => {
      requests += 1;
      const page = cursor ? Number(cursor.split("-")[0]) - 1 : 0;
      const nextPage = page + 1;

      return {
        events: [],
        latestLedger: health.latestLedger,
        cursor: `${nextPage + 1}-0`,
      };
    },
  };
}

const durations = [];
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  const server = fakeServer();
  const started = performance.now();
  const scan = await paginatedGetEvents(server, [], {
    maxPages: EMPTY_PAGES,
    limit: 200,
  });
  durations.push(performance.now() - started);

  if (!scan.truncated || scan.pages !== EMPTY_PAGES || scan.events.length !== 0) {
    throw new Error(
      `unexpected scan result: pages=${scan.pages} events=${scan.events.length} ` +
        `truncated=${scan.truncated}`,
    );
  }
  if (server.requests() !== EMPTY_PAGES) {
    throw new Error(`expected ${EMPTY_PAGES} RPC requests, got ${server.requests()}`);
  }
}

durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)];

console.log(
  `empty pages=${EMPTY_PAGES} iterations=${ITERATIONS} ` +
    `median_ms=${percentile(0.5).toFixed(2)} p95_ms=${percentile(0.95).toFixed(2)}`,
);
