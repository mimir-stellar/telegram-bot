/**
 * Versioned contract compatibility checks for `GET /health` (`HealthReport`).
 *
 * `docs/schemas/health-report.schema.json` keeps every object closed
 * (`additionalProperties: false`) so producer tests catch undocumented fields
 * immediately. Across releases, however, downstream consumers need a separate
 * contract check that distinguishes:
 *
 *  - **additive** changes (new fields added to response objects while all
 *    baseline required fields, types, formats, minimums, and enums remain
 *    intact — backward-compatible within the same `schemaVersion`), from
 *  - **breaking** changes (removed or newly optional baseline fields, renamed
 *    fields, incompatible type widening, new output enum variants an older
 *    consumer cannot switch on, relaxed numeric minimums, dropped date-time
 *    formatting, or a major `schemaVersion` bump).
 */

export const HEALTH_REPORT_SCHEMA_VERSION = 1 as const;

export interface HealthSchemaNode {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, HealthSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | HealthSchemaNode;
  items?: HealthSchemaNode;
  minimum?: number;
  format?: string;
}

export type HealthContractIssueCode =
  | "added_property"
  | "missing_required_property"
  | "type_mismatch"
  | "enum_mismatch"
  | "minimum_violation"
  | "format_mismatch"
  | "incompatible_schema_version";

export interface HealthContractIssue {
  path: string;
  kind: "additive" | "breaking";
  code: HealthContractIssueCode;
  message: string;
}

export interface HealthContractCompatibility {
  compatible: boolean;
  classification: "identical" | "additive" | "breaking";
  additive: HealthContractIssue[];
  breaking: HealthContractIssue[];
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return jsonType(value) === expected;
}

function normalizeTypes(typeSpec: string | string[] | undefined): string[] | null {
  if (typeSpec === undefined) return null;
  return Array.isArray(typeSpec) ? [...typeSpec] : [typeSpec];
}

function isTypeAcceptedByBaseline(candidateType: string, baselineTypes: string[]): boolean {
  if (baselineTypes.includes(candidateType)) return true;
  if (candidateType === "integer" && baselineTypes.includes("number")) return true;
  return false;
}

function sortIssues(issues: HealthContractIssue[]): HealthContractIssue[] {
  return [...issues].sort((a, b) =>
    a.path === b.path
      ? a.code < b.code
        ? -1
        : a.code > b.code
          ? 1
          : 0
      : a.path < b.path
        ? -1
        : 1,
  );
}

function buildResult(
  additive: HealthContractIssue[],
  breaking: HealthContractIssue[],
): HealthContractCompatibility {
  const sortedAdditive = sortIssues(additive);
  const sortedBreaking = sortIssues(breaking);
  const compatible = sortedBreaking.length === 0;
  const classification =
    sortedBreaking.length > 0
      ? "breaking"
      : sortedAdditive.length > 0
        ? "additive"
        : "identical";
  return {
    compatible,
    classification,
    additive: sortedAdditive,
    breaking: sortedBreaking,
  };
}

function checkPayloadNode(
  schema: HealthSchemaNode,
  value: unknown,
  path: string,
  additive: HealthContractIssue[],
  breaking: HealthContractIssue[],
): void {
  const allowedTypes = normalizeTypes(schema.type);
  if (allowedTypes !== null) {
    if (!allowedTypes.some((t) => matchesType(value, t))) {
      breaking.push({
        path,
        kind: "breaking",
        code: "type_mismatch",
        message: `${path}: expected ${allowedTypes.join(" or ")}, got ${jsonType(value)}`,
      });
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    const isVersionField = path === "$.schemaVersion";
    breaking.push({
      path,
      kind: "breaking",
      code: isVersionField ? "incompatible_schema_version" : "enum_mismatch",
      message: `${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    });
  }

  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    breaking.push({
      path,
      kind: "breaking",
      code: "minimum_violation",
      message: `${path}: ${value} is below minimum ${schema.minimum}`,
    });
  }

  if (schema.format === "date-time" && typeof value === "string") {
    if (!DATE_TIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
      breaking.push({
        path,
        kind: "breaking",
        code: "format_mismatch",
        message: `${path}: ${JSON.stringify(value)} is not an ISO 8601 UTC timestamp`,
      });
    }
  }

  if (jsonType(value) === "object") {
    const obj = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const reqKey of schema.required ?? []) {
      if (!Object.hasOwn(obj, reqKey)) {
        breaking.push({
          path,
          kind: "breaking",
          code: "missing_required_property",
          message: `${path}: missing required property "${reqKey}"`,
        });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const childPath = `${path}.${key}`;
      if (Object.hasOwn(properties, key)) {
        const propSchema = properties[key];
        if (propSchema !== undefined) {
          checkPayloadNode(propSchema, child, childPath, additive, breaking);
        }
      } else if (schema.additionalProperties === false) {
        additive.push({
          path: childPath,
          kind: "additive",
          code: "added_property",
          message: `${childPath}: additive property not present in baseline schema`,
        });
      } else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        checkPayloadNode(schema.additionalProperties, child, childPath, additive, breaking);
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      checkPayloadNode(schema.items, value[i], `${path}[${i}]`, additive, breaking);
    }
  }
}

/**
 * Check whether `candidateReport` remains backward-compatible with a consumer
 * built against `baselineSchema`, separating additive fields from breaking
 * contract violations.
 */
export function checkHealthPayloadCompatibility(
  baselineSchema: HealthSchemaNode,
  candidateReport: unknown,
): HealthContractCompatibility {
  const additive: HealthContractIssue[] = [];
  const breaking: HealthContractIssue[] = [];
  checkPayloadNode(baselineSchema, candidateReport, "$", additive, breaking);
  return buildResult(additive, breaking);
}

function compareSchemaNodes(
  baseline: HealthSchemaNode,
  candidate: HealthSchemaNode,
  path: string,
  additive: HealthContractIssue[],
  breaking: HealthContractIssue[],
): void {
  const baseTypes = normalizeTypes(baseline.type);
  const candTypes = normalizeTypes(candidate.type);
  if (baseTypes !== null) {
    if (candTypes === null) {
      // Candidate omits `type` — acceptable only if candidate constrains via `enum`
      // whose values all match baseline types.
      if (
        candidate.enum === undefined ||
        !candidate.enum.every((val) => baseTypes.some((t) => matchesType(val, t)))
      ) {
        breaking.push({
          path,
          kind: "breaking",
          code: "type_mismatch",
          message: `${path}: candidate removed type constraint (${baseTypes.join(" | ")})`,
        });
      }
    } else {
      const widened = candTypes.filter((t) => !isTypeAcceptedByBaseline(t, baseTypes));
      if (widened.length > 0) {
        breaking.push({
          path,
          kind: "breaking",
          code: "type_mismatch",
          message: `${path}: candidate widens type with ${widened.join(", ")} (baseline expects ${baseTypes.join(" | ")})`,
        });
      }
    }
  }

  if (baseline.enum !== undefined) {
    const isVersionField = path === "$.schemaVersion";
    if (candidate.enum === undefined) {
      breaking.push({
        path,
        kind: "breaking",
        code: isVersionField ? "incompatible_schema_version" : "enum_mismatch",
        message: `${path}: candidate removed enum constraint`,
      });
    } else {
      const addedVariants = candidate.enum.filter((v) => !baseline.enum!.includes(v));
      if (addedVariants.length > 0) {
        breaking.push({
          path,
          kind: "breaking",
          code: isVersionField ? "incompatible_schema_version" : "enum_mismatch",
          message: `${path}: candidate introduces enum value(s) ${addedVariants.map((v) => JSON.stringify(v)).join(", ")} unknown to baseline consumers`,
        });
      }
    }
  }

  if (baseline.minimum !== undefined) {
    if (candidate.minimum === undefined || candidate.minimum < baseline.minimum) {
      breaking.push({
        path,
        kind: "breaking",
        code: "minimum_violation",
        message: `${path}: candidate relaxes minimum from ${baseline.minimum} to ${String(candidate.minimum)}`,
      });
    }
  }

  if (baseline.format !== undefined && candidate.format !== baseline.format) {
    breaking.push({
      path,
      kind: "breaking",
      code: "format_mismatch",
      message: `${path}: candidate changed format from "${baseline.format}" to ${JSON.stringify(candidate.format ?? null)}`,
    });
  }

  const baseProps = baseline.properties;
  const candProps = candidate.properties;
  if (baseProps !== undefined) {
    const resolvedCandProps = candProps ?? {};
    const baseRequired = new Set(baseline.required ?? []);
    const candRequired = new Set(candidate.required ?? []);

    for (const reqKey of baseRequired) {
      if (!Object.hasOwn(resolvedCandProps, reqKey) || !candRequired.has(reqKey)) {
        breaking.push({
          path: `${path}.${reqKey}`,
          kind: "breaking",
          code: "missing_required_property",
          message: `${path}.${reqKey}: baseline required property was removed or made optional`,
        });
      }
    }

    for (const [key, baseChild] of Object.entries(baseProps)) {
      if (!Object.hasOwn(resolvedCandProps, key)) {
        if (!baseRequired.has(key)) {
          // Removing an optional output field means producers emit a strict subset
          // of what baseline consumers already tolerated as absent.
          continue;
        }
        continue;
      }
      const candChild = resolvedCandProps[key];
      if (candChild !== undefined) {
        compareSchemaNodes(baseChild, candChild, `${path}.${key}`, additive, breaking);
      }
    }

    for (const key of Object.keys(resolvedCandProps)) {
      if (!Object.hasOwn(baseProps, key)) {
        additive.push({
          path: `${path}.${key}`,
          kind: "additive",
          code: "added_property",
          message: `${path}.${key}: additive property introduced after baseline`,
        });
      }
    }
  }

  if (baseline.items !== undefined) {
    if (candidate.items === undefined) {
      breaking.push({
        path: `${path}[]`,
        kind: "breaking",
        code: "type_mismatch",
        message: `${path}[]: candidate removed array items schema`,
      });
    } else {
      compareSchemaNodes(baseline.items, candidate.items, `${path}[]`, additive, breaking);
    }
  }
}

/**
 * Compare a baseline `HealthReport` schema against a candidate schema and
 * classify every change as `additive` (backward-compatible) or `breaking`.
 */
export function compareHealthSchemas(
  baselineSchema: HealthSchemaNode,
  candidateSchema: HealthSchemaNode,
): HealthContractCompatibility {
  const additive: HealthContractIssue[] = [];
  const breaking: HealthContractIssue[] = [];
  compareSchemaNodes(baselineSchema, candidateSchema, "$", additive, breaking);
  return buildResult(additive, breaking);
}
