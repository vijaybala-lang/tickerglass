#!/usr/bin/env bash
# run-old-shell.sh — part of TickerGlass
# Copyright (C) 2026 Vijay Bala
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# tools/qa/run-old-shell.sh [RELEASE] [--force-build] — certify the
# host-built dist zip on an OLDER gnome-shell in a Fedora container
# (host side). Fedora RELEASE (default 44) is resolved to the GNOME
# it carries (44 -> GNOME 50). The zip must already exist: run
# tools/certify.sh (or tools/package.sh) first — the guest grades
# the host's bytes, never a guest rebuild.
#
# Artifacts land in tools/out/qa-gnome<SHELL>/ (summary.tsv,
# stamps.txt with the tested zip's sha, per-stage logs, guest
# previews). Exit 0 = certified on that shell. A shell-version slot
# in extension/metadata.json is earned here: no green guest cert,
# no slot (release skill step 2).
# Adapted from weatherglass's tools/qa/run-old-shell.sh.
set -uo pipefail
PROJ="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJ" || exit 1

RELEASE="${1:-44}"; FORCE="${2:-}"
SHELL_V=$((RELEASE + 6))                  # fedora N carries gnome N+6
IMAGE=localhost/tg-qa:$RELEASE
LABEL=gnome-$SHELL_V
OUT="$PROJ/tools/out/qa-$LABEL"

UUID=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['uuid'])")
ZIP="$PROJ/dist/$UUID.zip"
[[ -f "$ZIP" ]] || { echo "qa: $ZIP missing -- run tools/certify.sh first (guest certs the host-built bytes)" >&2; exit 1; }
echo "==> zip under test:"
sha256sum "$ZIP"

if [ "$FORCE" = --force-build ] || ! podman image exists "$IMAGE"; then
    echo "==> building $IMAGE (this dnf-installs gnome $SHELL_V; patient)"
    podman build -f tools/qa/fedora.Containerfile --build-arg RELEASE="$RELEASE" \
        -t "$IMAGE" || exit 1
fi

rm -rf "$OUT"; mkdir -p "$OUT"
echo "==> running ladder: $IMAGE as $LABEL -> $OUT"
timeout 3600 podman run --rm \
    --security-opt label=disable --shm-size=2g \
    -v "$PROJ":/src:ro -v "$OUT":/out \
    -e QA_SHELL_LABEL="$LABEL" \
    "$IMAGE" bash /src/tools/qa/run.sh
RC=$?
echo "==> guest exit $RC; artifacts: $OUT"
exit $RC
