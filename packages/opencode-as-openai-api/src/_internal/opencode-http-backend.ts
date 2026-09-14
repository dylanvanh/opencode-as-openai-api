import type { OpenCodeRequestBody } from "../translate.js";
import type { OpenCodeBackendStrategy } from "./opencode-backend-strategy.js";
import { detectOpenCodeBackendStrategy } from "./opencode-backend-factory.js";
import { OpenCodeTransport, type BackendOptions } from "./opencode-transport.js";

interface ReadyConnection {
  strategy: OpenCodeBackendStrategy;
  version: string;
  model: string;
}

export class OpenCodeHttpBackend implements OpenCodeBackendStrategy {
  private readonly transport: OpenCodeTransport;
  private connection: ReadyConnection | undefined;

  constructor(private readonly options: BackendOptions) {
    this.transport = new OpenCodeTransport(options);
  }

  get toolIds(): readonly string[] {
    return this.connection?.strategy.toolIds ?? [];
  }

  async ready(model: string, signal: AbortSignal): Promise<string> {
    if (this.connection) {
      if (this.connection.model !== model) throw new Error("OpenCode backend is already connected to another model");
      return this.connection.version;
    }
    const strategy = await detectOpenCodeBackendStrategy(this.transport, this.options.directory, signal);
    const version = await strategy.ready(model, signal);
    this.connection = { strategy, version, model };
    return version;
  }

  async run(body: OpenCodeRequestBody, signal: AbortSignal): Promise<unknown> {
    if (!this.connection) throw new Error("OpenCode backend must be ready before running a request");
    return this.connection.strategy.run(body, signal);
  }
}
