import { readJson } from "../core/files";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export async function validateJsonFile(schemaPath: string, dataPath: string): Promise<ValidationResult> {
  const schema = await readJson(schemaPath);
  const data = await readJson(dataPath);
  return validateJsonSchema(schema, data);
}

export function validateJsonSchema(schema: unknown, data: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  validateNode(schema, data, "$", schema, issues);
  return {
    valid: issues.length === 0,
    issues
  };
}

function validateNode(schemaNode: unknown, data: unknown, path: string, rootSchema: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(schemaNode)) {
    return;
  }

  if (typeof schemaNode.$ref === "string") {
    validateNode(resolveRef(rootSchema, schemaNode.$ref), data, path, rootSchema, issues);
    return;
  }

  if (Array.isArray(schemaNode.allOf)) {
    for (const item of schemaNode.allOf) {
      validateConditional(item, data, path, rootSchema, issues);
    }
  }

  if ("const" in schemaNode && data !== schemaNode.const) {
    issues.push({ path, message: `Expected constant ${JSON.stringify(schemaNode.const)}` });
  }

  if (Array.isArray(schemaNode.enum) && !schemaNode.enum.includes(data)) {
    issues.push({ path, message: `Expected one of ${schemaNode.enum.map((item) => JSON.stringify(item)).join(", ")}` });
  }

  const expectedType = schemaNode.type;
  if (typeof expectedType === "string" && !matchesType(data, expectedType)) {
    issues.push({ path, message: `Expected type ${expectedType}` });
    return;
  }

  if (expectedType === "object" || (schemaNode.properties && isRecord(data))) {
    validateObject(schemaNode, data, path, rootSchema, issues);
  }

  if (expectedType === "array" || (schemaNode.items && Array.isArray(data))) {
    validateArray(schemaNode, data, path, rootSchema, issues);
  }

  if (typeof schemaNode.pattern === "string" && typeof data === "string") {
    const regex = new RegExp(schemaNode.pattern);
    if (!regex.test(data)) {
      issues.push({ path, message: `Expected string to match ${schemaNode.pattern}` });
    }
  }

  const minimum = schemaNode.minimum;
  if (typeof minimum === "number" && typeof data === "number" && data < minimum) {
    issues.push({ path, message: `Expected number >= ${minimum}` });
  }
}

function validateConditional(
  schemaNode: unknown,
  data: unknown,
  path: string,
  rootSchema: unknown,
  issues: ValidationIssue[]
): void {
  if (!isRecord(schemaNode) || !schemaNode.if || !schemaNode.then) {
    validateNode(schemaNode, data, path, rootSchema, issues);
    return;
  }

  const conditionIssues: ValidationIssue[] = [];
  validateNode(schemaNode.if, data, path, rootSchema, conditionIssues);
  if (conditionIssues.length === 0) {
    validateNode(schemaNode.then, data, path, rootSchema, issues);
  }
}

function validateObject(
  schemaNode: Record<string, unknown>,
  data: unknown,
  path: string,
  rootSchema: unknown,
  issues: ValidationIssue[]
): void {
  if (!isRecord(data)) {
    return;
  }

  const required = Array.isArray(schemaNode.required) ? schemaNode.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in data)) {
      issues.push({ path, message: `Missing required property ${key}` });
    }
  }

  const properties = isRecord(schemaNode.properties) ? schemaNode.properties : {};
  for (const [key, value] of Object.entries(data)) {
    if (key in properties) {
      validateNode(properties[key], value, `${path}.${key}`, rootSchema, issues);
    } else if (schemaNode.additionalProperties === false) {
      issues.push({ path: `${path}.${key}`, message: "Unexpected property" });
    } else if (isRecord(schemaNode.additionalProperties)) {
      validateNode(schemaNode.additionalProperties, value, `${path}.${key}`, rootSchema, issues);
    }
  }
}

function validateArray(
  schemaNode: Record<string, unknown>,
  data: unknown,
  path: string,
  rootSchema: unknown,
  issues: ValidationIssue[]
): void {
  if (!Array.isArray(data)) {
    return;
  }

  for (let i = 0; i < data.length; i += 1) {
    validateNode(schemaNode.items, data[i], `${path}[${i}]`, rootSchema, issues);
  }
}

function resolveRef(rootSchema: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local schema refs are supported: ${ref}`);
  }

  let current = rootSchema;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) {
      throw new Error(`Invalid schema ref ${ref}`);
    }
    current = current[segment];
  }
  return current;
}

function matchesType(data: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "object":
      return isRecord(data);
    case "array":
      return Array.isArray(data);
    case "string":
      return typeof data === "string";
    case "boolean":
      return typeof data === "boolean";
    case "integer":
      return typeof data === "number" && Number.isInteger(data);
    case "number":
      return typeof data === "number";
    case "null":
      return data === null;
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
