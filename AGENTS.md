# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An Omarchy bar widget (Quickshell/QML plugin) that detects installed VPN tools
and switches between them from one bar icon. Read
[ARCHITECTURE.md](ARCHITECTURE.md) before changing anything structural — it
documents the backend contract and the reasoning behind the non-obvious
decisions. [CONTRIBUTING.md](CONTRIBUTING.md) covers workflow.

## Commands

```bash
node tests/run.js                    # the whole suite; CI runs exactly this
omarchy plugin validate .            # after touching manifest.json
```

Run one test file (the runner has no filter flag; `report()` only fires from
`run.js`, so a bare `node tests/model/x.test.js` prints nothing):

```bash
node -e 'const h=require("./tests/harness.js"); require("./tests/model/mullvad.test.js"); process.exit(h.report())'
```

Lint a QML file — one per invocation, and **never** from inside the plugin
directory (qmllint adds the target directory as an implicit import, so
`Panel.qml` resolves to itself and exits 255 with no message):

```bash
cd .. && qmllint -I /usr/share/omarchy/shell jkoestinger.vpn/MullvadBackend.qml
```

Run the widget with its errors visible (the session shell writes to
`/dev/null`):

```bash
while timeout 5 quickshell kill -p /usr/share/omarchy/shell --any-display; do :; done
systemd-run --user --unit=omarchy-shell-debug --collect quickshell -n -p /usr/share/omarchy/shell
journalctl --user -u omarchy-shell-debug -f
systemctl --user stop omarchy-shell-debug && omarchy restart shell   # restore
```

## Architecture in one paragraph

`Panel.qml` knows nothing about any VPN tool: it renders whatever the active
backend exposes. `VpnController.qml` owns the backends, picks the active one,
enforces one-tunnel-at-a-time exclusivity, and fetches the public IP. Each tool
is a **pair** — `<Tool>Backend.qml` for `Process` plumbing and bindings,
`model/<Tool>.js` for all parsing and row-building. The split exists because
`model/` is the only half that runs without a QML engine, and therefore the only
half under test. Anything resembling a decision belongs in the model file.

Adding a tool: `model/Tunnelbear.js`, `tests/model/tunnelbear.test.js`,
`TunnelbearBackend.qml`, two lines in `VpnController.qml` (the `backends` array
and the instantiation), and the `label` added to the `preferredBackend` enum in
`manifest.json` — that last one is static JSON read before any QML runs, so
nothing at runtime can fill it in. If a change also needs edits to `Panel.qml`
or `model/Shared.js`, the backend contract is what should change instead.

## Working rules

- **`model/` changes need `omarchy restart shell`.** QML hot-reloads on save; a
  `.pragma library` script stays cached. Most common reason a change appears to
  have done nothing.
- **`model/*.js` are QML `.pragma library` scripts, not node modules.** `var` and
  `function` declarations, no imports beyond `.import "Shared.js" as Shared`, no
  QML objects, no side effects — pure functions of their arguments. No model file
  may reach into another tool's. Test files are plain node and use modern syntax.
- **Nerd Font glyphs use `String.fromCodePoint`**, never pasted literals —
  editing tools mangle multi-byte sequences in QML.
- **Comments explain why.** Long where the reasoning is unrecoverable from the
  code; when working around a CLI's behaviour, write down what the CLI does.
- **A fixed parser gets the case that broke it**, with real CLI output pasted in
  verbatim rather than tidied.

## Contract rules that were bugs once

- `detect(force)` probes and must **not** fall through to `refresh()` — a hidden
  backend gets `detect()` alone and would otherwise keep polling a tool the user
  switched off.
- A status that cannot be read is **stale, not empty**. Blanking it takes the
  chip away while a tunnel is up, and with it the only way to bring that tunnel
  down; a blank firewall reading also reports "not blocking", which is a lie at
  exactly the wrong moment.
- A backend that blocks traffic while disconnected must say so via
  `lockdownMode` plus a `lockdownHint` naming the command in its own vocabulary.
- Every connect goes through `VpnController.connectVia()` / `toggleActive()` and
  every disconnect through `disconnectActive()` — never straight to a backend —
  so queued actions get cancelled rather than firing seconds later and undoing
  what the user just asked for.

## Commits, branches, releases

Conventional Commits — the changelog and version are generated from them.
`feat:` minor, `fix:` patch, `refactor:`/`docs:`/`perf:` own sections,
`chore:`/`ci:`/`test:` hidden, `feat!:` major. Write the subject as the thing
that changed, not the work done.

Pull requests target **`dev`**, not `main`; `main` is the distribution branch and
moves only at release time. Never hand-edit `CHANGELOG.md` or the version in
`manifest.json` — release-please owns both.
