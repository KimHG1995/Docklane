#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# == 2 ]] || { echo 'usage: build-cold-recovery.sh MOBY_CHECKOUT OUTPUT' >&2; exit 2; }
MOBY="$(cd "$1" && pwd)"
OUT="$2"
PIN=89c5e8fd66634b6128fc4c0e6f1236e2540e46e0
[[ "$(git -C "$MOBY" rev-parse HEAD)" == "$PIN" ]] || { echo 'unexpected Moby source revision' >&2; exit 1; }
[[ "$MOBY" == */src/github.com/docker/docker && "$OUT" == /* ]] || { echo 'absolute GOPATH checkout/output required' >&2; exit 1; }
[[ -d "$MOBY/vendor/github.com/moby/swarmkit/v2/node" ]] || exit 1
DEST="$MOBY/cmd/docklane-cold-recovery"
[[ ! -e "$DEST" ]] || { echo 'build destination already exists' >&2; exit 1; }
mkdir "$DEST"
cp "$ROOT"/tests/operational-readiness/cold-recovery/*.go "$DEST/"
export GOPATH="${MOBY%/src/github.com/docker/docker}" GO111MODULE=off CGO_ENABLED=0
cd "$MOBY"
test -z "$(gofmt -l "$DEST")"
go test ./cmd/docklane-cold-recovery
go vet ./cmd/docklane-cold-recovery
go build -o "$OUT" ./cmd/docklane-cold-recovery
test -x "$OUT"
