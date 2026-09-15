import { createServer, type IncomingMessage } from "node:http";

export const UPSTREAM_MODEL = "test/model";
export const UPSTREAM_VERSION = "1.18.16";
export const UPSTREAM_DIRECTORY = "/remote-only/opencode API/日本語";
export const UPSTREAM_USERNAME = "gateway-user";
export const UPSTREAM_PASSWORD = "upstream-secret";
export const UPSTREAM_AUTHORIZATION = `Basic ${Buffer.from(`${UPSTREAM_USERNAME}:${UPSTREAM_PASSWORD}`).toString("base64")}`;
export const UPSTREAM_PREFIX = "/opencode";
export const UPSTREAM_V2_VERSION = "0.0.0-beta-19425";
export const UPSTREAM_V2_TOKEN = "v2-upstream-token";
export const UPSTREAM_V2_SESSION_PATH = "/api/session/ses_owned";
const DYNAMIC_PORT = 0;
const HTTP_OK_STATUS = 200;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_FOUND_STATUS = 302;

export interface UpstreamRequest {
  method: string | undefined;
  path: string;
  directory: string | null;
  authorization: string | undefined;
  body: unknown;
  query: URLSearchParams;
}

interface FixtureOptions {
  apiVersion?: 2;
  healthStatus?: number;
  permissions?: unknown;
  agentPendingReads?: number;
  models?: unknown;
  outcome?: string;
  messages?: unknown;
  texts?: string[];
  onWait?: () => void;
  health?: unknown;
  agents?: unknown;
  providers?: unknown;
  authorization?: string | null;
  messageStatus?: number;
  messageResult?: unknown;
  onMessage?: () => void;
  healthRedirect?: string;
}

export async function createUpstreamFixture(options: FixtureOptions = {}) {
  const requests: UpstreamRequest[] = [];
  let promptCount = 0;
  let agentReadCount = 0;
  const authorization = options.authorization === undefined ? UPSTREAM_AUTHORIZATION : options.authorization;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.slice(UPSTREAM_PREFIX.length);
    requests.push({
      method: request.method,
      path,
      directory: url.searchParams.get("directory") ?? url.searchParams.get("location[directory]"),
      authorization: request.headers.authorization,
      body: await requestBody(request),
      query: url.searchParams,
    });
    const sendJson = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (authorization && request.headers.authorization !== authorization) {
      sendJson(HTTP_UNAUTHORIZED_STATUS, { error: "unauthorized" });
      return;
    }
    if (!url.pathname.startsWith(`${UPSTREAM_PREFIX}/`)) {
      sendJson(HTTP_NOT_FOUND_STATUS, {});
      return;
    }
    if (options.apiVersion === 2) {
      if (path === "/api/health") {
        sendJson(options.healthStatus ?? HTTP_OK_STATUS, options.health ?? { healthy: true, version: UPSTREAM_V2_VERSION, pid: 1 });
        return;
      }
      if (path === "/api/agent/opencode-as-openai-api") {
        agentReadCount += 1;
        if (agentReadCount <= (options.agentPendingReads ?? 0)) {
          sendJson(HTTP_NOT_FOUND_STATUS, {});
          return;
        }
        sendJson(HTTP_OK_STATUS, { data: {
          id: "opencode-as-openai-api", name: "Gateway", mode: "primary", hidden: false, request: {},
          permissions: options.permissions ?? [{ action: "*", resource: "*", effect: "deny" }],
        } });
        return;
      }
      if (path === "/api/model") {
        sendJson(HTTP_OK_STATUS, { data: options.models ?? [{ providerID: "test", id: "model", enabled: true }] });
        return;
      }
      if (path === "/api/session" && request.method === "POST") {
        sendJson(HTTP_OK_STATUS, { data: { id: "ses_owned" } });
        return;
      }
      if (path === `${UPSTREAM_V2_SESSION_PATH}/prompt`) {
        promptCount += 1;
        options.onMessage?.();
        sendJson(options.messageStatus ?? HTTP_OK_STATUS, { data: { id: "inbox_owned" } });
        return;
      }
      if (path === `${UPSTREAM_V2_SESSION_PATH}/wait`) {
        options.onWait?.();
        response.writeHead(204);
        response.end();
        return;
      }
      if (path === UPSTREAM_V2_SESSION_PATH && request.method === "GET") {
        sendJson(HTTP_OK_STATUS, { data: { id: "ses_owned", outcome: options.outcome ?? "succeeded", tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 0, write: 0 } } } });
        return;
      }
      if (path === `${UPSTREAM_V2_SESSION_PATH}/message`) {
        sendJson(HTTP_OK_STATUS, { data: options.messages ?? [{
          id: "msg_answer", type: "assistant", agent: "opencode-as-openai-api", model: { id: "model", providerID: "test" },
          finish: "stop", time: { created: 1, completed: 2 },
          content: [{ type: "text", text: options.texts?.[promptCount - 1] ?? "Remote answer" }],
        }], cursor: {} });
        return;
      }
      if (path === `${UPSTREAM_V2_SESSION_PATH}/interrupt`) {
        sendJson(HTTP_OK_STATUS, { interrupted: true });
        return;
      }
      if (path === UPSTREAM_V2_SESSION_PATH && request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(HTTP_NOT_FOUND_STATUS, {});
      return;
    }
    if (path === "/api/health") {
      sendJson(HTTP_OK_STATUS, { healthy: true });
      return;
    }
    if (path === "/global/health") {
      if (options.healthRedirect) {
        response.writeHead(HTTP_FOUND_STATUS, { location: options.healthRedirect });
        response.end();
        return;
      }
      sendJson(HTTP_OK_STATUS, options.health ?? { healthy: true, version: UPSTREAM_VERSION });
      return;
    }
    if (path === "/agent") {
      sendJson(HTTP_OK_STATUS, options.agents ?? [{ name: "opencode-as-openai-api", mode: "primary" }]);
      return;
    }
    if (path === "/experimental/tool/ids") {
      sendJson(HTTP_OK_STATUS, ["bash", "read", "mcp_custom_tool"]);
      return;
    }
    if (path === "/config/providers") {
      sendJson(HTTP_OK_STATUS, options.providers ?? { providers: [{ id: "test", models: { model: {} } }] });
      return;
    }
    if (path === "/session" && request.method === "POST") {
      sendJson(HTTP_OK_STATUS, { id: "owned-session" });
      return;
    }
    if (path === "/session/owned-session/message" && request.method === "POST") {
      options.onMessage?.();
      sendJson(options.messageStatus ?? HTTP_OK_STATUS, options.messageResult ?? { info: {}, parts: [{ type: "text", text: "Remote answer" }] });
      return;
    }
    if (path === "/session/owned-session/abort" || (path === "/session/owned-session" && request.method === "DELETE")) {
      sendJson(HTTP_OK_STATUS, true);
      return;
    }
    sendJson(HTTP_NOT_FOUND_STATUS, {});
  });
  await new Promise<void>((resolveListen) => server.listen(DYNAMIC_PORT, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}${UPSTREAM_PREFIX}`,
    requests,
    close: (): Promise<void> => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}
