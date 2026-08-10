# Meat + Plannotator Review

`meat-plannotator-review` sends a Git diff through Meat, then opens the smaller reading diff in Plannotator.

This is separate from the `opencode-as-openai-api` gateway package. It starts the gateway as a private subprocess only because Meat needs an OpenAI-compatible endpoint for the selected OpenCode model.

## 1. Get Repository Access

Install [GitHub CLI](https://cli.github.com/), then sign in with an account that can access this private repository:

```sh
gh auth login
```

## 2. Install Everything

### macOS or Linux

```sh
gh api -H "Accept: application/vnd.github.raw+json" \
  "repos/dylanvanh/opencode-as-openai-api/contents/packages/meat-plannotator-review/scripts/install.sh?ref=main" | bash
```

### Windows PowerShell

```powershell
gh api -H "Accept: application/vnd.github.raw+json" `
  "repos/dylanvanh/opencode-as-openai-api/contents/packages/meat-plannotator-review/scripts/install.ps1?ref=main" |
  Out-String | Invoke-Expression
```

Open a new terminal after installation.

## 3. Connect a Model

Start OpenCode:

```sh
opencode
```

Enter `/connect` to connect a provider. Enter `/models` to find the model name in `provider/model` format.

## 4. Review Local Changes

Run this inside the Git repository you want to review:

```sh
meat-plannotator-review --model openai/gpt-5.6-sol
```

This includes branch commits, staged changes, unstaged changes, and untracked files. If the base branch is not detected, set it:

```sh
meat-plannotator-review --base origin/main --model openai/gpt-5.6-sol
```

## 5. Review a GitHub PR

```sh
meat-plannotator-review \
  https://github.com/owner/repository/pull/123 \
  --model openai/gpt-5.6-sol
```

The PR diff opens as a static Plannotator review. Feedback stays local and is not posted to GitHub.

## Common Problems

- `command not found`: open a new terminal and try again.
- GitHub access error: run `gh auth login` and confirm that your account can access the repository.
- Model not connected: open `opencode`, then use `/connect` and `/models`.
