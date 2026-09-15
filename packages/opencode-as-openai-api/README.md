# OpenCode as OpenAI API

`opencode-as-openai-api` exposes any configured OpenCode model through an OpenAI-compatible HTTP API. It supports text, structured JSON output, and caller-owned function tools through both Responses and Chat Completions.

## Requirements

- Bun 1.3.14 or newer
- Node.js 20 or newer
- OpenCode 1.18.4 or newer
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
- The gateway passes the schema to OpenCode structured output and validates the returned object with Ajv. It validates the schema even when `strict` is omitted or false. Invalid schemas return HTTP 400; missing or invalid structured replies return HTTP 502.
- Function tools can be used with a response format. `tool_choice: "required"` or a named function still requires a function call. The response format applies to the final answer, not the function arguments.
- Both endpoints support `stream: true`. The gateway validates the complete upstream result before it sends SSE events; streaming is buffered.

## Options

```text
--model <provider/model>       Required
--variant <id>                 Fixed OpenCode model variant
--directory <path>             Use this OpenCode configuration directory
--port <number>                Default: 8787; 0 selects a free port
--help
--version
```

Without `--directory`, OpenCode runs in a new empty temporary directory. This stops project files and instructions from entering API requests.

## Test

```sh
bun test
```

Users are responsible for the terms, credentials, limits, and costs of each provider that they configure in OpenCode.
