import { timingSafeEqual, randomUUID } from "node:crypto";
import http from "node:http";
import {
  ApiError, chatObject, normalizeChat, normalizeResponses, openCodeRequest,
  openCodeResult, responseObject,
} from "./translate.js";

const BODY_LIMIT = 1024 * 1024;

function errorBody(error) {
  return { error: { message: error.message, type: error.type ?? "server_error", param: error.param ?? null, code: error.code ?? null } };
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, "request body exceeds 1 MiB", "invalid_request_error", null, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "request body must be valid JSON", "invalid_request_error", null, "invalid_json"); }
}

function sse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function startSse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders();
}

function streamResponse(res, result, response) {
  let sequence = 1;
  const emit = (event) => sse(res, { ...event, sequence_number: sequence++ });
  const pending = { ...response, status: "in_progress", completed_at: null, output: [], usage: null };
  emit({ type: "response.created", response: pending });
  const item = response.output[0];
  const added = item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, status: "in_progress", arguments: "" };
  emit({ type: "response.output_item.added", output_index: 0, item: added });
  if (result.type === "text") {
    const part = { type: "output_text", text: "", annotations: [] };
    emit({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part });
    emit({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: result.text });
    emit({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: result.text });
    emit({ type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  } else {
    emit({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: result.arguments });
    emit({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, name: result.name, arguments: result.arguments });
  }
  emit({ type: "response.output_item.done", output_index: 0, item });
  emit({ type: "response.completed", response });
  res.end();
}

function streamChat(res, result, completion) {
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  const write = (delta, finish_reason = null) => sse(res, { ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason }] });
  write({ role: "assistant", content: result.type === "text" ? "" : null });
  if (result.type === "text") write({ content: result.text });
  else write({ tool_calls: [{ index: 0, id: result.callId, type: "function", function: { name: result.name, arguments: result.arguments } }] });
  write({}, result.type === "function_call" ? "tool_calls" : "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

export function createGateway({ model, variant, token, backend, maxConcurrency = 1, quickTunnel = false, logger = console }) {
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const route = req.url?.split("?", 1)[0] ?? "";
    const requestId = req.headers["x-request-id"]?.toString() || `req_${randomUUID().replaceAll("-", "")}`;
    res.setHeader("x-request-id", requestId);
    let status = 500;
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith("/v1/")) throw new ApiError(404, "Not found", "invalid_request_error", null, "not_found");
      if (!authorized(req.headers.authorization, token)) throw new ApiError(401, "Invalid bearer token", "authentication_error", null, "invalid_api_key");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        status = 200;
        return sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "opencode" }] });
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
        if (id !== model) throw new ApiError(404, `The model '${id}' does not exist`, "invalid_request_error", "model", "model_not_found");
        status = 200;
        return sendJson(res, 200, { id: model, object: "model", created: 0, owned_by: "opencode" });
      }
      const kind = url.pathname === "/v1/responses" ? "responses" : url.pathname === "/v1/chat/completions" ? "chat" : null;
      if (req.method !== "POST" || !kind) throw new ApiError(404, "Not found", "invalid_request_error", null, "not_found");
      const body = await readJson(req);
      const normalized = kind === "responses" ? normalizeResponses(body, model) : normalizeChat(body, model);
      if (quickTunnel && normalized.stream && (req.headers["cf-ray"] || req.headers["cf-visitor"])) {
        throw new ApiError(400, "TryCloudflare does not support streaming. Use the local URL or omit stream.", "invalid_request_error", "stream", "streaming_not_supported");
      }
      if (active >= maxConcurrency) {
        status = 429;
        return sendJson(res, 429, errorBody(new ApiError(429, "The gateway is busy", "rate_limit_error", null, "rate_limit_exceeded")), { "retry-after": "1" });
      }
      active++;
      const controller = new AbortController();
      let timeout;
      const disconnected = () => controller.abort();
      try {
        timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
        res.once("close", disconnected);
        const upstream = await backend.run(openCodeRequest(normalized, model, variant, backend.toolIds ?? []), controller.signal);
        const result = openCodeResult(upstream, normalized.tools.length > 0 && normalized.toolChoice.mode !== "none");
        if (kind === "responses") {
          const response = responseObject(result, model);
          status = 200;
          if (normalized.stream) { startSse(res); streamResponse(res, result, response); }
          else sendJson(res, 200, response);
        } else {
          const completion = chatObject(result, model);
          status = 200;
          if (normalized.stream) { startSse(res); streamChat(res, result, completion); }
          else sendJson(res, 200, completion);
        }
      } finally {
        clearTimeout(timeout);
        res.off("close", disconnected);
        active--;
      }
    } catch (cause) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else {
        const error = cause instanceof ApiError ? cause : cause?.name === "AbortError"
          ? new ApiError(504, "The upstream request timed out", "server_error", null, "timeout")
          : new ApiError(502, "OpenCode request failed", "server_error", null, "upstream_error");
        status = error.status;
        sendJson(res, error.status, errorBody(error));
      }
    } finally {
      logger.info?.(`${requestId} ${req.method} ${route} ${status} ${Date.now() - started}ms`);
    }
  });
  return server;
}
