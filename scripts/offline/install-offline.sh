#!/usr/bin/env bash
set -Eeuo pipefail

bundle=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec bash "$bundle/install.sh" "$@" --offline-dir "$bundle"
