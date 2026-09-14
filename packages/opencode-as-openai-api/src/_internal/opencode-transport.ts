const NO_CONTENT_STATUS = 204;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_FORBIDDEN_STATUS = 403;
const DEFAULT_SERVER_USERNAME = "opencode";

export interface BackendOptions {
  url: string;
  directory?: string;
  username?: string;
  password?: string;
  token?: string;
}

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number) {
    super(status === HTTP_UNAUTHORIZED_STATUS || status === HTTP_FORBIDDEN_STATUS
      ? `OpenCode authentication failed (${status}); check OPENCODE_UPSTREAM_TOKEN or OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD`
      : `OpenCode ${status}`);
  }
}

export class OpenCodeTransport {
  private readonly authorization: string | undefined;

  constructor(private readonly options: BackendOptions) {
    const username = options.username || DEFAULT_SERVER_USERNAME;
    if (username.includes(":")) throw new Error("OPENCODE_SERVER_USERNAME must not contain a colon");
    if (options.token && options.password) throw new Error("Set only one of OPENCODE_UPSTREAM_TOKEN and OPENCODE_SERVER_PASSWORD");
    if (options.token && /[\s\x00-\x1f\x7f]/.test(options.token)) throw new Error("OPENCODE_UPSTREAM_TOKEN must not contain whitespace or control characters");
    this.authorization = options.token ? `Bearer ${options.token}` : options.password
      ? `Basic ${Buffer.from(`${username}:${options.password}`).toString("base64")}`
      : undefined;
  }

  async request(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(`${this.options.url}${path}`);
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.authorization) headers.set("authorization", this.authorization);
    const response = await fetch(url, { ...options, headers, redirect: "error", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new OpenCodeHttpError(response.status);
    if (response.status === NO_CONTENT_STATUS) return null;
    return await response.json() as unknown;
  }
}
