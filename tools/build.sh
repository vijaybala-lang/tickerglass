#!/usr/bin/env bash
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
cp "$ROOT"/shared/{fmt.js,mock.js,yahoo.js,spark.js,prompt.js} "$EXT/"
cp "$ROOT"/schemas/org.gnome.shell.extensions.tickerglass.gschema.xml "$EXT/schemas/"
glib-compile-schemas "$EXT/schemas"

# app (schema lives user-level; see install.sh step 3)
cp "$ROOT"/app/{main.js,window.js,style.css} "$APP/"
cp "$ROOT"/shared/{fmt.js,mock.js,yahoo.js,spark.js,prompt.js} "$APP/"
cp "$ROOT"/app/dev.vijaybala.TickerGlass.desktop "$APP/"

echo "built: $EXT"
echo "built: $APP"
