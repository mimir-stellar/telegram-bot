/**
 * Entrypoint for the analytics export CLI (`npm run analytics:export`).
 *
 * Reads decoded events from an event archive directory and prints the
 * versioned analytics summary (docs/analytics-export.md) as JSON. Read-only:
 * it never contacts the RPC or Telegram and never writes the archive.
 *
 *   npm run analytics:export -- --archive ./data/archive
 *   npm run analytics:export -- --archive ./data/archive --bucket hour
 *   npm run analytics:export -- --archive ./data/archive --out summary.json
 *
 * Exit codes:
 *   0 — summary written
 *   1 — runtime error (unreadable or malformed archive)
 *   2 — usage error (bad flags)
 */

import { stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildAnalyticsSummary, serializeAnalyticsSummary } from "./stellar/analytics-export.js";
import { readArchive } from "./stellar/archive.js";
import type { VolumeBucketUnit } from "./stellar/volume-series.js";

const USAGE =
  "Usage: npm run analytics:export -- --archive <dir> [--bucket hour|day] [--out <file>]";

export interface AnalyticsExportCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runAnalyticsExportCli(
  argv: readonly string[] = process.argv.slice(2),
  io: AnalyticsExportCliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let values: { archive?: string; bucket?: string; out?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        archive: { type: "string" },
        bucket: { type: "string", default: "day" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
    return 2;
  }

  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (!values.archive) {
    io.stderr(`--archive is required\n${USAGE}\n`);
    return 2;
  }
  if (values.bucket !== "hour" && values.bucket !== "day") {
    io.stderr(`--bucket must be "hour" or "day", got "${values.bucket}"\n${USAGE}\n`);
    return 2;
  }

  try {
    // readArchive treats a missing directory as empty; an export of nothing is
    // almost always a typo in --archive, so refuse it instead.
    const info = await stat(values.archive).catch(() => null);
    if (!info?.isDirectory()) {
      io.stderr(`--archive ${values.archive} is not a directory\n`);
      return 1;
    }
    const events: unknown[] = [];
    for await (const event of readArchive(values.archive, { retainCommitted: true })) {
      events.push(event);
    }
    const json = serializeAnalyticsSummary(
      buildAnalyticsSummary(events, { bucket: values.bucket as VolumeBucketUnit }),
    );
    if (values.out) {
      await writeFile(values.out, json, "utf8");
    } else {
      io.stdout(json);
    }
    return 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runAnalyticsExportCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
