#!/usr/bin/env bash
set -Eeuo pipefail

MIN_ENGINE_VERSION="${DOCKLANE_BOOTSTRAP_MIN_ENGINE_VERSION:-27.5.0}"
MIN_API_VERSION="${DOCKLANE_BOOTSTRAP_MIN_API_VERSION:-1.47}"
OS_RELEASE="${DOCKLANE_BOOTSTRAP_OS_RELEASE:-/etc/os-release}"
DOCKER_BIN="${DOCKLANE_BOOTSTRAP_DOCKER_BIN:-docker}"
MODE="validate"

log() {
  printf '[docklane-bootstrap] %s\n' "$*"
}

fail() {
  printf '[docklane-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bootstrap-docker.sh [--validate|--install]

--validate  Verify an existing Docker Engine installation (default).
--install   Install Docker from the configured Debian/Ubuntu package repository
            only when Docker is not already installed, then validate it.
EOF
}

version_ge() {
  local actual="$1"
  local minimum="$2"
  [[ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n1)" == "$minimum" ]]
}

require_linux() {
  [[ "$(uname -s)" == "Linux" ]] || fail "Docker bootstrap currently supports Linux hosts only"
}

docker_exists() {
  command -v "$DOCKER_BIN" >/dev/null 2>&1
}

validate_docker() {
  docker_exists || fail "Docker CLI is not installed; rerun with --install on a supported host or install Docker manually"

  local server_version api_version server_os
  server_version="$("$DOCKER_BIN" version --format '{{.Server.Version}}' 2>/dev/null || true)"
  api_version="$("$DOCKER_BIN" version --format '{{.Server.APIVersion}}' 2>/dev/null || true)"
  server_os="$("$DOCKER_BIN" info --format '{{.OSType}}' 2>/dev/null || true)"

  [[ -n "$server_version" ]] || fail "Docker daemon is not reachable"
  [[ -n "$api_version" ]] || fail "Docker daemon did not report an API version"
  [[ "$server_os" == "linux" ]] || fail "Docker daemon must report Linux OSType, got '${server_os:-unknown}'"

  version_ge "$server_version" "$MIN_ENGINE_VERSION" ||
    fail "Docker Engine $server_version is below supported minimum $MIN_ENGINE_VERSION"
  version_ge "$api_version" "$MIN_API_VERSION" ||
    fail "Docker API $api_version is below supported minimum $MIN_API_VERSION"

  local swarm_state
  swarm_state="$("$DOCKER_BIN" info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ -n "$swarm_state" ]] || fail "Docker daemon did not report Swarm state"

  log "Docker Engine validation passed"
  log "engine_version=$server_version api_version=$api_version swarm_state=$swarm_state"
}

load_os_release() {
  [[ -r "$OS_RELEASE" ]] || fail "cannot read OS release metadata: $OS_RELEASE"
  # shellcheck disable=SC1090
  source "$OS_RELEASE"
}

install_docker() {
  if docker_exists; then
    log "Docker is already installed; skipping package installation"
    return 0
  fi

  [[ "$(id -u)" == "0" ]] || fail "--install requires root privileges"
  load_os_release

  case "${ID:-}" in
    ubuntu|debian)
      command -v apt-get >/dev/null 2>&1 || fail "apt-get is required for automatic Docker installation"
      log "Installing Docker from the configured ${ID} package repositories"
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
      ;;
    *)
      fail "automatic Docker installation is unsupported for OS '${ID:-unknown}'; install Docker manually and rerun --validate"
      ;;
  esac

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  fi
}

while (($#)); do
  case "$1" in
    --validate)
      MODE="validate"
      ;;
    --install)
      MODE="install"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

require_linux

if [[ "$MODE" == "install" ]]; then
  install_docker
fi

validate_docker
