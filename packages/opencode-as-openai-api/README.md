# OpenCode as OpenAI API

`opencode-as-openai-api` exposes any configured OpenCode model through an OpenAI-compatible HTTP API. It supports text, structured JSON output, and caller-owned function tools through both Responses and Chat Completions.

## Requirements

- Bun 1.3.14 or newer
- Node.js 20 or newer
- OpenCode V2, installed locally or running on an upstream server. V1 1.18.4 or newer remains supported during migration.
- A provider and model already configured in OpenCode

## Start

```sh
bunx opencode-as-openai-api --model anthropic/claude-sonnet-4-20250514
```

Set a stable API token before startup if another local program needs a fixed value:

```sh
OPENCODE_API_TOKEN=choose-a-long-random-value bunx opencode-as-openai-api --model provider/model
```

The command prints the local base URL, token, and client configuration. The default base URL is `http://127.0.0.1:8787/v1`.

## Connect to an Existing Server

Prepare the gateway agent in an empty directory on your OpenCode server, then start the gateway:

```sh
OPENCODE_API_TOKEN=choose-a-long-random-value \
OPENCODE_SERVER_PASSWORD=your-existing-opencode-password \
opencode-as-openai-api \
  --upstream-url http://127.0.0.1:4096 \
  --directory /srv/opencode-api \
  --model provider/model
```

`--directory` is an absolute path on the **upstream server**. The gateway checks the server version, agent, and model before it starts listening. It creates and deletes its own request sessions and leaves the existing OpenCode process running when it stops. A local OpenCode executable is not required in this mode.

The gateway detects V2 automatically. It supports both V2 release versions and the `0.0.0-beta-<build>` version format. Set `OPENCODE_UPSTREAM_TOKEN` instead of `OPENCODE_SERVER_PASSWORD` when your upstream uses Bearer authentication.

See the [existing-server setup guide](docs/existing-server.md) for the agent configuration, a Linux service example, and HTTPS access.

## API

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/responses`
- `POST /v1/chat/completions`

All routes require `Authorization: Bearer <token>`. The gateway accepts text, function definitions, function calls, and function results. The calling client executes functions. OpenCode file, shell, network, and agent tools are disabled.

This is focused compatibility, not full OpenAI API parity. Images, audio, files, built-in OpenAI tools, stored responses, background responses, conversations, and multiple chat choices are not supported.

## Structured Output

Use `response_format` with Chat Completions:

```json
{
  "model": "provider/model",
  "messages": [{ "role": "user", "content": "Return a city to visit." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "city_response",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  }
}
```

The answer is a JSON string in `choices[0].message.content`, for example `{"city":"Cape Town"}`.

For Responses, use the same schema under `text.format`. The `name`, `strict`, and `schema` fields go directly inside `format`:

```json
{
  "model": "provider/model",
  "input": "Return a city to visit.",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "city_response",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  }
}
```

- `{ "type": "json_object" }` requests a JSON object without a caller schema. `{ "type": "text" }` selects plain text.
- Schemas must have `"type": "object"` at the root. The gateway validates JSON Schema draft-07 (default), 2019-09, and 2020-12, including local references and standard string formats. Remote schema loading and asynchronous validation are not supported. Schemas are limited to 64 levels and 10,000 nodes.
- The gateway validates schemas and returned objects with Ajv, even when `strict` is omitted or false. Invalid schemas return HTTP 400; missing or invalid structured replies return HTTP 502.
- V2's published prompt API has no per-request structured-output field. The gateway includes the output schema in the prompt, validates the complete JSON reply, and permits two correction attempts. This is gateway validation, not provider-native constrained generation. V1 uses its native structured-output field.
- Function tools can be used with a response format. `tool_choice: "required"` or a named function still requires a function call. The response format applies to the final answer, not the function arguments.
- Both endpoints support `stream: true`. The gateway validates the complete upstream result before it sends SSE events; streaming is buffered.

## Options

```text
--model <provider/model>       Required
--variant <id>                 Fixed OpenCode model variant
--upstream-url <url>            Connect to an existing OpenCode server (V2 or V1 auto-detected)
--directory <path>             Configuration directory; required absolute upstream path with --upstream-url
--port <number>                Default: 8787; 0 selects a free port
--help
--version
```

Without `--upstream-url`, the gateway starts a private OpenCode process. Without `--directory`, that process runs in a new empty temporary directory.

Private V2 processes receive a native V2 agent configuration and a Basic authentication password. The gateway generates that password if none is set. V2 does not receive V1's `--pure` flag; applicable global configuration, plugins, and instructions still load.

For upstream Basic authentication, set `OPENCODE_SERVER_PASSWORD` and, if needed, `OPENCODE_SERVER_USERNAME` (default: `opencode`). These credentials are separate from the gateway's `OPENCODE_API_TOKEN`. HTTP and HTTPS upstream URLs can include a path prefix. URL credentials, query strings, fragments, and redirects are not supported.

For an existing upstream that uses Bearer authentication, set `OPENCODE_UPSTREAM_TOKEN`. Do not combine it with `OPENCODE_SERVER_PASSWORD`.

## Test

```sh
bun test
```

Users are responsible for the terms, credentials, limits, and costs of each provider that they configure in OpenCode.
