#!/usr/bin/env bash
# tools/shellcheck.sh — end-to-end proof that the built extension runs:
# boots a headless nested gnome-shell (GNOME 50: --headless --virtual-monitor
# --no-x11) in a clean HOME with ONLY tickerglass + the icontest probe,
# toggles the card open/closed, and greps the journal for trouble.
# Demo data source, so no network. Exit 0 = extension is good.
set -u
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
UUID="tickerglass@vijaybala.dev"
H=/tmp/opencode/tg-shellcheck-home
LOG=/tmp/opencode/tg-shellcheck.log
SCHEMA=org.gnome.shell.extensions.tickerglass

"$PROJ/tools/build.sh" >/dev/null || exit 1

rm -rf "$H"; mkdir -p "$H/.local/share/gnome-shell/extensions"
mkdir -p "$H/.local/share/glib-2.0/schemas"
cp "$PROJ/schemas/"*.xml "$H/.local/share/glib-2.0/schemas/"
glib-compile-schemas "$H/.local/share/glib-2.0/schemas"
cp -r "$PROJ/dist/$UUID" "$H/.local/share/gnome-shell/extensions/"
cp -r "$PROJ/tools/icontest@vijaybala.dev" "$H/.local/share/gnome-shell/extensions/"

export HOME="$H" XDG_DATA_DIRS=/usr/share
unset WAYLAND_DISPLAY DISPLAY
export G_MESSAGES_DEBUG=all

timeout 180 dbus-run-session -- bash -c "
  gsettings set org.gnome.shell enabled-extensions '[\"$UUID\", \"icontest@vijaybala.dev\"]'
  gsettings set $SCHEMA data-source 'demo'
  gsettings set $SCHEMA refresh-seconds 15
  gnome-shell --headless --virtual-monitor 1280x800 --no-x11 &
  GPID=\$!
  for i in \$(seq 1 60); do
    sleep 2
    kill -0 \$GPID 2>/dev/null || { echo 'FAIL: shell died'; exit 1; }
    if busctl --user --no-pager tree org.gnome.Shell >/dev/null 2>&1; then
      sleep 18
      kill -0 \$GPID 2>/dev/null || { echo 'FAIL: shell died with extension'; exit 1; }
      kill \$GPID; exit 0
    fi
  done
  kill \$GPID; exit 1
" >"$LOG" 2>&1
RC=$?

echo "--- verdict ---"
ERRS=$(grep -cE "JS ERROR|TickerGlass.*logError|\[ERROR\]|CRITICAL|assertion" "$LOG")
RUNS=$(grep -c "TickerGlass v" "$LOG")
DONE=$(grep -c "icontest: DONE" "$LOG")
DATA=$(grep -Eo "rows=[0-9]+ quotes=[0-9]+ heroHist=[^ ]+ panelPrice='[^']*'" "$LOG" | tail -1)
[[ $RC == 0 ]] || { echo "shellcheck: FAIL (boot run rc=$RC, see $LOG)"; exit 1; }
[[ $RUNS -ge 1 ]] || echo "shellcheck: note: 'TickerGlass v…' banner missing"
[[ $DONE == 1 ]] || { echo "shellcheck: FAIL: card never painted"; exit 1; }
[[ $ERRS == 0 ]] || { echo "shellcheck: FAIL: $ERRS error-gate lines in $LOG"; tail -40 "$LOG"; exit 1; }
echo "shellcheck: PASS — boots, paints, survives $DONE toggle cycles ($ERRS errors)"
echo "  data: $DATA"
