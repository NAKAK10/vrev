const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*){0,7}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*){0,7}$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 128;

export interface PluginBridgeOperationContractV1 {
  name: string;
  permission: string;
  input_schema: Readonly<Record<string, unknown>>;
  output_schema: Readonly<Record<string, unknown>>;
  resources?: string[];
  invalidates?: string[];
}

export interface PluginBridgeContractV1 {
  schema_version: 1;
  queries: PluginBridgeOperationContractV1[];
  commands: PluginBridgeOperationContractV1[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}

function validateSchema(value: unknown, label: string, depth = 0): Readonly<Record<string, unknown>> {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${label} is too deeply nested`);
  const schema = record(value, label);
  exactKeys(schema, ["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"], label);
  if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) throw new Error(`${label}.type is invalid`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100 || schema.enum.some((item) => !["string", "number", "boolean"].includes(typeof item) && item !== null))) throw new Error(`${label}.enum is invalid`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || (schema[key] as number) < 0 || (schema[key] as number) > 100_000)) throw new Error(`${label}.${key} is invalid`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) throw new Error(`${label}.${key} is invalid`);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new Error(`${label}.additionalProperties must be false`);
    const properties = record(schema.properties ?? {}, `${label}.properties`);
    if (Object.keys(properties).length > MAX_SCHEMA_PROPERTIES) throw new Error(`${label}.properties has too many entries`);
    for (const [key, child] of Object.entries(properties)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error(`${label}.properties contains an invalid key`);
      validateSchema(child, `${label}.properties.${key}`, depth + 1);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== "string" || !(key in properties))) throw new Error(`${label}.required is invalid`);
    }
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    throw new Error(`${label} has object-only fields`);
  }
  if (schema.type === "array") {
    if (schema.items === undefined) throw new Error(`${label}.items is required`);
    validateSchema(schema.items, `${label}.items`, depth + 1);
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    throw new Error(`${label} has array-only fields`);
  }
  return structuredClone(schema);
}

function parseOperations(value: unknown, label: "queries" | "commands"): PluginBridgeOperationContractV1[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${label} must be an array`);
  const names = new Set<string>();
  return value.map((item, index) => {
    const operation = record(item, `${label}[${index}]`);
    exactKeys(operation, ["name", "permission", "input_schema", "output_schema", label === "queries" ? "resources" : "invalidates"], `${label}[${index}]`);
    if (typeof operation.name !== "string" || !OPERATION_PATTERN.test(operation.name) || names.has(operation.name)) throw new Error(`${label}[${index}].name is invalid or duplicated`);
    names.add(operation.name);
    if (typeof operation.permission !== "string" || !PERMISSION_PATTERN.test(operation.permission)) throw new Error(`${label}[${index}].permission is invalid`);
    const resourceKey = label === "queries" ? "resources" : "invalidates";
    const resources = operation[resourceKey];
    if (!Array.isArray(resources) || resources.length > 64 || resources.some((resource) => typeof resource !== "string" || !RESOURCE_PATTERN.test(resource)) || new Set(resources).size !== resources.length) throw new Error(`${label}[${index}].${resourceKey} is invalid`);
    return {
      name: operation.name,
      permission: operation.permission,
      input_schema: validateSchema(operation.input_schema, `${label}[${index}].input_schema`),
      output_schema: validateSchema(operation.output_schema, `${label}[${index}].output_schema`),
      [resourceKey]: [...resources] as string[],
    };
  });
}

export function parsePluginBridgeContract(value: unknown): PluginBridgeContractV1 {
  const contract = record(value, "plugin bridge contract");
  exactKeys(contract, ["schema_version", "queries", "commands"], "plugin bridge contract");
  if (contract.schema_version !== 1) throw new Error("plugin bridge contract schema_version must be 1");
  return {
    schema_version: 1,
    queries: parseOperations(contract.queries, "queries"),
    commands: parseOperations(contract.commands, "commands"),
  };
}
