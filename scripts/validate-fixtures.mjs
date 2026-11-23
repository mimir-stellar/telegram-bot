import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Validates the event fixture catalog (tests/fixtures/events.json).
 *
 * The catalog is `{ config, cases: [{ id, kind, expect, event }] }`, as
 * documented in docs/contributor-fixtures.md. Each problem is printed as one
 * line on stderr and the script exits non-zero if there are any.
 *
 * Target resolution:
 *   node scripts/validate-fixtures.mjs <dir-or-file>   explicit target
 *   node scripts/validate-fixtures.mjs                  ./events.json if the
 *     working directory holds one (a temp copy), else tests/fixtures/events.json
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(__dirname, '../tests/fixtures/events.json');

const REQUIRED_CASE_FIELDS = ['id', 'kind', 'expect', 'event'];
const KNOWN_KINDS = new Set(['positive', 'negative', 'boundary', 'restart']);
const KNOWN_EXPECT = new Set(['notify', 'skip']);
const KNOWN_SOURCES = new Set(['market', 'squad']);

/** Event names `src/stellar/decode.ts` can produce, plus the `unknown` fallback. */
const KNOWN_EVENT_NAMES = new Set([
  'claim_created',
  'claim_challenged',
  'claim_resolved',
  'claim_cancelled',
  'market_settled',
  'challenger_paid',
  'fee_claimed',
  'withdrawal',
  'withdrawal_pending',
  'market_created',
  'deposited',
  'withdrawn',
  'resolved',
  'claimed',
  'fees_claimed',
  'oracle_changed',
  'ownership_transferred',
  'agent_attributed',
  'fee_accrued',
  'fee_policy_set',
  'fee_policy_changed',
  'fee_policy_updated',
  'fee_policy_removed',
  'admin',
  'unknown',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCatalog(catalog) {
  if (!isPlainObject(catalog)) {
    return ['fixtures must be a catalog object with "config" and "cases"'];
  }
  const errors = [];
  if (!isPlainObject(catalog.config)) {
    errors.push('catalog: missing "config" object');
  }
  const cases = catalog.cases;
  if (!Array.isArray(cases)) {
    errors.push('catalog: "cases" must be an array');
    return errors;
  }

  const seenIds = new Map();
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];
    let label = `case ${index}`;
    if (!isPlainObject(entry)) {
      errors.push(`${label}: case must be an object`);
      continue;
    }
    if (typeof entry.id === 'string' && entry.id.length > 0) label = `case ${index} (${entry.id})`;

    for (const field of REQUIRED_CASE_FIELDS) {
      if (!(field in entry)) errors.push(`${label}: missing required field "${field}"`);
    }

    const { id, kind, expect, event } = entry;
    if (id !== undefined) {
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`${label}: "id" must be a non-empty string`);
      } else if (seenIds.has(id)) {
        errors.push(`${label}: duplicate case id "${id}" (already used at case ${seenIds.get(id)})`);
      } else {
        seenIds.set(id, index);
      }
    }
    if (kind !== undefined && !KNOWN_KINDS.has(kind)) {
      errors.push(`${label}: unknown kind "${kind}" (expected one of ${[...KNOWN_KINDS].join(', ')})`);
    }
    if (expect !== undefined && !KNOWN_EXPECT.has(expect)) {
      errors.push(`${label}: unknown expect "${expect}" (expected notify or skip)`);
    }

    if (event === undefined) continue;
    if (!isPlainObject(event)) {
      errors.push(`${label}: "event" must be an object`);
      continue;
    }
    if (!KNOWN_SOURCES.has(event.source)) {
      errors.push(`${label}: event.source must be "market" or "squad"`);
    }
    if (typeof event.contractId !== 'string' || event.contractId.length === 0) {
      errors.push(`${label}: event.contractId must be a non-empty string`);
    }
    if (typeof event.ledger !== 'number' || !Number.isInteger(event.ledger) || event.ledger < 0) {
      errors.push(`${label}: event.ledger must be a non-negative integer`);
    }
    const payload = event.payload;
    if (!isPlainObject(payload)) {
      errors.push(`${label}: event.payload must be an object`);
      continue;
    }
    if (typeof payload.name !== 'string' || payload.name.length === 0) {
      errors.push(`${label}: event.payload.name must be a non-empty string`);
    } else if (!KNOWN_EVENT_NAMES.has(payload.name)) {
      errors.push(`${label}: unknown event name "${payload.name}"`);
    }
  }
  return errors;
}

function resolveTarget(arg) {
  if (arg) {
    const target = resolve(arg);
    return existsSync(target) && statSync(target).isDirectory() ? join(target, 'events.json') : target;
  }
  const local = resolve('events.json');
  return existsSync(local) ? local : DEFAULT_FIXTURES;
}

async function main() {
  const target = resolveTarget(process.argv[2]);

  let raw;
  try {
    raw = await readFile(target, 'utf-8');
  } catch (error) {
    console.error(`unable to read fixtures at ${target}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(`${target}: invalid JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = validateCatalog(data);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log(`${target}: validated ${data.cases.length} case(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`failed to validate fixtures: ${error.message}`);
    process.exitCode = 1;
  });
}
