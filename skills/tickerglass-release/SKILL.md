---
name: tickerglass-release
description: Ship a TickerGlass release to extensions.gnome.org (EGO) -- version bump, host + older-shell guest certification, GitHub release upkeep (draft, extension zip + companion app bundle assets, publish), README link bump, live-session verification, screenshot captures, zip upload and its sha record, and post-approval hygiene. Use whenever any TickerGlass release or version is prepared, bumped, cut, uploaded, or wrapped up -- "prep for the next release", "ready to upload?", "bump to vN", "update the release list".
---

# TickerGlass release ritual

Every concrete release command lives in this file and nowhere else.
That is a bug lesson, not a style rule (inherited from
weatherglass, where one install step lived in two files and both
copies went stale): principles stay prose, commands stay here.

| File | Role |
|------|------|
| `skills/tickerglass-release/SKILL.md` (here) | every command, in order |
| `tools/DEVELOPMENT.md` § Pre-upload release review | the semantic principles (justify hunks, dead-code sweep, best-practices audit) — prose only |
| `ego-upload-notes.md` | EGO-page material: manifest description mirror (verbatim, build-locked), capture order, standing reviewer answers |

The GitHub release is **part of the release**, not a footnote: the
release is not cut until the tag, both assets (extension zip +
companion app bundle), the recorded shas and the README links all
agree. Steps 3 and 7 exist so the list can never rot behind EGO
(weatherglass v7 shipped to EGO with no GitHub release and a
manifest link pointing at a nonexistent tag).

TickerGlass is two artifacts under one version integer: the shell
extension (the EGO zip) and the companion GTK app (a tarball on
the GitHub release). One integer, one tag, one certify — the
app bundle is built by the same `tools/package.sh` run.

## The ritual

Work in a fresh worktree off `master`; never release from the main
checkout. (Git identity is already the noreply one in repo config;
no `--author` override needed.)

### 0. Pre-upload release review (principles: tools/DEVELOPMENT.md)

Audit the scope BETWEEN TAGS — everything shipping is exactly the
diff since the last release, so the best-practices validation runs
over precisely that file set (the token rules are machine-enforced
inside certify by `tools/syntax-check.mjs` + the shexli stage; this
is the semantic half no regex can see). For the first release
there is no previous tag: the audit set is the whole shipping
surface (`extension/`, `shared/`, `schemas/`).

```sh
PREV=$(git tag --sort=-v:refname | head -1)
git diff "$PREV..master" --stat
git diff --name-only "$PREV..master"          # the audit file set
git diff "$PREV..master"                       # read every hunk
```

Then validate every changed file against the EGO review
guidelines and best-practices doc (our distilled copy lives in
the weatherglass repo: BEST-PRACTICES.md) by name, file by file:
lifecycle cleanup (destroy what you create), process isolation,
modern GJS idioms, clean-code rules, settings + metadata hygiene,
and ZIP contents. Findings are fixed in this same pass; anything
where a rule contradicts how this extension provably works gets a
reviewer-facing comment + a standing answer, not silent ignorance.

Every user-visible fix in that diff should trace to a named
regression lock (an assert in `tools/imports-check.mjs`, a static
guard in `tools/syntax-check.mjs`, or the nested-shell paint
gates). A shipped fix with no lock is a gap to close before
release, not after the next regression.

### 1. Version bump

`extension/metadata.json` version goes up by exactly one — the
integer identifies the release to humans and the repo (EGO's page
numbers are its own upload serials and its served metadata is
re-stamped with them, so a number on the review page proves
nothing about our integer; see ego-upload-notes.md). The integer
lives inside the zip AND names the app bundle
(`tickerglass-app-vN.tar.gz`), so the bump precedes the final
build. v1 ships as integer 1: never uploaded before, nothing to
bump from.

**Addressing reviewer comments or findings does NOT bump the
version.** A review round — needs-work returned, or comments
arriving while still in review — is answered with the SAME
version integer, even when the fix changes code, re-certifies,
rebuilds the zip, and lands a fresh sha in the release body. The
integer identifies the RELEASE to EGO (bumping strands the
flagged build in the queue and opens a number that was never
reviewed); the sha identifies the BUILD. New bytes are normal
mid-review — a new number is not. The only time to bump is a
genuinely new release: EGO approved N, the next submission is N+1.

**A shexli-clean build is not a reviewer-approved build.**
Reviewers also judge mechanism (weatherglass was rejected once on
a lifecycle idiom its own fix had chosen; the reviewer prescribed
the shape and that shape shipped). Ship the shape they name,
encode the preference as a syntax-check guard so no future round
relearns it, and merge the answer branch the moment review runs
it — master must always build the zip under review.

### 2. Certify the release commit itself

```sh
bash tools/certify.sh        # must end: CERTIFIED: all stages green
sha256sum dist/tickerglass@vijaybala.dev.zip dist/tickerglass-app-vN.tar.gz
bash tools/qa/run-old-shell.sh 44   # certify the OLDEST shell in metadata
                                    # shell-version; repeat per older major
                                    # (Fedora N houses GNOME N+6)
```

`CERTIFIED` is the suite standing at attention on the release
commit: syntax + module graph + St-API guards, imports +
formatter/demo/cache behavioural smokes, painter previews render,
the real zip installed the EGO way into a clean HOME and booted
in a nested shell through the card-paint gate, and finally the
EGO review engine itself — shexli over the real zip
(`tools/shexli-check.sh`; host-gated SKIP if the engine binary is
absent, which is NOT a pass for step 8 purposes — install it per
that script's header and run it green; its one stale-spec
EGO-M-004 exemption is documented there and in the standing
answers). The shas go into the release body at step 3. Any
rebuild re-runs certify and the guest certs.

**The older-shell certs.** Host certify attests exactly one
shell: the dev box's. Every *older* major declared in
`shell-version` owes its own green cert on the SAME zip bytes:
`tools/qa/run-old-shell.sh <fedora-release>` runs the ladder in a
podman guest of that Fedora (syntax/imports/previews on the
foreign GJS, the zip installed + booted + painted on the foreign
shell, zero JS errors; guest-rendered previews bank under
`tools/out/qa-gnome<SHELL>/` for human eyes — pixels are reported,
never graded across raster stacks). A version wins its
`shell-version` slot by certing, and LOSES it the moment keeping
it alive would cost version-branched code — drop-over-branch.
The icontest companion in `tools/` must stay unlocked to every
certified shell too: a stale single-major pin makes older shells
silently decline to load it, turning green pipelines into empty
husks.

**Painter previews are not goldens.** `tools/preview.mjs` proves
the painters run and gives a sheet for human eyes; nothing byte-
diffs them yet. A visual regression can therefore pass certify —
the step-4 live walk is the pixel gate until goldens exist. Do
not describe previews as a lock they are not.

### 3. GitHub release list: draft now, publish at step 6

```sh
cp "dist/tickerglass@vijaybala.dev.zip" /tmp/tickerglass-vN.zip
gh release create vN --draft --target master --title vN --notes "..."
gh release upload vN /tmp/tickerglass-vN.zip "dist/tickerglass-app-vN.tar.gz"
```

Notes must state the honest lineage: if any version shipped to
EGO without a GitHub release, say so in one line rather than
pretending the list is complete. Include both step-2 shas and the
certified shells (host + guest majors). If the tag already exists
as a draft, reuse it (`gh release view vN`).

### 4. Live-session verification (agent installs, operator sees)

The install is mechanical — run it, don't make the operator:

```sh
gnome-extensions install --force dist/tickerglass@vijaybala.dev.zip
```

The zip ships schema XML only (EGO-P-006). `gnome-extensions
install` compiles it (proven on 50/51 by zipcheck's assertion),
and this extension's users also have the user-level schema from
`./install.sh`; compile explicitly anyway so a machine without
either still verifies the artifact as-shipped:

```sh
glib-compile-schemas ~/.local/share/gnome-shell/extensions/tickerglass@vijaybala.dev/schemas
```

Once EGO serves a build of this uuid, the shell's own updater
applies served updates at session start by version comparison
(gnome-software switches do not stop it). From v2 on, a
verification install must raise the INSTALLED metadata version
above the newest served serial (local routing only — the zip
keeps the real integer; check the serial at
https://extensions.gnome.org/api/v1/extensions/ first):

```sh
sed -i 's/"version": N/"version": 99/' ~/.local/share/gnome-shell/extensions/tickerglass@vijaybala.dev/metadata.json
```

Do not rush the load with a runtime toggle: GJS caches modules
per process and toggling races destroy. The operator's share is
exactly one logout/login (announce it) and the surface walk:
panel counts + index-dial mode, movers card in dark and light
themes (one/two column), gear → preferences (add/remove a
symbol), row clicks for each ticker-target (app / Yahoo /
Google), refresh spinner, and the app pairing (extension serving,
app consuming — status line says "shared feed"; then disable the
extension and confirm the app polls itself). The verified zip
must be byte-identical to the uploaded one — never verify a
rebuild and ship a different build.

### 5. Upload imagery: captures from the verified build

The EGO screenshot set and order live in `ego-upload-notes.md`
§ Screenshots. Capture them during the step-4 walk from the
verified build with `data-source` set to `demo` (deterministic
fixture prices; every widget and paint path is the shipped
code), then set the source back. There is no demo video yet and
the manifest carries no video URL — never ship a manifest URL
pointing at an asset that does not exist; if a film mode arrives
later, the invariant from weatherglass applies: the link must
resolve before anyone can click it.

### 6. Publish the release

```sh
gh release edit vN --draft=false
gh release view vN    # assets listed: zip + app tarball
```

Publishing happens after the live walk, never before: the draft
holds the candidate, the published release is the claim that a
human saw it run.

### 7. Bump the README's release links

The README links the latest release (install section) and, after
first approval, the EGO page. Update every version-specific link
to vN in a `docs: point README at vN` commit landed after step
6's publish, so each link is live the moment it merges. This and
step 3 together are "the release list is updated" — don't close
the release until both land.

### 8. Upload

The upload artifact is ONE named file: **the release worktree's**
`dist/tickerglass@vijaybala.dev.zip` — never a bare relative
`dist/` (every tree has one, and a stray rebuild in the main
checkout nearly became "the newest zip" in a weatherglass
resubmit), and never a download from the release page. Prove the
bytes before the browser opens:

```sh
sha256sum <release-worktree>/dist/tickerglass@vijaybala.dev.zip  # must equal the step-2 sha recorded in the release body
```

Any copy whose sha differs: submit nothing until it matches.
Then submit the verified zip at https://extensions.gnome.org/upload/
— the SAME version integer when resubmitting a needs-work round
(EGO latches on the integer; a bump strands the flagged build in
the queue). Standing answers for reviewer questions live in
`ego-upload-notes.md` § Standing answers — use them verbatim
rather than re-explaining. The app tarball is not part of the
upload; if asked, it is the GitHub-release companion described
in the manifest pitch.

### 9. After approval

Keep the manifest `url` pointed at the GitHub repo (EGO requires
it); link the EGO page from the README instead. Record the
outcome (sha, date) in the release body. Next release: N+1.

## When stuck

`certify.sh` output is the authority; `CERTIFIED` or nothing
ships. If a future guide lock fires about file roles, the fix is
always "command back into this skill, prose stays where it is" —
never loosen the lock.
