# OpenCode as OpenAI API

`opencode-as-openai-api` exposes any configured OpenCode model through an OpenAI-compatible HTTP API. It supports text and caller-owned function tools through both Responses and Chat Completions.

## Requirements

- Node.js 20 or newer
- OpenCode 1.18.4 or newer
- A provider and model already configured in OpenCode
- Meat and the patched Plannotator fork for `review`
- GitHub CLI for GitHub pull request reviews
- `cloudflared` only if you use `--tunnel quick`

## Start

```sh
npx opencode-as-openai-api --model anthropic/claude-sonnet-4-20250514
```

Set a stable API token before startup if another local program needs a fixed value:

```sh
OPENCODE_API_TOKEN=choose-a-long-random-value npx opencode-as-openai-api --model provider/model
```

The command prints the local base URL, token, and client configuration. The default base URL is `http://127.0.0.1:8787/v1`.

## Meat + Plannotator review

Review all current branch changes since the base branch through Meat before opening Plannotator:

```sh
opencode-as-openai-api review --model provider/model
```

Review a GitHub pull request:

```sh
opencode-as-openai-api review https://github.com/owner/repo/pull/123 --model provider/model
```

The command starts a private gateway on a free port, sends the source diff through Meat, and opens the reduced patch as a static Plannotator review. For a pull request, feedback stays local and is not posted to GitHub because Meat can remove lines required for safe GitHub comment anchors. Use `--base <ref>` if the local base branch cannot be detected.

### Install everything

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/dylanvanh/opencode-as-openai-api/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/dylanvanh/opencode-as-openai-api/main/scripts/install.ps1 | iex
```

The installer adds GitHub CLI, Node.js, Go, Bun, OpenCode, Meat, the Plannotator fork, and this package. Windows uses `winget`; macOS and Linux use their native package manager for Git and GitHub CLI. Run `gh auth login` before reviewing a GitHub pull request.

## API

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/responses`
- `POST /v1/chat/completions`

All routes require `Authorization: Bearer <token>`. The gateway accepts text, function definitions, function calls, and function results. The calling client executes functions. OpenCode file, shell, network, and agent tools are disabled.

This is focused compatibility, not full OpenAI API parity. Images, audio, files, built-in OpenAI tools, stored responses, background responses, conversations, and multiple chat choices are not supported.

## Options

```text
--model <provider/model>       Required
--variant <id>                 Fixed OpenCode model variant
--directory <path>             Use this OpenCode configuration directory
--port <number>                Default: 8787; 0 selects a free port
--max-concurrency <number>     Default: 1
--tunnel quick                 Start a TryCloudflare tunnel
--help
--version
```

Without `--directory`, OpenCode runs in a new empty temporary directory. This stops project files and instructions from entering API requests.

TryCloudflare is for temporary tests. It does not support server-sent events, so public streaming requests return an error. Local streaming remains available.

## Test

```sh
npm test
```

Users are responsible for the terms, credentials, limits, and costs of each provider that they configure in OpenCode.
