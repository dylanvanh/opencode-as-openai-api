# Expose an Existing OpenCode Server

Run the gateway as a separate service beside your OpenCode V2 server. An HTTPS reverse proxy gives clients an OpenAI-compatible endpoint.

```text
Client → https://ai.example.com/v1 → gateway at 127.0.0.1:8787 → OpenCode at 127.0.0.1:4096
```

## 1. Configure the Upstream Directory

Check the upstream version with `opencode --version`. The gateway supports V2 releases and the `0.0.0-beta-<build>` version format. Older beta installations may use the `opencode2` command. An isolated smoke test used `0.0.0-beta-19425` with a local mock model provider.

Create a dedicated directory, such as `/srv/opencode-api`, that the OpenCode server account can read. Put this configuration in `/srv/opencode-api/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "opencode-as-openai-api": {
      "description": "Restricted OpenAI-compatible API adapter",
      "mode": "primary",
      "system": "Answer the supplied API conversation. Do not access local resources.",
      "permissions": [{ "action": "*", "resource": "*", "effect": "deny" }]
    }
  }
}
```

Use an empty directory outside a project checkout. The gateway uses this directory as the V2 session's location. OpenCode's existing global configuration, plugins, and applicable instructions still apply.

The gateway checks this primary agent and its effective permissions at startup and before each request. Its permissions must contain a wildcard deny rule with no later allow or ask rules. V2 does not accept V1's per-request tool-disable map or session permission list, so the configured agent provides the tool restrictions. Caller-owned function calls are returned to the client for execution.

The gateway does not write server configuration, create upstream directories, or restart the existing server. If the server has already loaded this directory's configuration, reload it through your normal OpenCode workflow before starting the gateway.

## 2. Start the Gateway

Install the gateway package on the host where it will run. The gateway host needs Node.js 20 or newer. Attached mode does not need a local OpenCode executable.

Set the gateway token and the existing server's credentials:

```sh
export OPENCODE_API_TOKEN='replace-with-a-long-random-token'
export OPENCODE_SERVER_USERNAME='opencode'
export OPENCODE_SERVER_PASSWORD='replace-with-the-existing-server-password'

opencode-as-openai-api \
  --upstream-url http://127.0.0.1:4096 \
  --directory /srv/opencode-api \
  --model provider/model \
  --port 8787
```

Replace `provider/model` with a connected model. Omit the upstream username and password variables if the OpenCode server does not require authentication. Upstream credentials use HTTP Basic authentication; clients of the gateway use its separate bearer token.

V2 foreground servers require authentication on localhost too. Use the password configured for that server, or the generated password it printed at startup. If your upstream endpoint uses Bearer authentication, unset `OPENCODE_SERVER_PASSWORD` and set `OPENCODE_UPSTREAM_TOKEN` instead. The gateway rejects conflicting Basic and Bearer settings. It never uses `OPENCODE_API_TOKEN` as an upstream credential.

If OpenCode is on another host, set `--upstream-url` to its HTTP or HTTPS address. The directory always refers to the upstream host. URL path prefixes are supported, for example `https://internal.example.com/opencode`. Use the final URL directly; the gateway does not follow redirects.

The gateway checks health, the supported version, the agent, and the model before it prints `Ready`. Stopping the gateway leaves the existing server running. It only deletes the sessions it creates for API requests.

### V2 request handling

The adapter uses the [published V2 API](https://opencode.ai/v2/openapi.json):

1. Read `/api/health`, the gateway agent, and available models. Allow a short startup retry while the agent and model catalogs load.
2. Create `/api/session` with the selected agent, model, variant, and location.
3. Submit `/api/session/{id}/prompt`, then wait at `/api/session/{id}/wait`.
4. Check the session outcome and read the latest completed assistant message. Map session token usage into the OpenAI response.
5. Delete the request session. If waiting fails or the request is cancelled, first call `/api/session/{id}/interrupt` with a fresh cleanup timeout.

V2 has no per-request JSON-schema field in its published prompt API. For structured output and caller-owned functions, the gateway puts the complete output schema in the prompt and validates the returned JSON. It allows two correction attempts. Required and named function choices remain enforced, including argument schemas. Exhausted retries, failed sessions, and incomplete replies return HTTP 502. SSE output remains buffered until validation succeeds.

See the [V2 client guide](https://opencode.ai/v2/docs/build/client), [agent configuration](https://opencode.ai/v2/docs/agents), and [migration guide](https://opencode.ai/v2/docs/migrate-v1) for the upstream contracts.

### Adapter structure

`src/_internal/opencode-backend-strategy.ts` defines the shared `ready`, `toolIds`, and `run` contract. `OpenCodeV1Backend` and `OpenCodeV2Backend` implement that contract independently, including their session lifecycle and response conversion.

`opencode-backend-factory.ts` detects the API and selects a strategy. `OpenCodeHttpBackend` publishes the connection only after initialization succeeds, then delegates requests to that strategy. Both implementations use `OpenCodeTransport` for authentication and HTTP errors.

Private-process setup uses a separate `OpenCodeServerStrategy` contract in `opencode-server-strategy.ts`. It supplies version-specific launch arguments, agent configuration, and password handling to the CLI.

### Transition from V1

The gateway also supports V1 1.18.4 or newer. It detects the API during startup, so restart the gateway after switching the upstream server to V2. Your OpenAI client URL and gateway token stay the same.

V2 accepts supported V1 agent configuration. You can retain the earlier `agent` / `prompt` / `permission` configuration during the switch, or use the native V2 example above after migration. V1 cannot read the native V2 example. Keep a V1 copy if you need to return to the older server.

## 3. Run as a Linux Service

Create a service account named `opencode-api`. Install the gateway and Node.js where this account can execute them. Adjust `ExecStart` below if the gateway executable is installed somewhere other than `/usr/local/bin`.

Create `/etc/opencode-as-openai-api.env` with the credentials from step 2:

```text
OPENCODE_API_TOKEN=replace-with-a-long-random-token
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=replace-with-the-existing-server-password
```

Keep this file owned by root with mode `0600`. The system service manager reads it before starting the process as `opencode-api`.

Create `/etc/systemd/system/opencode-as-openai-api.service`:

```ini
[Unit]
Description=OpenCode OpenAI-compatible gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=opencode-api
EnvironmentFile=/etc/opencode-as-openai-api.env
ExecStart=/usr/local/bin/opencode-as-openai-api --upstream-url http://127.0.0.1:4096 --directory /srv/opencode-api --model provider/model --port 8787
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace the model and addresses, then enable the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-as-openai-api
sudo systemctl status opencode-as-openai-api
```

## 4. Add HTTPS

Point a domain at this host and configure your reverse proxy to forward to `127.0.0.1:8787`. The gateway remains bound to loopback.

For Caddy, add this site to your Caddyfile:

```caddyfile
ai.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Use your real domain. With DNS and inbound ports 80 and 443 configured, Caddy can manage HTTPS certificates. Reload Caddy through your normal service workflow.

The client base URL is now `https://ai.example.com/v1`. Requests must include `Authorization: Bearer <OPENCODE_API_TOKEN>`:

```sh
curl https://ai.example.com/v1/models \
  -H "Authorization: Bearer $OPENCODE_API_TOKEN"
```

Each gateway process still exposes one selected model and accepts one model request at a time. Concurrent requests receive HTTP 429. Structured output and buffered SSE work through this endpoint.
