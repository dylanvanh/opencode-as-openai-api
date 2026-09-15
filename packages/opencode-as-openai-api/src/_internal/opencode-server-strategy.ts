import { randomBytes } from "node:crypto";
import { DENIED_PERMISSIONS, GATEWAY_AGENT_NAME, V2_DENY_ALL_PERMISSIONS, validateOpenCodeVersion, validateOpenCodeV2Version } from "./opencode-configuration.js";

const PASSWORD_RANDOM_BYTES = 32;
const AGENT_DESCRIPTION = "Restricted OpenAI-compatible API adapter";
const AGENT_INSTRUCTIONS = "Answer the supplied API conversation. Do not access local resources.";

export interface OpenCodeServerLaunchOptions {
  arguments: readonly string[];
  environment: Record<string, string>;
  backendPassword?: string;
}

export interface OpenCodeServerStrategy {
  validateVersion(version: unknown): string;
  createLaunchOptions(configuredPassword: string | undefined): OpenCodeServerLaunchOptions;
}

const v1ServerStrategy: OpenCodeServerStrategy = {
  validateVersion: validateOpenCodeVersion,
  createLaunchOptions: () => ({
    arguments: ["--pure"],
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: {
          [GATEWAY_AGENT_NAME]: {
            description: AGENT_DESCRIPTION,
            mode: "primary",
            prompt: AGENT_INSTRUCTIONS,
            permission: Object.fromEntries(DENIED_PERMISSIONS.map((permission) => [permission, "deny"])),
          },
        },
      }),
    },
  }),
};

const v2ServerStrategy: OpenCodeServerStrategy = {
  validateVersion: validateOpenCodeV2Version,
  createLaunchOptions: (configuredPassword) => {
    const password = configuredPassword || randomBytes(PASSWORD_RANDOM_BYTES).toString("hex");
    return {
      arguments: [],
      backendPassword: password,
      environment: {
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agents: {
            [GATEWAY_AGENT_NAME]: {
              description: AGENT_DESCRIPTION,
              mode: "primary",
              system: AGENT_INSTRUCTIONS,
              permissions: V2_DENY_ALL_PERMISSIONS,
            },
          },
        }),
      },
    };
  },
};

export function selectOpenCodeServerStrategy(version: string): OpenCodeServerStrategy {
  const strategy = version.startsWith("1.") ? v1ServerStrategy : v2ServerStrategy;
  strategy.validateVersion(version);
  return strategy;
}
