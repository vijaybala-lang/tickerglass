#!/usr/bin/env bash
# certify.sh — part of TickerGlass
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
# tools/certify.sh — full certification run before any EGO upload.
# One command that answers "can this build go to extensions.gnome.org?"
# Stages (fast -> slow, failures counted, every stage reported):
#   1. syntax + module graph + St-API guards (tools/syntax-check.mjs)
#   2. imports + formatter/demo behavioural smoke (tools/imports-check.mjs)
#   3. painter previews render (tools/preview.mjs -> /tmp/tickerglass-preview)
#      NOTE: eyeball PNGs, not byte-locked goldens — tickerglass has no
#      pixel canon yet; the stage proves the painters run clean, a
#      human still reads the sheet. (Weatherglass grades pixels here.)
#   4. package + zipcheck: the REAL zip, installed the EGO way into a
#      clean HOME, booted in a nested shell, card painted
#      (tools/package.sh -> tools/zipcheck.sh)
#   5. shexli: EGO's own review engine over the zip
#      (tools/shexli-check.sh; loud SKIP without the engine — a SKIP
#      is NOT a pass for upload, see the release skill steps 2/8)
#
# Host certify attests the DEV BOX's shell only. Every older major in
# metadata shell-version owes its own guest cert on the same zip
# bytes: tools/qa/run-old-shell.sh (release skill step 2).
#
# Exit 0 == CERTIFIED. Adapted from weatherglass's certify.sh.

set -u
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ" || exit 1
FAILED=0

stage() {
    local name="$1"; shift
    printf '\n=== %s ===\n' "$name"
    if "$@"; then
        printf 'PASS  %s\n' "$name"
    else
        printf 'FAIL  %s\n' "$name"
        FAILED=$((FAILED + 1))
    fi
}

rm -rf /tmp/tg-certify-cache   # scratch cache for the imports disk smoke
stage "syntax"             gjs -m tools/syntax-check.mjs
stage "imports"            env XDG_CACHE_HOME=/tmp/tg-certify-cache gjs -m tools/imports-check.mjs
stage "painter previews"   gjs -m tools/preview.mjs
stage "package + zipcheck" bash tools/package.sh
stage "shexli (EGO engine)" tools/shexli-check.sh

printf '\n────────────────────────────────────────\n'
if [ "$FAILED" -eq 0 ]; then
    printf 'CERTIFIED: all stages green -- safe to upload dist/\n'
    printf 'artifacts: dist/*.zip (EGO), dist/tickerglass-app-*.tar.gz (GitHub asset)\n'
else
    printf 'NOT CERTIFIED: %d stage(s) failed -- do not upload\n' "$FAILED"
fi
exit "$FAILED"
