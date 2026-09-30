#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/bootstrap-docker.sh"

fail() {
  printf '[bootstrap-docker-test] ERROR: %s\n' "$*" >&2
  exit 1
}

make_fake_bin() {
  local dir="$1"
  mkdir -p "$dir"
}

write_fake_docker() {
  local dir="$1"
  local engine="$2"
  local api="$3"
  local os="$4"
  local swarm="$5"

  cat >"$dir/docker" <<EOF
#!/usr/bin/env bash
set -e
if [[ "\$1" == "version" && "\$2" == "--format" ]]; then
  case "\$3" in
    *Server.Version*) printf '%s\\n' "$engine" ;;
    *Server.APIVersion*) printf '%s\\n' "$api" ;;
    *) exit 1 ;;
  esac
elif [[ "\$1" == "info" && "\$2" == "--format" ]]; then
  case "\$3" in
    *OSType*) printf '%s\\n' "$os" ;;
    *Swarm.LocalNodeState*) printf '%s\\n' "$swarm" ;;
    *) exit 1 ;;
  esac
else
  exit 1
fi
EOF
  chmod +x "$dir/docker"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Existing supported Docker validates without package installation.
BIN1="$TMP/bin1"
make_fake_bin "$BIN1"
write_fake_docker "$BIN1" "28.5.1" "1.51" "linux" "inactive"
PATH="$BIN1:/usr/bin:/bin" bash "$SCRIPT" --validate >"$TMP/validate.log"
grep -q 'Docker Engine validation passed' "$TMP/validate.log" ||
  fail "supported Docker validation did not pass"

# Engine below minimum is rejected.
BIN2="$TMP/bin2"
make_fake_bin "$BIN2"
write_fake_docker "$BIN2" "26.1.0" "1.45" "linux" "inactive"
if PATH="$BIN2:/usr/bin:/bin" bash "$SCRIPT" --validate >"$TMP/old.log" 2>&1; then
  fail "old Docker Engine unexpectedly passed validation"
fi
grep -q 'below supported minimum' "$TMP/old.log" ||
  fail "old Docker rejection reason missing"

# Explicit install skips package manager when Docker already exists.
BIN3="$TMP/bin3"
make_fake_bin "$BIN3"
write_fake_docker "$BIN3" "28.5.1" "1.51" "linux" "active"
cat >"$BIN3/apt-get" <<'EOF'
#!/usr/bin/env bash
echo called >>"${DOCKLANE_TEST_APT_LOG}"
exit 99
EOF
chmod +x "$BIN3/apt-get"
DOCKLANE_TEST_APT_LOG="$TMP/apt-existing.log" \
  PATH="$BIN3:/usr/bin:/bin" bash "$SCRIPT" --install >"$TMP/install-existing.log"
[[ ! -f "$TMP/apt-existing.log" ]] ||
  fail "existing Docker triggered package installation"

# Unsupported automatic install fails closed before package mutation.
BIN4="$TMP/bin4"
make_fake_bin "$BIN4"
cat >"$BIN4/id" <<'EOF'
#!/usr/bin/env bash
printf '0\n'
EOF
chmod +x "$BIN4/id"
cat >"$TMP/os-release-unsupported" <<'EOF'
ID=rocky
EOF
if DOCKLANE_BOOTSTRAP_OS_RELEASE="$TMP/os-release-unsupported" \
  DOCKLANE_BOOTSTRAP_DOCKER_BIN=docklane-test-missing-docker \
  PATH="$BIN4:/usr/bin:/bin" bash "$SCRIPT" --install >"$TMP/unsupported.log" 2>&1; then
  fail "unsupported OS automatic install unexpectedly succeeded"
fi
grep -q 'automatic Docker installation is unsupported' "$TMP/unsupported.log" ||
  fail "unsupported OS did not fail closed"

# Debian/Ubuntu install path invokes configured package manager and validates.
BIN5="$TMP/bin5"
make_fake_bin "$BIN5"
cat >"$BIN5/id" <<'EOF'
#!/usr/bin/env bash
printf '0\n'
EOF
chmod +x "$BIN5/id"
cat >"$BIN5/apt-get" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKLANE_TEST_APT_LOG}"
if [[ "$1" == "install" ]]; then
  cp "${DOCKLANE_TEST_DOCKER_TEMPLATE}" "${DOCKLANE_TEST_BIN}/docklane-test-docker"
  chmod +x "${DOCKLANE_TEST_BIN}/docklane-test-docker"
fi
EOF
chmod +x "$BIN5/apt-get"
cat >"$BIN5/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKLANE_TEST_SYSTEMCTL_LOG}"
EOF
chmod +x "$BIN5/systemctl"
cat >"$TMP/docker-template" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "version" && "$2" == "--format" ]]; then
  case "$3" in
    *Server.Version*) echo 28.5.1 ;;
    *Server.APIVersion*) echo 1.51 ;;
  esac
elif [[ "$1" == "info" && "$2" == "--format" ]]; then
  case "$3" in
    *OSType*) echo linux ;;
    *Swarm.LocalNodeState*) echo inactive ;;
  esac
fi
EOF
cat >"$TMP/os-release-debian" <<'EOF'
ID=debian
EOF
DOCKLANE_BOOTSTRAP_OS_RELEASE="$TMP/os-release-debian" \
DOCKLANE_BOOTSTRAP_DOCKER_BIN=docklane-test-docker \
DOCKLANE_TEST_APT_LOG="$TMP/apt.log" \
DOCKLANE_TEST_SYSTEMCTL_LOG="$TMP/systemctl.log" \
DOCKLANE_TEST_DOCKER_TEMPLATE="$TMP/docker-template" \
DOCKLANE_TEST_BIN="$BIN5" \
PATH="$BIN5:/usr/bin:/bin" bash "$SCRIPT" --install >"$TMP/install.log"

grep -qx 'update' "$TMP/apt.log" || fail "apt-get update was not invoked"
grep -qx 'install -y docker.io' "$TMP/apt.log" || fail "docker.io package install was not invoked"
grep -qx 'enable --now docker' "$TMP/systemctl.log" || fail "docker service was not enabled"
grep -q 'Docker Engine validation passed' "$TMP/install.log" ||
  fail "installed Docker was not validated"

printf 'bootstrap Docker validation regression tests: PASS\n'
