#!/usr/bin/env bash
# build.sh — part of TickerGlass
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
# Assemble runnable artifacts from source:
#   dist/tickerglass@vijaybala.dev/   — the GNOME Shell extension
#   dist/app/                         — the GJS desktop app
# The shared/*.js modules are COPIED into each artifact: the shell only
# imports from inside an extension dir, and the app runs from its install
# dir — a tiny copy step buys zero-dependency installs on both sides.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="tickerglass@vijaybala.dev"
EXT="$ROOT/dist/$UUID"
APP="$ROOT/dist/app"

rm -rf "$ROOT/dist"
mkdir -p "$EXT/schemas" "$APP"

# extension
cp "$ROOT"/extension/{metadata.json,extension.js,menu.js,prefs.js,i18n.js,stylesheet.css} "$EXT/"
cp "$ROOT"/shared/{fmt.js,mock.js,yahoo.js,spark.js,prompt.js,fetch.js,cache.js} "$EXT/"
cp "$ROOT"/schemas/org.gnome.shell.extensions.tickerglass.gschema.xml "$EXT/schemas/"
glib-compile-schemas "$EXT/schemas"

# app (schema lives user-level; see install.sh step 3)
cp "$ROOT"/app/{main.js,window.js,style.css,night.css} "$APP/"
cp "$ROOT"/shared/{fmt.js,mock.js,yahoo.js,spark.js,prompt.js,fetch.js,cache.js} "$APP/"
cp "$ROOT"/app/dev.vijaybala.TickerGlass.desktop "$APP/"
# custom symbolic icons (hicolor tree, added to the theme search path)
cp -r "$ROOT"/app/icons "$APP/icons"

echo "built: $EXT"
echo "built: $APP"
