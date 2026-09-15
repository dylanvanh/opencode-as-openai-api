import type { GatewayBackend } from "../server.js";

export interface OpenCodeBackendStrategy extends GatewayBackend {
  ready(model: string, signal: AbortSignal): Promise<string>;
}
