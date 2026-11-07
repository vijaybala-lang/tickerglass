# Installing the TickerGlass app from a release bundle

The bundle (`tickerglass-app-vN.tar.gz`, attached to each GitHub
release) is the companion GTK app from the same release as the shell
extension. No clone needed:

```sh
tar xf tickerglass-app-vN.tar.gz
cd tickerglass-app-vN

# app files
mkdir -p ~/.local/share/tickerglass
cp -r app/* ~/.local/share/tickerglass/

# shared gsettings schema (the app reads the same schema the
# extension ships; at user level so both halves see one contract)
mkdir -p ~/.local/share/glib-2.0/schemas
cp schemas/*.xml ~/.local/share/glib-2.0/schemas/
glib-compile-schemas ~/.local/share/glib-2.0/schemas

# launcher entry (the .desktop template carries a @TICKERGLASS_DIR@
# placeholder that must be substituted with the real install dir)
mkdir -p ~/.local/share/applications
sed "s|@TICKERGLASS_DIR@|$HOME/.local/share/tickerglass|" \
    app/dev.vijaybala.TickerGlass.desktop \
    > ~/.local/share/applications/dev.vijaybala.TickerGlass.desktop
```

Launch "TickerGlass" from the app grid, or run
`gjs -m ~/.local/share/tickerglass/main.js`. The app works on its own;
paired with the extension it consumes the shell's quote rounds over
D-Bus instead of polling twice. The launcher icon may show a fallback
(the generated icon is a from-source `install.sh` extra).

Uninstall: remove `~/.local/share/tickerglass` and the `.desktop`
file above.
