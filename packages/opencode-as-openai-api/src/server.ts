import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  ApiError,
  createChatCompletionObject,
  createOpenCodeRequest,
  createResponsesApiObject,
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
  parseOpenCodeResult,
  splitModel,
  type ChatCompletionObject,
  type NormalizedRequest,
  type OpenCodeRequestBody,
  type OpenCodeResult,
  type ResponsesApiObject,
  type StructuredOutputPolicy,
} from "./translate.js";

const BODY_LIMIT_BYTES = 1_048_576;
const UPSTREAM_TIMEOUT_5_MINUTES_MS = 5 * 60 * 1_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = Number.MAX_SAFE_INTEGER;
const HTTP_OK_STATUS = 200;
const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_REQUEST_TOO_LARGE_STATUS = 413;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_BAD_GATEWAY_STATUS = 502;
const HTTP_GATEWAY_TIMEOUT_STATUS = 504;
const HTTP_SERVER_ERROR_STATUS = 500;
const BEARER_PREFIX = "Bearer ";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type UnknownRecord = Record<string, unknown>;

export interface GatewayBackend {
  readonly toolIds?: readonly string[];
  run(body: OpenCodeRequestBody, signal: AbortSignal): Promise<unknown>;
}

export interface GatewayLogger {
  info?: (message: string) => void;
}

export interface GatewayConfiguration {
  model: string;
  upstreamModel?: string;
  variant?: string;
  token: string;
  backend: GatewayBackend;
  maxConcurrency?: number;
  quickTunnel?: boolean;
  logger?: GatewayLogger;
}

interface ValidatedGatewayConfiguration {
  model: string;
  upstreamModel: string;
  variant: string | undefined;
  token: string;
  backend: GatewayBackend;
  maxConcurrency: number;
  quickTunnel: boolean;
  logger: GatewayLogger;
}

export class GatewayConfigurationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigurationError";
  }
}

export function createGateway(configuration: GatewayConfiguration): Server {
  const {
    model,
    upstreamModel,
    variant,
    token,
    backend,
    maxConcurrency,
    quickTunnel,
    logger,
  } = validateGatewayConfiguration(configuration);
  let activeRequests = 0;

  return createServer(async (request, response) => {
    const startedAtMilliseconds = Date.now();
    const route = request.url?.split("?", 1)[0] ?? "";
    const requestId = requestIdFrom(request.headers);
    response.setHeader("x-request-id", requestId);
    let status = HTTP_SERVER_ERROR_STATUS;

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/v1/")) throw notFoundError();
      if (!authorized(request.headers.authorization, token)) {
        throw new ApiError(HTTP_UNAUTHORIZED_STATUS, "Invalid bearer token", "authentication_error", null, "invalid_api_key");
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        status = HTTP_OK_STATUS;
        sendJson(response, HTTP_OK_STATUS, {
          object: "list",
          data: [{ id: model, object: "model", created: 0, owned_by: "opencode" }],
        });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
        const requestedModel = decodeModelId(url.pathname.slice("/v1/models/".length));
        if (requestedModel !== model) {
          throw new ApiError(
            HTTP_NOT_FOUND_STATUS,
            `The model '${requestedModel}' does not exist`,
            "invalid_request_error",
            "model",
            "model_not_found",
          );
        }
        status = HTTP_OK_STATUS;
        sendJson(response, HTTP_OK_STATUS, { id: model, object: "model", created: 0, owned_by: "opencode" });
        return;
      }

      const kind = requestKind(url.pathname);
      if (request.method !== "POST" || !kind) throw notFoundError();
      const body = await readJsonObject(request);
      const normalized = kind === "responses"
        ? normalizeResponsesRequest(body, model)
        : normalizeChatCompletionsRequest(body, model);
      if (quickTunnel && normalized.stream && (request.headers["cf-ray"] || request.headers["cf-visitor"])) {
        throw new ApiError(
          HTTP_BAD_REQUEST_STATUS,
          "TryCloudflare does not support streaming. Use the local URL or omit stream.",
          "invalid_request_error",
          "stream",
          "streaming_not_supported",
        );
      }
      if (activeRequests >= maxConcurrency) {
        status = HTTP_TOO_MANY_REQUESTS_STATUS;
        sendJson(
          response,
          HTTP_TOO_MANY_REQUESTS_STATUS,
          errorBody(new ApiError(
            HTTP_TOO_MANY_REQUESTS_STATUS,
            "The gateway is busy",
            "rate_limit_error",
            null,
            "rate_limit_exceeded",
          )),
          { "retry-after": "1" },
        );
        return;
      }

      activeRequests += 1;
      const controller = new AbortController();
      const disconnected = (): void => controller.abort();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_5_MINUTES_MS);
      try {
        response.once("close", disconnected);
        const openCodeBody = createOpenCodeRequest(normalized, upstreamModel, variant, backend.toolIds ?? []);
        const upstream = await backend.run(openCodeBody, controller.signal);
        const result = parseOpenCodeResult(upstream, structuredOutputPolicy(normalized));
        status = HTTP_OK_STATUS;
        if (kind === "responses") {
          const apiResponse = createResponsesApiObject(result, model);
          if (normalized.stream) {
            startSse(response);
            streamResponse(response, result, apiResponse);
          } else {
            sendJson(response, HTTP_OK_STATUS, apiResponse);
          }
        } else {
          const completion = createChatCompletionObject(result, model);
          if (normalized.stream) {
            startSse(response);
            streamChat(response, result, completion);
          } else {
            sendJson(response, HTTP_OK_STATUS, completion);
          }
        }
      } finally {
        clearTimeout(timeout);
        response.off("close", disconnected);
        activeRequests -= 1;
      }
    } catch (cause: unknown) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
      } else {
        const error = gatewayError(cause);
        status = error.status;
        sendJson(response, error.status, errorBody(error));
      }
    } finally {
      logger.info?.(`${requestId} ${request.method} ${route} ${status} ${Date.now() - startedAtMilliseconds}ms`);
    }
  });
}

function validateGatewayConfiguration(value: unknown): ValidatedGatewayConfiguration {
  if (!isRecord(value)) throw new GatewayConfigurationError("gateway configuration must be an object");
  const model = configurationString(value["model"], "model");
  const upstreamModel = value["upstreamModel"] === undefined
    ? model
    : configurationString(value["upstreamModel"], "upstreamModel");
  try {
    splitModel(upstreamModel);
  } catch {
    throw new GatewayConfigurationError("upstreamModel must use the provider/model format");
  }
  const variant = optionalConfigurationString(value["variant"], "variant");
  const token = configurationString(value["token"], "token");
  const backend = value["backend"];
  if (!isGatewayBackend(backend)) {
    throw new GatewayConfigurationError("backend must provide run() and string toolIds");
  }
  const maxConcurrency = value["maxConcurrency"] ?? MIN_CONCURRENCY;
  if (
    typeof maxConcurrency !== "number"
    || !Number.isSafeInteger(maxConcurrency)
    || maxConcurrency < MIN_CONCURRENCY
    || maxConcurrency > MAX_CONCURRENCY
  ) {
    throw new GatewayConfigurationError("maxConcurrency must be a positive safe integer");
  }
  const quickTunnel = value["quickTunnel"] ?? false;
  if (typeof quickTunnel !== "boolean") throw new GatewayConfigurationError("quickTunnel must be a boolean");
  const logger = value["logger"] ?? console;
  if (!isGatewayLogger(logger)) throw new GatewayConfigurationError("logger.info must be a function");
  return { model, upstreamModel, variant, token, backend, maxConcurrency, quickTunnel, logger };
}

function configurationString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new GatewayConfigurationError(`${field} must be a non-empty string`);
}

function optionalConfigurationString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return configurationString(value, field);
}

function isGatewayBackend(value: unknown): value is GatewayBackend {
  if (!isRecord(value) || typeof value["run"] !== "function") return false;
  const toolIds = value["toolIds"];
  return toolIds === undefined || (Array.isArray(toolIds) && toolIds.every((toolId) => typeof toolId === "string"));
}

function isGatewayLogger(value: unknown): value is GatewayLogger {
  if (!isRecord(value)) return false;
  return value["info"] === undefined || typeof value["info"] === "function";
}

function requestKind(pathname: string): "responses" | "chat" | null {
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/chat/completions") return "chat";
  return null;
}

function requestIdFrom(headers: IncomingHttpHeaders): string {
  const header = headers["x-request-id"];
  if (typeof header === "string" && REQUEST_ID_PATTERN.test(header)) return header;
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function decodeModelId(encodedModelId: string): string {
  try {
    return decodeURIComponent(encodedModelId);
  } catch {
    throw new ApiError(
      HTTP_BAD_REQUEST_STATUS,
      "model path must use valid percent encoding",
      "invalid_request_error",
      "model",
      "invalid_model",
    );
  }
}

function authorized(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) return false;
  const suppliedToken = Buffer.from(header.slice(BEARER_PREFIX.length));
  const expectedToken = Buffer.from(token);
  return suppliedToken.length === expectedToken.length && timingSafeEqual(suppliedToken, expectedToken);
}

async function readJsonObject(request: IncomingMessage): Promise<UnknownRecord> {
  const chunks: Buffer[] = [];
  let bodySizeBytes = 0;
  for await (const requestChunk of request) {
    const chunk = requestBuffer(requestChunk);
    bodySizeBytes += chunk.length;
    if (bodySizeBytes > BODY_LIMIT_BYTES) {
      throw new ApiError(
        HTTP_REQUEST_TOO_LARGE_STATUS,
        "request body exceeds 1 MiB",
        "invalid_request_error",
        null,
        "request_too_large",
      );
    }
    chunks.push(chunk);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(
      HTTP_BAD_REQUEST_STATUS,
      "request body must be valid JSON",
      "invalid_request_error",
      null,
      "invalid_json",
    );
  }
  if (!isRecord(body)) {
    throw new ApiError(
      HTTP_BAD_REQUEST_STATUS,
      "request body must be a JSON object",
      "invalid_request_error",
      null,
      "invalid_json",
    );
  }
  return body;
}

function requestBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw new ApiError(HTTP_BAD_REQUEST_STATUS, "request body is invalid", "invalid_request_error", null, "invalid_json");
}

function structuredOutputPolicy(request: NormalizedRequest): StructuredOutputPolicy | null {
  if (request.tools.length === 0 || request.toolChoice.mode === "none") return null;
  return {
    allowText: request.toolChoice.mode !== "required",
    allowedFunctionNames: request.toolChoice.names,
  };
}

function errorBody(error: ApiError): UnknownRecord {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    ...headers,
  });
  response.end(data);
}

function writeTypedSseEvent(response: ServerResponse, event: UnknownRecord): void {
  response.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
}

function startSse(response: ServerResponse): void {
  response.writeHead(HTTP_OK_STATUS, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

function streamResponse(
  serverResponse: ServerResponse,
  result: OpenCodeResult,
  apiResponse: ResponsesApiObject,
): void {
  let sequenceNumber = 1;
  const emit = (event: UnknownRecord): void => {
    writeTypedSseEvent(serverResponse, { ...event, sequence_number: sequenceNumber });
    sequenceNumber += 1;
  };
  const pendingResponse = { ...apiResponse, status: "in_progress", completed_at: null, output: [], usage: null };
  emit({ type: "response.created", response: pendingResponse });
  const item = apiResponse.output[0];
  const addedItem = item.type === "message"
    ? { ...item, status: "in_progress", content: [] }
    : { ...item, status: "in_progress", arguments: "" };
  emit({ type: "response.output_item.added", output_index: 0, item: addedItem });

  if (result.type === "text") {
    if (item.type !== "message") throw new Error("Response item does not match text result");
    const part = { type: "output_text", text: "", annotations: [] };
    emit({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part });
    emit({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: result.text });
    emit({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: result.text });
    emit({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  } else {
    if (item.type !== "function_call") throw new Error("Response item does not match function result");
    emit({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: result.arguments });
    emit({
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      name: result.name,
      arguments: result.arguments,
    });
  }
  emit({ type: "response.output_item.done", output_index: 0, item });
  emit({ type: "response.completed", response: apiResponse });
  serverResponse.end();
}

function streamChat(
  response: ServerResponse,
  result: OpenCodeResult,
  completion: ChatCompletionObject,
): void {
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const write = (delta: UnknownRecord, finishReason: "tool_calls" | "stop" | null = null): void => {
    const chunk = {
      ...base,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  write({ role: "assistant", content: result.type === "text" ? "" : null });
  if (result.type === "text") {
    write({ content: result.text });
  } else {
    write({
      tool_calls: [{
        index: 0,
        id: result.callId,
        type: "function",
        function: { name: result.name, arguments: result.arguments },
      }],
    });
  }
  write({}, result.type === "function_call" ? "tool_calls" : "stop");
  response.write("data: [DONE]\n\n");
  response.end();
}

function gatewayError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (isRecord(cause) && cause["name"] === "AbortError") {
    return new ApiError(HTTP_GATEWAY_TIMEOUT_STATUS, "The upstream request timed out", "server_error", null, "timeout");
  }
  return new ApiError(HTTP_BAD_GATEWAY_STATUS, "OpenCode request failed", "server_error", null, "upstream_error");
}

function notFoundError(): ApiError {
  return new ApiError(HTTP_NOT_FOUND_STATUS, "Not found", "invalid_request_error", null, "not_found");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
