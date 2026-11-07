#!/usr/bin/env bash
# zipcheck.sh — part of TickerGlass
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
# tools/zipcheck.sh — end-to-end proof that the built zip installs
# and runs. Installs dist/<uuid>.zip via `gnome-extensions install`
# (the same path the Extensions app / EGO take, which validates the
# zip layout + metadata and compiles the shipped schema XML), boots
# a headless nested gnome-shell with only that extension + the
# icontest probe, and waits for the full card-paint cycle.
# Demo data source, so no network. Exit 0 = the zip is good to upload.
# (tools/shellcheck.sh is the dev-loop twin over the dist DIRECTORY;
# this one proves the actual upload artifact. Adapted from
# weatherglass's zipcheck.sh.)
set -u
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
UUID=$(python3 -c "import json;print(json.load(open('$PROJ/extension/metadata.json'))['uuid'])")
ZIP="$PROJ/dist/$UUID.zip"
H=/tmp/opencode/tg-zipcheck-home
LOG=/tmp/opencode/tg-zipcheck.log
SCHEMA=org.gnome.shell.extensions.tickerglass

[[ -f "$ZIP" ]] || { echo "zipcheck: run tools/package.sh first" >&2; exit 1; }

rm -rf "$H"; mkdir -p "$H/.local/share/gnome-shell/extensions"
# schemas for the gsettings CLI only — the shell loads the compiled
# ones inside the extension itself, exactly like a real install
mkdir -p "$H/.local/share/glib-2.0/schemas"
cp "$PROJ/schemas/"*.xml "$H/.local/share/glib-2.0/schemas/"
glib-compile-schemas "$H/.local/share/glib-2.0/schemas"
cp -r "$PROJ/tools/icontest@vijaybala.dev" "$H/.local/share/gnome-shell/extensions/"

export HOME="$H" XDG_DATA_DIRS=/usr/share
unset WAYLAND_DISPLAY DISPLAY
export G_MESSAGES_DEBUG=all

timeout 300 dbus-run-session -- bash -c "
  echo '=== install from zip (validates layout + metadata) ==='
  gnome-extensions install '$ZIP' || { echo 'FAIL: zip rejected on install'; exit 1; }
  [[ -f \"\$HOME/.local/share/gnome-shell/extensions/$UUID/extension.js\" ]] \
      || { echo 'FAIL: not extracted under the uuid dir'; exit 1; }
  # xml-only schemas ship (EGO-P-006): the installer MUST compile them
  [[ -f \"\$HOME/.local/share/gnome-shell/extensions/$UUID/schemas/gschemas.compiled\" ]] \
      || { echo 'FAIL: installer did not compile the shipped schema xml'; exit 1; }
  gsettings set org.gnome.shell enabled-extensions '[\"$UUID\", \"icontest@vijaybala.dev\"]'
  gsettings set $SCHEMA data-source 'demo'
  gsettings set $SCHEMA refresh-seconds 15
  gnome-shell --headless --virtual-monitor 1280x800 --no-x11 &
  GPID=\$!
  for i in \$(seq 1 40); do
    sleep 2
    busctl --user --no-pager tree org.gnome.Shell >/dev/null 2>&1 || { kill -0 \$GPID || exit 1; continue; }
    # bus is up; now wait for the FULL paint cycle (icontest's 8 popup
    # toggles) instead of a fixed sleep — data latency moves the
    # card-build by seconds and a fixed window clips it
    for j in \$(seq 1 60); do
      sleep 2
      grep -q 'icontest: DONE' '$LOG' 2>/dev/null && { kill \$GPID; exit 0; }
      kill -0 \$GPID 2>/dev/null || { echo 'FAIL: shell died with the zip-installed extension'; exit 1; }
    done
    echo 'FAIL: icontest never finished'
    kill \$GPID; exit 1
  done
  kill \$GPID; exit 1
" >"$LOG" 2>&1
RC=$?

echo "--- verdict ---"
ERRPAT="JS ERROR|Extension [^:]+: Error:|TickerGlass.*logError|\[ERROR\]|CRITICAL|assertion"
ERRS=$(grep -cE "$ERRPAT" "$LOG" || true)
# Container guests log a few environmental lines that match the gate
# but are not extension code (e.g. the fake system bus has no
# login1 owner). tools/qa/run.sh names them EXACTLY, by substring,
# in TG_ZIPCHECK_ALLOW (ERE); host runs leave it unset = zero
# tolerance. Allowlisted lines are printed, never hidden.
if [[ -n "${TG_ZIPCHECK_ALLOW:-}" ]]; then
    ALLOWED=$(grep -E "$ERRPAT" "$LOG" | grep -cE "$TG_ZIPCHECK_ALLOW" || true)
    [[ "$ALLOWED" =~ ^[0-9]+$ ]] || ALLOWED=0
    if [[ "$ALLOWED" -gt 0 ]]; then
        echo "zipcheck: $ALLOWED allowlisted environmental line(s) (TG_ZIPCHECK_ALLOW):"
        grep -E "$ERRPAT" "$LOG" | grep -E "$TG_ZIPCHECK_ALLOW" | head -3
        ERRS=$((ERRS - ALLOWED))
    fi
fi
RUNS=$(grep -c "TickerGlass v" "$LOG")
DONE=$(grep -c "icontest: DONE" "$LOG")
DATA=$(grep -Eo "rows=[0-9]+ quotes=[0-9]+ heroHist=[^ ]+ panelPrice='[^']*'" "$LOG" | tail -1)
[[ $RC == 0 ]] || { echo "zipcheck: FAIL (boot run rc=$RC, see $LOG)"; exit 1; }
[[ $RUNS -ge 1 ]] || echo "zipcheck: note: 'TickerGlass v…' banner missing"
[[ $DONE == 1 ]] || { echo "zipcheck: FAIL: card never painted"; exit 1; }
[[ $ERRS == 0 ]] || { echo "zipcheck: FAIL: $ERRS error-gate lines in $LOG"; tail -40 "$LOG"; exit 1; }
echo "zipcheck: PASS — $ZIP installs, boots, paints ($ERRS errors)"
echo "  data: $DATA"
