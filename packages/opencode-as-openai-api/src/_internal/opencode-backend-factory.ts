import type { OpenCodeBackendStrategy } from "./opencode-backend-strategy.js";
import { OpenCodeHttpError, OpenCodeTransport } from "./opencode-transport.js";
import { OpenCodeV1Backend } from "./opencode-v1-backend.js";
import { OpenCodeV2Backend } from "./opencode-v2-backend.js";

const HTTP_NOT_FOUND_STATUS = 404;

export async function detectOpenCodeBackendStrategy(
  transport: OpenCodeTransport,
  directory: string | undefined,
  signal: AbortSignal,
): Promise<OpenCodeBackendStrategy> {
  let health: unknown;
  try {
    health = await transport.request("/api/health", {}, signal);
  } catch (error) {
    if (error instanceof OpenCodeHttpError && error.status === HTTP_NOT_FOUND_STATUS) {
      return new OpenCodeV1Backend(transport, directory);
    }
    throw error;
  }
  if (isLegacyHealth(health)) return new OpenCodeV1Backend(transport, directory);
  return new OpenCodeV2Backend(transport, directory);
}

function isLegacyHealth(value: unknown): boolean {
  // V1 also serves /api/health, but returns only { healthy: true }.
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "healthy" in value && value.healthy === true && Object.keys(value).length === 1;
}
