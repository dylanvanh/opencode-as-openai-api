import type { OpenCodeBackendStrategy } from "./opencode-backend-strategy.js";
import { setTimeout as delay } from "node:timers/promises";
import { splitModel, type OpenCodeRequestBody } from "../translate.js";
import { GATEWAY_AGENT_NAME, validateOpenCodeV2Version } from "./opencode-configuration.js";
import { OpenCodeHttpError, OpenCodeTransport } from "./opencode-transport.js";
import { compileSchema } from "./response-format.js";

const CLEANUP_TIMEOUT_5_SECONDS_MS = 5_000;
const LATEST_MESSAGE_LIMIT = 1;
const MAX_SESSION_ID_LENGTH = 256;
const CATALOG_ATTEMPTS = 20;
const CATALOG_RETRY_DELAY_100_MS = 100;
const HTTP_NOT_FOUND_STATUS = 404;
type UnknownRecord = Record<string, unknown>;

export class OpenCodeV2Backend implements OpenCodeBackendStrategy {
  readonly toolIds: string[] = [];

  constructor(private readonly transport: OpenCodeTransport, private readonly directory?: string) {}

  async ready(model: string, signal: AbortSignal): Promise<string> {
    const health = await this.transport.request("/api/health", {}, signal);
    if (!isRecord(health) || health["healthy"] !== true) throw new Error("OpenCode is not healthy");
    const version = validateOpenCodeV2Version(health["version"]);
    const { providerID, modelID } = splitModel(model);
    let startupError = new Error(`OpenCode model is not connected: ${model}`);
    for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(CATALOG_RETRY_DELAY_100_MS, undefined, { signal });
      try {
        await this.checkAgent(signal);
      } catch (error) {
        if (!(error instanceof OpenCodeHttpError) || error.status !== HTTP_NOT_FOUND_STATUS) throw error;
        startupError = new Error(`Configure the ${GATEWAY_AGENT_NAME} primary agent in the selected OpenCode directory`);
        continue;
      }
      const models = responseData(await this.transport.request(this.locationPath("/api/model"), {}, signal));
      if (!Array.isArray(models)) throw new Error("OpenCode returned invalid models");
      if (models.some((model: unknown) => isRecord(model) && model["id"] === modelID
        && model["providerID"] === providerID && model["enabled"] === true)) return version;
      startupError = new Error(`OpenCode model is not connected: ${model}`);
    }
    throw startupError;
  }

  async run(body: OpenCodeRequestBody, signal: AbortSignal): Promise<unknown> {
    const validate = body.format ? compileSchema(body.format.schema, "output schema") : undefined;
    await this.checkAgent(signal);
    const session = responseData(await this.transport.request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "opencode-as-openai-api request",
        agent: body.agent,
        model: { providerID: body.model.providerID, id: body.model.modelID, ...(body.variant ? { variant: body.variant } : {}) },
        ...(this.directory ? { location: { directory: this.directory } } : {}),
      }),
    }, signal));
    const sessionPath = `/api/session/${sessionIdFrom(session)}`;
    let isIdle = false;
    try {
      const prompt = createPrompt(body);
      const retryCount = body.format?.retryCount ?? 0;
      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        isIdle = false;
        await this.transport.request(`${sessionPath}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: attempt === 0 ? prompt : `Your previous reply did not match the output schema. Return only a valid JSON object.\n\n${prompt}` }),
        }, signal);
        await this.transport.request(`${sessionPath}/wait`, { method: "POST" }, signal);
        isIdle = true;
        const state = responseData(await this.transport.request(sessionPath, {}, signal));
        if (!isRecord(state) || state["outcome"] !== "succeeded") throw new Error("OpenCode session did not complete successfully");
        const messages = responseData(await this.transport.request(`${sessionPath}/message?type=assistant&order=desc&limit=${LATEST_MESSAGE_LIMIT}`, {}, signal));
        const text = finalMessageText(messages);
        const info: UnknownRecord = { tokens: state["tokens"] };
        if (!validate) return { info, parts: [{ type: "text", text }] };
        const structured = parseJson(text);
        if (!validate(structured)) continue;
        return { info: { ...info, structured }, parts: [] };
      }
      throw new Error("OpenCode returned invalid structured output after retries");
    } finally {
      if (!isIdle) {
        try {
          await this.transport.request(`${sessionPath}/interrupt`, { method: "POST" }, AbortSignal.timeout(CLEANUP_TIMEOUT_5_SECONDS_MS));
        } catch {
          // Best effort interruption with a fresh signal.
        }
      }
      try {
        await this.transport.request(sessionPath, { method: "DELETE" }, AbortSignal.timeout(CLEANUP_TIMEOUT_5_SECONDS_MS));
      } catch {
        // Best effort cleanup of the gateway-owned session.
      }
    }
  }

  private async checkAgent(signal: AbortSignal): Promise<void> {
    const agent = responseData(await this.transport.request(this.locationPath(`/api/agent/${GATEWAY_AGENT_NAME}`), {}, signal));
    if (!isRecord(agent) || agent["id"] !== GATEWAY_AGENT_NAME || (agent["mode"] !== "primary" && agent["mode"] !== "all")) {
      throw new Error(`Configure the ${GATEWAY_AGENT_NAME} primary agent in the selected OpenCode directory`);
    }
    if (!deniesAllPermissions(agent["permissions"])) {
      throw new Error(`The ${GATEWAY_AGENT_NAME} agent must end its permissions with a wildcard deny rule and have no later allow or ask rules`);
    }
  }

  private locationPath(path: string): string {
    if (!this.directory) return path;
    const query = new URLSearchParams({ "location[directory]": this.directory });
    return `${path}?${query}`;
  }
}

function createPrompt(body: OpenCodeRequestBody): string {
  const text = body.parts[0].text;
  if (!body.format) return text;
  return `${text}\n\nReturn exactly one JSON object matching this output schema, with no Markdown fences or other text. Function calls are JSON data for the client; do not execute tools.\nOutput schema:\n${JSON.stringify(body.format.schema)}`;
}

function responseData(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "data")) throw new Error("OpenCode returned an invalid V2 response envelope");
  return value["data"];
}

function sessionIdFrom(value: unknown): string {
  if (isRecord(value) && typeof value["id"] === "string" && value["id"].length <= MAX_SESSION_ID_LENGTH
    && /^ses[a-zA-Z0-9_-]+$/.test(value["id"])) return value["id"];
  throw new Error("OpenCode did not create a valid session");
}

function finalMessageText(value: unknown): string {
  const message: unknown = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(message) || message["type"] !== "assistant" || message["error"] != null
    || message["finish"] !== "stop" || !isRecord(message["time"]) || typeof message["time"]["completed"] !== "number"
    || !Array.isArray(message["content"])) throw new Error("OpenCode returned an incomplete or failed assistant message");
  const texts: string[] = [];
  for (const part of message["content"] as unknown[]) {
    if (!isRecord(part)) throw new Error("OpenCode returned invalid message content");
    if (part["type"] === "reasoning") continue;
    if (part["type"] !== "text" || typeof part["text"] !== "string") throw new Error("OpenCode returned unexpected tool or message content");
    texts.push(part["text"]);
  }
  if (texts.length === 0) throw new Error("OpenCode returned no assistant text");
  return texts.join("");
}

function deniesAllPermissions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let hasWildcardDeny = false;
  for (const rule of value as unknown[]) {
    if (!isRecord(rule)) return false;
    if (rule["effect"] !== "deny") hasWildcardDeny = false;
    if (rule["action"] === "*" && rule["resource"] === "*" && rule["effect"] === "deny") hasWildcardDeny = true;
  }
  return hasWildcardDeny;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
