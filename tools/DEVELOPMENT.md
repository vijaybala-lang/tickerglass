# Extension development loop (GNOME 50)

## The law: code is imported ONCE per login

GNOME Shell imports an extension's JS modules at session start and
**never re-imports them**, no matter what happens to the files on
disk. Proven three independent ways in one session:

1. `gnome-extensions disable/enable` — `enable()` re-runs (the boot
   log line reprints) with ZERO re-import; the stale module serves
   the old code.
2. A brand-new uuid dropped into the extensions dir + added to
   `enabled-extensions` — the shell never even discovers the folder
   mid-session (its scan is boot-only in this build).
3. Every escape hatch is sealed:
   - `org.gnome.Shell.Eval` → returns `(false, '')`, disabled;
   - `org.gnome.Shell.Extensions.ReloadExtension` → declared on the
     DBus interface but **'not implemented'** in GNOME 50;
   - `InstallRemoteExtension(uuid)` → looks up extensions.gnome.org
     by uuid; no local-path mode.

**Therefore: every extension code change needs a logout/login.**
Deploy early, batch changes, verify with the headless suite first —
see the guard list below; each of these caught a bug that WOULD
otherwise have been discovered at a login screen:

| guard | command | catches |
|---|---|---|
| parse + full-load | `gjs -m tools/syntax-check.mjs` | SyntaxError, and (phase 2) missing named exports between modules — the `Tri` incident |
| paint code | headless cairo probes (see `/tmp/opencode/tri-unit.mjs` pattern) | invalid GJS boxed ctors (`new Pango.Layout(ctx)`), double frees, direction/geometry errors, transform leaks |
| GJS property surface | `strings /usr/lib64/gnome-shell/St-*.typelib \| grep ...` before using an St property | `toggle_style_class_name` (does not exist), `x_fill` (removed in GNOME 50 — passing it in a constructor THROWS and kills render) |
| layout defaults in St-18 | remember: St.Bin/Button lost x_fill and CENTERS its child at natural width — the child must claim `x_align = FILL` itself (screenshot-proved: full-width button, shrunken centered tile) | row content floating as an island in the card |
| app-side | relaunch app, grep stderr | anything |

## Deploy loop

```
./tools/build.sh
cp -r dist/app/*                        ~/.local/share/tickerglass/
cp -r dist/tickerglass@vijaybala.dev/* ~/.local/share/gnome-shell/extensions/tickerglass@vijaybala.dev/
# app: kill and relaunch (own shell command — pkill's pattern must
#      never share a command line with the app's launch string)
# extension: LOG OUT AND BACK IN. No shortcut exists on GNOME 50.
```

## Journal triage

```
journalctl --user -b -o short-iso | grep -i tickerglass | grep -vi weatherglass
```

- `log()` from extension code is g_debug — invisible in the journal;
  use `console.log` for probes (once per import only — enable()
  re-runs without re-importing, so the probe prints once, ever).
- X screenshots cannot capture the top bar (shell composites the
  Wayland side); verify panel widgets via journal + user eyes.
- A render-path throw repeats per fetch/open — the journal shows the
  stack trace with the exact menu.js line; trust it over theory.
- CSS-only changes MAY reach the session without logout: poke the
  theme context (`gsettings set org.gnome.desktop.interface
  gtk-theme Adwaita` and set it back) — the shell reloads registered
  stylesheets. Worth trying before spending a login; the JS half is
  still cached no matter what.

## Known upstream doc gap

gjs.guide's "Port to GNOME 50" page predates the St GTK4-native
property removals (x_fill, toggle_style_class_name...). The
typelib strings dump is ground truth for what St accepts.
