#!/usr/bin/env bash
# package.sh — part of TickerGlass
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
# tools/package.sh [--fast] — build the release artifacts:
#   dist/<uuid>.zip                      the extensions.gnome.org upload
#   dist/tickerglass-app-v<version>.tar.gz   companion app bundle
#                                        (GitHub release asset)
# Adapted from weatherglass's package.sh (same author, same lessons):
# fails loudly on anything EGO review dislikes — a schema id that
# doesn't match the uuid, non-https url, missing files, a compiled
# schema in the zip, extension.js anywhere but the archive root.
# Without --fast it finishes by proving the zip installs + boots
# (tools/zipcheck.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail() { echo "package: FAIL: $*" >&2; exit 1; }

UUID=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['uuid'])") \
    || fail 'extension/metadata.json unreadable'
SCHEMA=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['settings-schema'])")
VERSION=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['version'])")
[[ "$SCHEMA" == "org.gnome.shell.extensions.${UUID%@*}" ]] \
    || fail "settings-schema '$SCHEMA' does not match uuid '$UUID' (EGO requires org.gnome.shell.extensions.<first uuid part>)"
python3 - <<'EOF' || exit 1
import json, sys
md = json.load(open('extension/metadata.json'))
missing = [k for k in ('uuid', 'name', 'description', 'shell-version',
                       'version', 'url') if k not in md]
if missing:
    sys.exit(f"package: FAIL: metadata.json missing {missing} (EGO validator requires them)")
if not isinstance(md['version'], int):
    sys.exit('package: FAIL: metadata version must be an integer for EGO update diffing')
if not md['url'].startswith('https://'):
    sys.exit('package: FAIL: metadata url must be https')
EOF

command -v zip >/dev/null || fail 'zip not found'

echo "==> build (tools/build.sh assembles dist/$UUID + dist/app)"
tools/build.sh >/dev/null

echo "==> syntax gate (cheapest first: every shipped module parses)"
if ! SYNTAX=$(gjs -m tools/syntax-check.mjs 2>&1); then
    echo "$SYNTAX" >&2
    fail 'syntax check failed'
fi

STAGE=$(mktemp -d /tmp/tg-package.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

echo "==> staging the EGO tree (schema XML only — EGO-P-006)"
mkdir -p "$STAGE/ext"
cp -r "dist/$UUID/." "$STAGE/ext/"
# EGO-P-006: ship XML ONLY. EGO compiles schemas itself (server-side
# at serve time; the Extensions app locally on install), so a shipped
# gschemas.compiled is a review warning. build.sh's compile still ran:
# it validated the XML, its output just doesn't ship here. (Local
# installs keep using the dist tree with the blob via install.sh.)
rm -f "$STAGE/ext/schemas/gschemas.compiled"
cp README.md LICENSE "$STAGE/ext/"

echo "==> sanity checks"
# the EGO page renders from the manifest; ego-upload-notes.md mirrors
# that pitch for humans. Drift between them is how stale copy ships.
python3 - <<'EOF' || fail 'ego-upload-notes.md description mirror drifted from extension/metadata.json (edit the manifest, re-mirror verbatim)'
import json
desc = json.load(open('extension/metadata.json'))['description']
notes = open('ego-upload-notes.md').read()
raise SystemExit(0 if desc in notes else 1)
EOF
if grep -rn "/home/\|/tmp/\|/usr/share" "$STAGE/ext"/*.js \
        | grep -v "gnome-shell"; then
    fail 'absolute paths found in shipped JS'
fi
need=(metadata.json extension.js menu.js prefs.js i18n.js stylesheet.css
      schemas/"$SCHEMA".gschema.xml LICENSE)
for f in "${need[@]}"; do
    [[ -f "$STAGE/ext/$f" ]] || fail "missing $f"
done
# EGO-P-006: a compiled schema in the zip is a review warning, full stop
[[ -f "$STAGE/ext/schemas/gschemas.compiled" ]] \
    && fail 'ships gschemas.compiled (EGO-P-006: 45+ packages compile it themselves)'

echo "==> zipping (flat: extension.js at the archive root — EGO's validator"
echo "    rejects a uuid-folder layout with 'Missing extension.js')"
rm -f "dist/$UUID.zip"
(cd "$STAGE/ext" && zip -qr "$ROOT/dist/$UUID.zip" .)
unzip -l "dist/$UUID.zip" | awk '$4 == "extension.js"' | grep -q . \
    || fail 'zip has extension.js at a nested path — EGO rejects that'
unzip -l "dist/$UUID.zip" | grep -q "gschemas.compiled" \
    && fail 'gschemas.compiled inside the zip (EGO-P-006)'
FILES=$(unzip -l "dist/$UUID.zip" | tail -1 | awk '{print $2}')
echo "done: dist/$UUID.zip  ($(du -h "dist/$UUID.zip" | cut -f1), $FILES files)"
sha256sum "dist/$UUID.zip"

echo "==> app bundle (GitHub release asset; EGO never sees it)"
APPB="tickerglass-app-v$VERSION"
mkdir -p "$STAGE/$APPB/schemas"
cp -r dist/app "$STAGE/$APPB/app"
cp schemas/"$SCHEMA".gschema.xml "$STAGE/$APPB/schemas/"
cp app/APP-INSTALL.md LICENSE "$STAGE/$APPB/"
tar -czf "dist/$APPB.tar.gz" -C "$STAGE" "$APPB"
echo "done: dist/$APPB.tar.gz  ($(du -h "dist/$APPB.tar.gz" | cut -f1))"
sha256sum "dist/$APPB.tar.gz"

if [[ "${1:-}" != "--fast" ]]; then
    # the zip itself must install + boot, not just the directory tree
    echo "==> zipcheck (gnome-extensions install + headless boot + paint)"
    tools/zipcheck.sh
else
    echo "==> zipcheck skipped (--fast) — run tools/zipcheck.sh before uploading"
fi
echo "upload dist/$UUID.zip at https://extensions.gnome.org/upload/"
echo "attach BOTH artifacts to the GitHub release (ritual: skills/tickerglass-release/SKILL.md)"
