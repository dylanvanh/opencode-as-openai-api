#!/usr/bin/env bash
set -euo pipefail

NODE_MAJOR="22"
NVM_VERSION="v0.40.6"
GO_VERSION="1.25.1"
BUN_VERSION="1.3.14"
OPENCODE_VERSION="1.18.15"
MEAT_VERSION="v0.0.0-20260803201634-f39f41dfe7b5"
PLANNOTATOR_REPOSITORY="${PLANNOTATOR_REPOSITORY:-https://github.com/dylanvanh/plannotator.git}"
PLANNOTATOR_REF="${PLANNOTATOR_REF:-feat/raw-patch-review}"
GATEWAY_PACKAGE="${GATEWAY_PACKAGE:-git+https://github.com/dylanvanh/opencode-as-openai-api.git}"
INSTALL_PREFIX="${HOME}/.local"
INSTALL_BIN="${INSTALL_PREFIX}/bin"
WORK_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$WORK_DIRECTORY"' EXIT

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null; then
    sudo "$@"
  else
    echo "sudo is required to install system packages." >&2
    exit 1
  fi
}

install_system_tools() {
  if command -v git >/dev/null && command -v gh >/dev/null; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      if ! command -v brew >/dev/null; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        if [[ -x /opt/homebrew/bin/brew ]]; then
          eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [[ -x /usr/local/bin/brew ]]; then
          eval "$(/usr/local/bin/brew shellenv)"
        fi
      fi
      brew install git gh
      ;;
    Linux)
      if command -v apt-get >/dev/null; then
        run_as_root apt-get update
        run_as_root apt-get install -y git gh ca-certificates
      elif command -v dnf >/dev/null; then
        run_as_root dnf install -y git gh
      elif command -v pacman >/dev/null; then
        run_as_root pacman -Sy --needed git github-cli
      else
        echo "Install Git and GitHub CLI, then run this installer again." >&2
        exit 1
      fi
      ;;
    *)
      echo "Use install.ps1 on Windows." >&2
      exit 1
      ;;
  esac
}

install_node() {
  if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    return
  fi

  export NVM_DIR="${HOME}/.nvm"
  if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  fi
  # shellcheck source=/dev/null
  source "${NVM_DIR}/nvm.sh"
  nvm install "${NODE_MAJOR}"
  nvm use "${NODE_MAJOR}"
}

install_go() {
  local go_os go_arch go_root
  case "$(uname -s)" in
    Darwin) go_os="darwin" ;;
    Linux) go_os="linux" ;;
    *) echo "Unsupported Go platform" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) go_arch="arm64" ;;
    x86_64|amd64) go_arch="amd64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  go_root="${INSTALL_PREFIX}/share/opencode-meat-review/go"
  if [[ ! -x "${go_root}/bin/go" ]] || ! "${go_root}/bin/go" version | grep -Fq "go${GO_VERSION}"; then
    mkdir -p "$(dirname "$go_root")"
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.${go_os}-${go_arch}.tar.gz" -o "${WORK_DIRECTORY}/go.tar.gz"
    rm -rf "$go_root"
    tar -xzf "${WORK_DIRECTORY}/go.tar.gz" -C "$(dirname "$go_root")"
  fi
  export PATH="${go_root}/bin:${PATH}"
}

install_bun() {
  if ! command -v bun >/dev/null; then
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
    export PATH="${HOME}/.bun/bin:${PATH}"
  fi
}

persist_path() {
  local profile path_line
  case "${SHELL:-}" in
    */zsh) profile="${HOME}/.zshrc" ;;
    */bash) profile="${HOME}/.bashrc" ;;
    *) profile="${HOME}/.profile" ;;
  esac
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  touch "$profile"
  if ! grep -Fqx "$path_line" "$profile"; then
    printf '\n%s\n' "$path_line" >> "$profile"
  fi
}

install_system_tools
install_node
install_go
install_bun
mkdir -p "$INSTALL_BIN"
export PATH="${INSTALL_BIN}:${PATH}"

echo "Installing OpenCode and opencode-as-openai-api..."
npm install --global --prefix "$INSTALL_PREFIX" "opencode-ai@${OPENCODE_VERSION}" "$GATEWAY_PACKAGE"

echo "Installing Meat..."
GOBIN="$INSTALL_BIN" go install "meat.dev/cmd/meat@${MEAT_VERSION}"

echo "Building the Plannotator fork..."
git clone --depth 1 --branch "$PLANNOTATOR_REF" "$PLANNOTATOR_REPOSITORY" "${WORK_DIRECTORY}/plannotator"
(
  cd "${WORK_DIRECTORY}/plannotator"
  bun install --frozen-lockfile
  bun run --cwd apps/review build
  bun run build:hook
  bun build apps/hook/server/index.ts --compile --outfile "$INSTALL_BIN/plannotator"
)

persist_path

echo
echo "Installed: opencode, meat, plannotator, and opencode-as-openai-api"
echo "Open a new terminal, configure an OpenCode provider, then run:"
echo "  opencode-as-openai-api review --model provider/model"
echo "  opencode-as-openai-api review https://github.com/owner/repo/pull/123 --model provider/model"
