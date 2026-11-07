#!/usr/bin/env bash
# shexli-check.sh — part of TickerGlass
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
# tools/shexli-check.sh — run EGO's own static analyzer over the dist
# zip. extensions.gnome.org reviews every upload with the `shexli`
# engine. Its exit code is USELESS — it returns 0 whatever it finds —
# so the gate parses summary.status from --format json instead.
# Never trust $?; never ship on a status other than "clean".
#
# Host-gated: no engine -> loud SKIP (exit 0), never a fake PASS
# pretending analysis ran. A SKIP is NOT a pass for upload purposes:
# install the engine before submitting (release skill step 2/8).
#
# Engine (Linux binary, same one the review bot ships):
#   curl -sL -o /tmp/shexli.vsix https://github.com/NiffirgkcaJ/shexli-gnome-extension/releases/download/v0.2.0/shexli-gnome-extension-0.2.0.vsix
#   unzip -o /tmp/shexli.vsix -d /tmp/shexli-x 'extension/*'
#   mkdir -p ~/.local/share/shexli && install -m755 \
#     /tmp/shexli-x/extension/vscode-extensions/extension/resources/bin/shexli \
#     ~/.local/share/shexli/shexli
# Or point TG_SHEXLI at any engine binary.
# (Ported from weatherglass's shexli-check.sh.)
#
# ONE narrow exemption, EGO-M-004 (shell-version plausibility): the
# public engine (v0.2.0, spec 2026-04-02 — still the latest upstream
# as of 2026-11, sha-verified) predates GNOME 51 stable, so its
# version table calls a certified 50+51 list implausible. The gate
# below exempts that single rule ONLY when every claimed major is
# numeric and <= this host's shell major (i.e. we claim nothing
# newer than what runs here; each slot is separately certified —
# release skill step 2). The exemption prints loudly every run and
# self-retires the day an updated engine stops filing it. Any other
# finding still fails. Standing answer: ego-upload-notes.md.
set -u
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
UUID=$(python3 -c "import json;print(json.load(open('$PROJ/extension/metadata.json'))['uuid'])")
ZIP="$PROJ/dist/$UUID.zip"
[[ -f "$ZIP" ]] || { echo "shexli: dist zip missing -- run tools/package.sh first" >&2; exit 1; }

BIN="${TG_SHEXLI:-}"
if [[ -z "$BIN" ]]; then
    for c in shexli "$HOME/.local/share/shexli/shexli"; do
        if command -v "$c" >/dev/null 2>&1; then BIN="$(command -v "$c")"; break; fi
        [[ -x "$c" ]] && { BIN="$c"; break; }
    done
fi
if [[ -z "$BIN" ]]; then
    echo "shexli: engine not found -- SKIP (analysis NOT performed; set TG_SHEXLI or"
    echo "        install per the header -- the reviewer WILL run it)"
    exit 0
fi

mkdir -p /tmp/opencode
HOST_MAJOR=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
OUT="$(mktemp /tmp/opencode/shexli-XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT
"$BIN" --format json "$ZIP" >"$OUT" 2>/dev/null
if [[ ! -s "$OUT" ]]; then
    echo "shexli: engine produced no analysis -- FAIL (cannot certify blind)" >&2
    exit 1
fi
if HOST_MAJOR="${HOST_MAJOR:-}" python3 - "$OUT" "$PROJ/extension/metadata.json" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
s = d.get('summary', {})
findings = d.get('findings', [])

def m004_exempt(f):
    """Stale-spec exemption (see header): EGO-M-004 only, and only
    when every claimed shell major is numeric and no newer than
    the shell running on this host."""
    if f.get('rule_id') != 'EGO-M-004':
        return False
    host = os.environ.get('HOST_MAJOR', '')
    if not host.isdigit():
        return False
    try:
        versions = json.load(open(sys.argv[2]))['shell-version']
    except Exception:
        return False
    return bool(versions) and all(
        str(v).isdigit() and int(v) <= int(host) for v in versions)

exempt = [f for f in findings if m004_exempt(f)]
real = [f for f in findings if f not in exempt]
for f in exempt:
    print(f'shexli: EXEMPT (stale engine spec {d.get("spec_version", "?")}, '
          f'host shell {os.environ.get("HOST_MAJOR")}): '
          f'{f.get("rule_id")} {f.get("title")}')
if not real:
    print(f'shexli: clean ({len(exempt)} exempt, spec {d.get("spec_version", "?")})')
    sys.exit(0)
print(f'shexli: {len(real)} finding(s), status={s.get("status")}')
for f in real:
    print(f'  {f.get("rule_id")} [{f.get("severity")}] {f.get("title")}')
    for e in f.get('evidence', [])[:4]:
        print(f'      {e.get("path", "").split(":")[-1]}:{e.get("line")}  {e.get("snippet", "")[:70]}')
sys.exit(1)
PY
then exit 0; else
    echo "shexli: the EGO reviewer will file these verbatim -- fix or escalate" >&2
    exit 1
fi
