import { splitModel, type OpenCodeRequestBody } from "../translate.js";
import { DENIED_PERMISSIONS, GATEWAY_AGENT_NAME, validateOpenCodeVersion } from "./opencode-configuration.js";
import type { OpenCodeBackendStrategy } from "./opencode-backend-strategy.js";
import { OpenCodeTransport } from "./opencode-transport.js";

const BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS = 5_000;

type UnknownRecord = Record<string, unknown>;

export class OpenCodeV1Backend implements OpenCodeBackendStrategy {
  toolIds: string[] = [];

  constructor(private readonly transport: OpenCodeTransport, private readonly directory?: string) {}

  async ready(model: string, signal: AbortSignal): Promise<string> {
    const health = await this.request("/global/health", {}, signal);
    if (!isRecord(health) || health["healthy"] !== true) throw new Error("OpenCode is not healthy");
    const version = validateOpenCodeVersion(health["version"]);
    const agents = await this.request("/agent", {}, signal);
    if (!hasGatewayAgent(agents)) {
      throw new Error(`Configure the ${GATEWAY_AGENT_NAME} primary agent in the selected OpenCode directory; see the existing-server setup guide`);
    }
    this.toolIds = ["*", ...toolIdsFrom(await this.request("/experimental/tool/ids", {}, signal))];
    const providers = await this.request("/config/providers", {}, signal);
    if (!hasModel(providers, model)) throw new Error(`OpenCode model is not connected: ${model}`);
    return version;
  }

  async run(body: OpenCodeRequestBody, signal: AbortSignal): Promise<unknown> {
    const session = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({
        title: "opencode-as-openai-api request",
        permission: DENIED_PERMISSIONS.map((permission) => ({ permission, pattern: "*", action: "deny" })),
      }),
    }, signal);
    const sessionId = sessionIdFrom(session);
    const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
    try {
      return await this.request(`${sessionPath}/message`, { method: "POST", body: JSON.stringify(body) }, signal);
    } finally {
      if (signal.aborted) {
        try {
          await this.request(`${sessionPath}/abort`, { method: "POST" }, AbortSignal.timeout(BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS));
        } catch {
          // Best effort abort.
        }
      }
      try {
        await this.request(sessionPath, { method: "DELETE" }, AbortSignal.timeout(BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS));
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private async request(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const query = this.directory ? `?${new URLSearchParams({ directory: this.directory })}` : "";
    return this.transport.request(`${path}${query}`, options, signal);
  }
}

function hasGatewayAgent(value: unknown): boolean {
  if (!Array.isArray(value)) throw new Error("OpenCode returned invalid agents");
  return value.some((agent: unknown) => isRecord(agent)
    && agent["name"] === GATEWAY_AGENT_NAME
    && (agent["mode"] === "primary" || agent["mode"] === "all"));
}

function toolIdsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("OpenCode returned invalid tool identifiers");
  return value.map((toolId: unknown, index) => {
    if (typeof toolId === "string" && toolId) return toolId;
    throw new Error(`OpenCode returned an invalid tool identifier at index ${index}`);
  });
}

function sessionIdFrom(value: unknown): string {
  if (isRecord(value) && typeof value["id"] === "string" && value["id"]) return value["id"];
  throw new Error("OpenCode did not create a session");
}

function hasModel(value: unknown, selectedModel: string): boolean {
  const { providerID, modelID } = splitModel(selectedModel);
  if (!isRecord(value) || !Array.isArray(value["providers"])) throw new Error("OpenCode returned invalid provider configuration");
  for (const [index, provider] of value["providers"].entries()) {
    if (!isRecord(provider) || typeof provider["id"] !== "string" || !isRecord(provider["models"])) {
      throw new Error(`OpenCode returned an invalid provider at index ${index}`);
    }
    if (provider["id"] === providerID) return Object.hasOwn(provider["models"], modelID);
  }
  return false;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
