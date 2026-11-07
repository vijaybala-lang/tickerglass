#!/usr/bin/env bash
# run.sh — part of TickerGlass
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
# tools/qa/run.sh — certify the CURRENT build against an OLDER
# gnome-shell in a Fedora container (guest side; run inside the
# container by tools/qa/run-old-shell.sh).
#
#   /src  = repo, READ-ONLY bind (the dist zip is graded exactly as
#           built on the host — same bytes we will upload to EGO;
#           its sha is stamped below and in the host's release notes)
#   /out  = rw artifact dir (summary.tsv, stamps.txt, logs, previews)
#
# Ladder (mirrors tools/certify.sh, graded for FOREIGN-SHELL duties):
#   tier 1  pure-gjs property locks on THIS shell's GJS/cairo/pango:
#           syntax, imports, painter previews render.
#   tier 2  zipcheck: gnome-extensions install of the host dist zip
#           + headless boot + icontest popup toggles on this shell;
#           verdict must be PASS (zipcheck already gates on zero
#           error lines; the scan below records the count again).
#   scan    zero "JS ERROR" across the nested-shell log.
# There is no pixel grading here: tickerglass has no blessed goldens
# yet, and rendered truth can't cross raster stacks anyway. The
# guest-rendered preview PNGs bank in /out/previews for human eyes —
# drift is reported by looking, never auto-passed. (When goldens
# exist, grade foreign shells STRUCTURALLY like weatherglass does.)
# Adapted from weatherglass's tools/qa/run.sh.
set -u
WORK=/work
rm -rf "$WORK"; cp -r /src "$WORK"; cd "$WORK" || exit 1
chmod -R u+w "$WORK"
mkdir -p /tmp/opencode /tmp/qa-home /out/previews
export HOME=/tmp/qa-home

UUID=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['uuid'])")
LABEL="${QA_SHELL_LABEL:-foreign}"
STAMPS=/out/stamps.txt
: > "$STAMPS"
gnome-shell --version                      >>"$STAMPS" 2>&1
gjs --version                              >>"$STAMPS" 2>&1
python3 -V                                 >>"$STAMPS" 2>&1
grep PRETTY_NAME /etc/os-release           >>"$STAMPS" 2>&1
echo "zip under test: dist/$UUID.zip"      >>"$STAMPS"
sha256sum "dist/$UUID.zip"                 >>"$STAMPS" 2>&1
echo "qa: guest identity ($LABEL): $(tr '\n' '|' < "$STAMPS")"

# Foreign shells die young without a system bus (see the bootstrap file)
. "$(dirname "$0")/system-bus-bootstrap.sh"

# Containers ship no writable /tmp/.X11-unix; some shells treat a
# failed Xwayland start as fatal even with --no-x11. Cheap insurance.
mkdir -p -m 1777 /tmp/.X11-unix

SUM=/out/summary.tsv
: > "$SUM"
OVERALL=0
stage() {   # stage NAME cmd...
    local name="$1"; shift
    local t0=$SECONDS rc=0
    "$@" >"/out/log-$name.txt" 2>&1 || rc=$?
    printf '%s\t%s\t%ss\n' "$name" "$([ $rc -eq 0 ] && echo PASS || echo "rc=$rc")" \
        "$((SECONDS - t0))" >> "$SUM"
    [ $rc -ne 0 ] && OVERALL=1
    echo "==> $name: $([ $rc -eq 0 ] && echo PASS || echo "rc=$rc") ($((SECONDS - t0))s)"
    [ $rc -ne 0 ] && tail -20 "/out/log-$name.txt"
}

# ---------- tier 1: shell-free property locks on foreign GJS ----------
stage t1.syntax   gjs -m tools/syntax-check.mjs
stage t1.imports  env XDG_CACHE_HOME=/tmp/tg-guest-cache gjs -m tools/imports-check.mjs
stage t1.previews gjs -m tools/preview.mjs
cp -r /tmp/tickerglass-preview/. /out/previews/ 2>/dev/null || true

# ---------- tier 2: the real zip in the real foreign shell ----------
# Environmental, not extension code: the bootstrap's fake system bus
# has no login1 owner, and the shell logs that once as CRITICAL
# ("Could not get a proxy for user 0: ... org.freedesktop.login1 was
# not provided"). Named exactly so nothing else slips through.
export TG_ZIPCHECK_ALLOW='org\.freedesktop\.login1 was not provided'
stage t2.zipcheck bash tools/zipcheck.sh
cp /tmp/opencode/tg-zipcheck.log /out/log-t2.nested.txt 2>/dev/null || true

# ---------- scan: zero JS exceptions in the nested-shell log ----------
ERRS=$(grep -c "JS ERROR" /tmp/opencode/tg-zipcheck.log 2>/dev/null || true)
[[ "$ERRS" =~ ^[0-9]+$ ]] || ERRS="?"
printf 'scan.js-errors\t%s\t-\n' "$([ "$ERRS" = 0 ] && echo PASS || echo "FAIL($ERRS)")" >> "$SUM"
[ "$ERRS" = 0 ] || OVERALL=1
echo "==> JS ERROR count in zipcheck log: $ERRS"

echo
echo "| stage | result | time |"
echo "|---|---|---|"
while IFS=$'\t' read -r n r t; do echo "| $n | $r | $t |"; done < "$SUM"
if [ "$OVERALL" -eq 0 ]; then
    echo "qa: CERTIFIED on $LABEL"
else
    echo "qa: NOT CERTIFIED on $LABEL"
fi
exit "$OVERALL"
