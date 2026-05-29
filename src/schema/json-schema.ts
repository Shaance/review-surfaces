import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readJson } from "../core/files";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Ajv instance reused across calls. ajv compiles and caches schemas, so a
 * shared instance keeps repeated validations fast and deterministic.
 * - draft 2020-12 dialect ($defs/$ref, allOf + if/then, const, enum, ...).
 * - allErrors: surface every issue, matching the old validator.
 * - strict: false so unknown/format keywords do not throw at compile time.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Cache by object identity for anonymous schemas...
const compiledSchemas = new WeakMap<object, ValidateFunction>();
// ...and by $id for schemas that declare one, so re-parsing the same schema
// file (a fresh object each time) reuses the compiled validator instead of
// asking Ajv to register a duplicate $id (which throws).
const compiledById = new Map<string, ValidateFunction>();

export async function validateJsonFile(schemaPath: string, dataPath: string): Promise<ValidationResult> {
  const schema = await readJson(schemaPath);
  const data = await readJson(dataPath);
  return validateJsonSchema(schema, data);
}

export function validateJsonSchema(schema: unknown, data: unknown): ValidationResult {
  const validate = getValidator(schema);
  const valid = validate(data) as boolean;
  if (valid) {
    return { valid: true, issues: [] };
  }

  const issues = (validate.errors ?? []).map(toIssue);
  return {
    valid: issues.length === 0,
    issues
  };
}

function getValidator(schema: unknown): ValidateFunction {
  if (schema === null || typeof schema !== "object") {
    return ajv.compile(schema as object);
  }

  const byIdentity = compiledSchemas.get(schema as object);
  if (byIdentity) {
    return byIdentity;
  }

  const schemaId = (schema as { $id?: unknown }).$id;
  if (typeof schemaId === "string") {
    const byId = compiledById.get(schemaId) ?? ajv.getSchema(schemaId);
    if (byId) {
      compiledSchemas.set(schema as object, byId);
      compiledById.set(schemaId, byId);
      return byId;
    }
  }

  const compiled = ajv.compile(schema as object);
  compiledSchemas.set(schema as object, compiled);
  if (typeof schemaId === "string") {
    compiledById.set(schemaId, compiled);
  }
  return compiled;
}

function toIssue(error: ErrorObject): ValidationIssue {
  return {
    path: errorPath(error),
    message: errorMessage(error)
  };
}

/**
 * Convert an Ajv instancePath (e.g. "/arr/0/name") into the historical
 * "$.arr[0].name" shape used throughout the codebase and tests.
 *
 * For keyword errors that point at a child key (additionalProperties), the
 * offending property is appended so the path identifies the exact location,
 * matching the previous hand-rolled validator ("$.a.extra").
 */
function errorPath(error: ErrorObject): string {
  let path = instancePathToDollar(error.instancePath);
  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    if (typeof extra === "string") {
      path = appendKey(path, extra);
    }
  }
  return path;
}

function instancePathToDollar(instancePath: string): string {
  if (!instancePath) {
    return "$";
  }
  let path = "$";
  for (const rawSegment of instancePath.split("/").slice(1)) {
    const segment = unescapePointer(rawSegment);
    path = appendKey(path, segment);
  }
  return path;
}

function appendKey(path: string, key: string): string {
  return /^[0-9]+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`;
}

function unescapePointer(segment: string): string {
  // JSON Pointer escaping: ~1 => "/", ~0 => "~".
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Map Ajv messages onto the phrasing the existing tests and artifacts expect
 * ("Expected constant ...", "Expected one of ...", "Unexpected property",
 * "Missing required property ...", "Expected type ...", etc.). Falls back to
 * Ajv's own message for keywords without a bespoke phrasing.
 */
function errorMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case "const":
      return `Expected constant ${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)}`;
    case "enum": {
      const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
      return `Expected one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`;
    }
    case "additionalProperties":
      return "Unexpected property";
    case "required": {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return `Missing required property ${missing}`;
    }
    case "type": {
      const expected = (error.params as { type: string | string[] }).type;
      return `Expected type ${Array.isArray(expected) ? expected.join(", ") : expected}`;
    }
    case "pattern": {
      const pattern = (error.params as { pattern: string }).pattern;
      return `Expected string to match ${pattern}`;
    }
    case "minimum": {
      const limit = (error.params as { limit: number }).limit;
      return `Expected number >= ${limit}`;
    }
    default:
      return error.message ?? `Schema validation failed (${error.keyword})`;
  }
}
