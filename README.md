# OpenCode Tools

This repository contains two separate packages:

| Package | Purpose |
| --- | --- |
| [`opencode-as-openai-api`](packages/opencode-as-openai-api) | Expose an OpenCode model through an OpenAI-compatible API. |
| [`meat-plannotator-review`](packages/meat-plannotator-review) | Reduce a Git diff with Meat and open it in Plannotator. |

The review package starts the gateway as a private subprocess. The gateway does not contain review code.

## Test

```sh
npm run check
```
