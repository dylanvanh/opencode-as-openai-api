import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { ApiError } from "./api-error.js";

const HTTP_BAD_REQUEST_STATUS = 400;
const FORMAT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const JSON_SCHEMA_2019_URI = "https://json-schema.org/draft/2019-09/schema";
const JSON_SCHEMA_2020_URI = "https://json-schema.org/draft/2020-12/schema";

type UnknownRecord = Record<string, unknown>;

export type ResponseTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: UnknownRecord; description?: string; strict?: boolean | null };

export interface NormalizedResponseFormat {
  format: ResponseTextFormat;
  schema: UnknownRecord;
  validate: ValidateFunction;
}

export function normalizeResponseFormat(value: unknown, chat: boolean): NormalizedResponseFormat | null {
  const parameter = chat ? "response_format" : "text.format";
  if (value == null) return null;
  if (!isRecord(value)) throw invalidFormat("must be an object", parameter);
  if (value["type"] === "text") return null;
  if (value["type"] === "json_object") {
    const schema = { type: "object" };
    return { format: { type: "json_object" }, schema, validate: compileSchema(schema, parameter) };
  }
  if (value["type"] !== "json_schema") throw invalidFormat("has an unsupported type", `${parameter}.type`);

  const definition = chat ? value["json_schema"] : value;
  const definitionParameter = chat ? `${parameter}.json_schema` : parameter;
  if (!isRecord(definition)) throw invalidFormat("must be an object", definitionParameter);
  const name = definition["name"];
  if (typeof name !== "string" || !FORMAT_NAME_PATTERN.test(name)) {
    throw invalidFormat("must use 1-64 letters, numbers, underscores, or hyphens", `${definitionParameter}.name`);
  }
  const description = definition["description"];
  if (description !== undefined && typeof description !== "string") {
    throw invalidFormat("must be text", `${definitionParameter}.description`);
  }
  const strict = definition["strict"];
  if (strict != null && typeof strict !== "boolean") {
    throw invalidFormat("must be a boolean or null", `${definitionParameter}.strict`);
  }
  const schema = definition["schema"];
  const schemaParameter = `${definitionParameter}.schema`;
  if (!isRecord(schema) || schema["type"] !== "object") {
    throw invalidFormat("must be a JSON Schema with an object root", schemaParameter);
  }
  const validate = compileSchema(schema, schemaParameter);
  return {
    format: {
      type: "json_schema",
      name,
      schema,
      ...(description === undefined ? {} : { description }),
      ...(strict === undefined ? {} : { strict }),
    },
    schema,
    validate,
  };
}

function compileSchema(schema: UnknownRecord, parameter: string): ValidateFunction {
  validateSchemaSize(schema, parameter);
  const schemaUri = schema["$schema"];
  const dialect = typeof schemaUri === "string" ? schemaUri.replace(/#$/, "") : schemaUri;
  const SchemaValidator = dialect === JSON_SCHEMA_2020_URI ? Ajv2020 : dialect === JSON_SCHEMA_2019_URI ? Ajv2019 : Ajv;
  const validator = new SchemaValidator({
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    ownProperties: true,
    validateFormats: true,
    logger: false,
  });
  formatsPlugin.default(validator);
  try {
    const validate = validator.compile(schema);
    if ("$async" in validate && validate.$async) throw new Error("asynchronous schemas are not supported");
    return validate;
  } catch {
    throw invalidFormat("is invalid or uses unsupported JSON Schema features or references", parameter);
  }
}

function validateSchemaSize(schema: UnknownRecord, parameter: string): void {
  const pending: { value: unknown; depth: number }[] = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) return;
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || current.depth > MAX_SCHEMA_DEPTH) {
      throw invalidFormat(`exceeds ${MAX_SCHEMA_NODES} nodes or ${MAX_SCHEMA_DEPTH} levels`, parameter);
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
  }
}

function invalidFormat(message: string, parameter: string): ApiError {
  return new ApiError(HTTP_BAD_REQUEST_STATUS, `${parameter} ${message}`, "invalid_request_error", parameter);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
