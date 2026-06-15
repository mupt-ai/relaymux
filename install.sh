#!/usr/bin/env bash
set -euo pipefail

default_prefix="$HOME/.local"
prefix="${PREFIX:-$default_prefix}"
prefix_explicit=0
[[ -n "${PREFIX:-}" ]] && prefix_explicit=1
bin_dir="${BIN_DIR:-}"
install_dir="${INSTALL_DIR:-$prefix/lib/relaymux}"
repo_url="${RELAYMUX_REPO_URL:-https://github.com/mupt-ai/relaymux.git}"
ref="${RELAYMUX_REF:-main}"
tarball_url="${RELAYMUX_TARBALL_URL:-https://github.com/mupt-ai/relaymux/archive/${ref}.tar.gz}"
work_dir=""

usage() {
  cat <<'USAGE'
Install relaymux with a local build and a shell shim.

Usage:
  ./install.sh [--prefix <dir>] [--bin-dir <dir>] [--install-dir <dir>]
  curl -fsSL https://raw.githubusercontent.com/mupt-ai/relaymux/main/install.sh | bash

Environment:
  PREFIX                Base install prefix. Default: ~/.local
  BIN_DIR               Directory for the relaymux shim. Default: first writable PATH dir, then ~/.local/bin
  INSTALL_DIR           Directory for app files. Default: $PREFIX/lib/relaymux
  RELAYMUX_REF          GitHub ref to install when run outside a checkout. Default: main
  RELAYMUX_TARBALL_URL  Tarball URL to download when run outside a checkout.
  RELAYMUX_REPO_URL     Git repo fallback if curl/tar are unavailable.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="$2"
      prefix_explicit=1
      install_dir="${INSTALL_DIR:-$prefix/lib/relaymux}"
      shift 2
      ;;
    --bin-dir)
      bin_dir="$2"
      shift 2
      ;;
    --install-dir)
      install_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "relaymux install: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "relaymux install: missing required command: $1" >&2
    exit 1
  fi
}

path_has_dir() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

choose_bin_dir() {
  if [[ "$prefix_explicit" -eq 1 ]]; then
    printf '%s\n' "$prefix/bin"
    return
  fi

  if path_has_dir "$HOME/.local/bin"; then
    printf '%s\n' "$HOME/.local/bin"
    return
  fi

  for dir in /opt/homebrew/bin /usr/local/bin; do
    if [[ -d "$dir" ]] && path_has_dir "$dir" && [[ -w "$dir" ]]; then
      printf '%s\n' "$dir"
      return
    fi
  done

  printf '%s\n' "$HOME/.local/bin"
}

if [[ -z "$bin_dir" ]]; then
  bin_dir="$(choose_bin_dir)"
fi

need node
need npm

if [[ -f package.json && -d src && -d bin ]]; then
  src_dir="$PWD"
else
  work_dir="$(mktemp -d)"
  trap '[[ -n "$work_dir" ]] && rm -rf "$work_dir"' EXIT
  src_dir="$work_dir/relaymux"
  mkdir -p "$src_dir"

  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    curl -fsSL "$tarball_url" | tar -xz --strip-components 1 -C "$src_dir"
  else
    need git
    git clone --depth 1 --branch "$ref" "$repo_url" "$src_dir" >/dev/null
  fi
fi

cd "$src_dir"
npm ci
npm run build

rm -rf "$install_dir"
mkdir -p "$install_dir" "$bin_dir"
cp -R dist package.json README.md LICENSE examples scripts "$install_dir/"

cat > "$bin_dir/relaymux" <<SHIM
#!/usr/bin/env sh
exec node "$install_dir/dist/bin/relaymux.js" "\$@"
SHIM
chmod +x "$bin_dir/relaymux"

cat <<EOF
relaymux installed to $install_dir
CLI shim written to $bin_dir/relaymux
EOF

if path_has_dir "$bin_dir"; then
  cat <<EOF

Next:
  relaymux --version
EOF
else
  cat <<EOF

Add this to your shell profile, then open a new shell:
  export PATH="$bin_dir:\$PATH"

Next:
  relaymux --version
EOF
fi

cat <<EOF
  relaymux setup
  relaymux status

Background service:
  macOS uses a per-user launchd LaunchAgent.
  Linux uses a systemd user service via: systemctl --user
  Scheduled prompts use cron on Linux when --scheduler auto is selected.

Optional adapters:
  relaymux setup --imsg --chat-id <chat-id-or-phone-number>
  relaymux setup --telegram --telegram-chat-id <chat-id>
EOF
