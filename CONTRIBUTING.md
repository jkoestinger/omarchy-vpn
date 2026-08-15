# Contributing

Another VPN tool, a parser that has gone stale because a CLI changed its output,
a bug in the panel — all welcome. [ARCHITECTURE.md](ARCHITECTURE.md) explains how
the widget is put together and why; this file covers the mechanics of working on
it.

## Getting set up

The plugin runs from wherever Omarchy looks for plugins, so the working copy
*is* the installation:

```bash
git clone git@github.com:jkoestinger/omarchy-vpn.git \
  ~/.config/omarchy/plugins/jkoestinger.vpn
omarchy restart shell
```

QML files hot-reload on save. Files under `model/` do not — a `.pragma library`
script stays cached until the shell restarts, which is the single most common
reason a change appears to have done nothing.

The shell writes to `/dev/null` under a normal session, so QML errors are
invisible. ARCHITECTURE.md's [Working on it](ARCHITECTURE.md#working-on-it)
section has the incantation for running it in the foreground with its output
attached, and is worth reading before your first change rather than after it.

## Tests

```bash
node tests/run.js
```

No dependencies, no framework, nothing to install. CI runs exactly this on every
push and pull request, and a red suite blocks the merge.

The tests cover `model/` — the parsing and row-building, which is the half that
runs without a QML engine and the half that has historically been wrong. The
`.qml` files are `Process` plumbing and bindings and are not covered. That is
deliberate, and it is why anything resembling a decision belongs in a model file
rather than in the backend that calls it.

If you fix a parser, add the case that broke it. Real CLI output pasted into a
test is worth more than a tidied-up version of it.

Backend `.qml` files can be checked with:

```bash
cd .. && qmllint -I /usr/share/omarchy/shell jkoestinger.vpn/MullvadBackend.qml
```

One file per invocation, and never from inside the plugin directory —
ARCHITECTURE.md explains why, and why `Panel.qml` exits 255 with no message no
matter what you do to it.

Run `omarchy plugin validate .` if you touched `manifest.json`.

## Adding a VPN tool

See [Adding a backend](ARCHITECTURE.md#adding-a-backend). The short version is
two new files of your own, two lines in `VpnController.qml`, and one entry in
`manifest.json`. Nothing else should need editing — if it does, that is worth
raising in the pull request, because it usually means the backend contract is
missing something rather than that your tool is unusual.

Read the contract before writing to it. Several of its rules exist because a
tool broke a reasonable assumption: `detect()` must not fall through to a
refresh, a status that cannot be read is stale rather than empty, and a backend
that blocks traffic while disconnected has to say so. Each of those is a bug
that shipped once.

## Commits

Commit messages follow [Conventional
Commits](https://www.conventionalcommits.org/), because the changelog and the
version number are generated from them:

```
feat: add a Windscribe backend
fix: stop a cancelled connect from coming back to life
docs: show the panel preview in the README
```

- `feat:` — a minor bump, and a **Added** entry in the changelog
- `fix:` — a patch bump, and a **Fixed** entry
- `refactor:`, `docs:`, `perf:` — appear in their own sections
- `chore:`, `ci:`, `test:` — no bump, hidden from the changelog
- `feat!:`, or a `BREAKING CHANGE:` footer — a major bump

The subject line is what a reader of the changelog sees, so write it as the
thing that changed rather than the work you did: *stop a cancelled connect from
coming back to life*, not *fix bug in controller*. Put the reasoning in the body
— it is not extracted into the changelog, and it is the part worth having in six
months.

Do not edit `CHANGELOG.md` or the version in `manifest.json`. Both are written
by release automation, and a hand-edit is overwritten on the next release.

## Branches and pull requests

`dev` is the working branch. **Open pull requests against `dev`, not `main`** —
`main` is the distribution branch, so whatever lands there is what everyone is
running, and it only ever moves at release time.

```bash
git switch dev && git pull
git switch -c my-change
```

Before opening a pull request: `node tests/run.js` passes, and you have actually
run the widget with your change in it. A VPN widget that reports a tunnel it
does not have is worse than one that reports nothing, so a screenshot of the
panel in the state you changed is genuinely useful in the description.

Releases are cut by release-please: merging to `dev` updates a standing release
pull request, and merging that tags the version and opens the promotion pull
request onto `main`. Contributors do not need to do anything about this beyond
writing commit messages in the format above.

## Style

Match what is around your change. Two things are not obvious:

**`model/` files are QML `.pragma library` scripts**, not node modules. They use
`var` and `function` declarations, they have no imports beyond `.import
"Shared.js" as Shared`, and they cannot touch QML objects. Everything in them is
a pure function of its arguments — that is what makes them testable, and it is
the property to protect. Test files are plain node and use modern syntax freely.

**Comments explain why, not what.** The existing ones are long where the
reasoning is not recoverable from the code — a retry that is jittered because two
widget instances would otherwise collide on every round, a status that is kept
stale because blanking it would take away the only way to bring down a tunnel.
Short where it is obvious. When you work around something a CLI does, write down
what it does; the next person cannot reproduce it from the workaround alone.

Nerd Font glyphs are built with `String.fromCodePoint` rather than pasted, since
editing tools mangle multi-byte sequences in QML.

## Reporting a bug

Include the tool and its version, what the panel showed, and what the CLI says
when you run the equivalent command yourself. For a parsing bug the raw output
is the whole report — paste it verbatim, including the parts that look
irrelevant.
