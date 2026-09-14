const MINIMUM_OPENCODE_VERSION = { major: 1, minor: 18, patch: 4 };

export const GATEWAY_AGENT_NAME = "opencode-as-openai-api";
export const V2_DENY_ALL_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" }];
export const DENIED_PERMISSIONS = [
  "*",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
];

export function validateOpenCodeVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw unsupportedVersion();
  const [major, minor, patch] = value.split(".").map(Number);
  if (
    major !== MINIMUM_OPENCODE_VERSION.major
    || minor === undefined
    || patch === undefined
    || !Number.isSafeInteger(minor)
    || !Number.isSafeInteger(patch)
    || minor < MINIMUM_OPENCODE_VERSION.minor
    || (minor === MINIMUM_OPENCODE_VERSION.minor && patch < MINIMUM_OPENCODE_VERSION.patch)
  ) {
    throw unsupportedVersion();
  }
  return value;
}

export function validateOpenCodeV2Version(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^(?:2\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|0\.0\.0-beta-\d+)$/.test(value)) {
    throw new Error("A supported OpenCode 2.x server is required");
  }
  return value;
}

function unsupportedVersion(): Error {
  return new Error("OpenCode 1.18.4 or newer in the 1.x series is required");
}
