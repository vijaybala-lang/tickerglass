#!/usr/bin/env bash
# install.sh — part of TickerGlass
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
# Install/upgrade BOTH halves of TickerGlass for the current user:
#   1. the GNOME Shell extension  → ~/.local/share/gnome-shell/extensions
#   2. the desktop app            → ~/.local/share/tickerglass (+ .desktop)
#   3. the shared gsettings schema→ ~/.local/share/glib-2.0/schemas (so the
#      app can read the very same schema the extension ships)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID="tickerglass@vijaybala.dev"
SCHEMA="org.gnome.shell.extensions.tickerglass.gschema.xml"

"$ROOT/tools/build.sh"

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"

# ── schema (user-level, shared by app + extension) ───────────────────────
mkdir -p "$DATA/glib-2.0/schemas"
cp "$ROOT/schemas/$SCHEMA" "$DATA/glib-2.0/schemas/"
glib-compile-schemas "$DATA/glib-2.0/schemas"

# ── extension ────────────────────────────────────────────────────────────
DEST="$DATA/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
if command -v rsync >/dev/null; then
    rsync -a --delete "$ROOT/dist/$UUID/" "$DEST/"
else
    rm -rf "$DEST"; mkdir -p "$DEST"
    cp -r "$ROOT/dist/$UUID/." "$DEST/"
fi

# ── app ──────────────────────────────────────────────────────────────────
APPDEST="$DATA/tickerglass"
mkdir -p "$APPDEST"
cp "$ROOT/dist/app/"* "$APPDEST/"

DESK="$DATA/applications/dev.vijaybala.TickerGlass.desktop"
mkdir -p "$(dirname "$DESK")"
sed "s|@TICKERGLASS_DIR@|$APPDEST|" \
    "$ROOT/app/dev.vijaybala.TickerGlass.desktop" > "$DESK"
command -v update-desktop-database >/dev/null && \
    update-desktop-database "$DATA/applications" || true

# ── icon: generate + install into the user hicolor theme ─────────────────
if command -v gjs >/dev/null; then
    TG_ICON_OUT="$DATA/icons" gjs -m "$ROOT/tools/gen-icon.mjs" >/dev/null \
        || echo "note: icon generation failed (launcher shows a fallback)"
fi

gnome-extensions enable "$UUID" 2>/dev/null || true

echo
echo "Extension → $DEST"
echo "App       → $APPDEST  (launcher: TickerGlass in your app grid)"
echo "Schema    → $DATA/glib-2.0/schemas/$SCHEMA"
echo
echo "Run the app:  gjs -m $APPDEST/main.js"
echo "If the panel sparkline doesn't appear, log out and back in — GNOME 50"
echo "caches extension ES modules inside the shell process."
