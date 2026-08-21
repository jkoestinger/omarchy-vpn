# Architecture

The panel knows nothing about any particular VPN tool. It renders whatever the
active backend exposes, and the controller decides which backend that is. A tool
is two files of its own plus two lines in the controller — see [Adding a
backend](#adding-a-backend), and [CONTRIBUTING.md](CONTRIBUTING.md) for the
surrounding workflow.

## Files

| File | Role |
|------|------|
| `manifest.json` | Plugin id, kind (`bar-widget`), entry point, settings schema |
| `Panel.qml` | Bar button and popup. Layout, cursor, keyboard, IPC surface |
| `VpnController.qml` | Owns the backends, picks the active one, enforces exclusivity, fetches the public IP |
| `ProtonBackend.qml` | Proton VPN, via the `protonvpn` CLI |
| `MullvadBackend.qml` | Mullvad, via the `mullvad` CLI |
| `WindscribeBackend.qml` | Windscribe, via `windscribe-cli` |
| `NetworkManagerBackend.qml` | OpenVPN, WireGuard and OpenConnect, via NetworkManager |
| `model/Shared.js` | Helpers every backend leans on, and the widget's own settings |
| `model/Proton.js`, `model/Mullvad.js`, `model/Windscribe.js`, `model/NetworkManager.js` | Pure parsing and row-building, one file per tool. No QML, no side effects |

Each backend is a pair: the `.qml` file holds the `Process` plumbing, and the
matching `model/*.js` holds everything that can be decided without running a
command. The split is what makes the interesting half testable, so a backend
that puts its parsing in the QML file has given that up.

`model/*.js` files are QML `.pragma library` scripts. A backend's model imports
the shared helpers with `.import "Shared.js" as Shared` and imports nothing
else — no model file may reach into another tool's.

## The backend contract

A backend is any `Item` exposing these. Nothing enforces it — the controller
duck-types, so a backend that omits something simply renders as blank.

**Identity**

| Property | Meaning |
|----------|---------|
| `backendId` | Stable key used by settings and IPC (`proton`, `mullvad`, `windscribe`, `networkmanager`) |
| `label` | Name on the switcher chip and hero. Also what `preferredBackend` stores, so it must match that enum in `manifest.json` exactly |
| `installNames` | What a user would install to make this backend useful, as a list. The panel joins them into its "install something" line when no tool is detected. Usually one name and the same as `label` — NetworkManager is the exception, offering `["OpenVPN", "WireGuard", "OpenConnect"]`, because nobody installs a connection manager to get a VPN |
| `glyph` | Nerd Font character for the hero icon |
| `supportsFilter`, `filterPlaceholder` | Whether the panel shows its filter field |
| `filter` | The panel writes the current filter text here |

**State**

| Property | Meaning |
|----------|---------|
| `detected` | Tool is installed and has something to offer. Everything else is ignored until this is true |
| `connected` | A tunnel is up |
| `summary` | One line under the hero title |
| `details` | `[{ label, value }]` rows shown while connected |
| `targets` | `[{ key, label, detail, glyph, args }]` — the connectable list |
| `currentKey` | The `key` of the target currently connected, or `""` |
| `emptyText` | Shown when `targets` is empty |
| `toggles` | `[{ key, label, detail, value, busy }]` — the tool's own settings. Omit it, or return `[]`, and the panel draws no settings block |
| `busy`, `actionStatus`, `lastError` | Transient feedback |

**Verbs**

`detect(force)`, `refresh()`, `connectTo(target)`, `disconnect()`,
`toggleConnection()`, and `setToggle(key, value)` for a backend that offers
`toggles`.

`detect(force)` probes and nothing else — it must not fall through to a
`refresh()`, because a hidden backend is given `detect()` alone and would
otherwise keep polling a tool the user switched off. `refresh()` guards itself,
so the controller can call it unconditionally.

`toggleConnection()` is the backend's own idea of a default connection — Proton
picks the fastest server; Mullvad reuses its stored relay constraint; Windscribe
takes its best location; NetworkManager connects the only profile if there is
exactly one, and otherwise asks the user to pick.

A backend may also expose `lockdownMode`, meaning "this tool blocks all traffic
while it is disconnected". The controller warns about it before tearing that
backend down for another one, and names the command from the backend's
`lockdownHint` so the warning is not written in one tool's vocabulary.

It may also expose `setupHint`: one line explaining why it is not `detected`
and what would change that. The panel shows the first non-empty hint in place
of its own "install a VPN tool" line, which is the wrong advice for a tool that
is installed and merely has nothing to connect to yet.

## Adding a backend

Say the tool is called Tunnelbear.

1. `model/Tunnelbear.js` — the parsing and the row-building. Start with
   `.pragma library` and `.import "Shared.js" as Shared`.
2. `tests/model/tunnelbear.test.js` — the suite picks it up by filename, so
   nothing else needs editing to run it.
3. `TunnelbearBackend.qml` — the `Process` plumbing, implementing the contract
   above. It imports `model/Shared.js` and `model/Tunnelbear.js`, and no other
   backend's model.
4. `VpnController.qml` — add it to the `backends` list, and instantiate it
   alongside the others. Two lines, next to each other.
5. `manifest.json` — add the `label` to the `preferredBackend` enum.

Step 5 is the one that cannot be derived: that enum is static JSON, read by
Omarchy's settings dialog before any QML runs, so nothing at runtime can fill it
in. Everything else about the tool is discovered from the backend itself — the
chips, hero, detail rows, target list, keyboard navigation, exclusivity, the
public-IP refresh, the `preferredBackend` mapping, and the panel's line naming
what a user could install.

Anything you find yourself adding to `Panel.qml` or `model/Shared.js` to make
one tool work is worth a second look: the contract is meant to absorb that, and
if it cannot, the contract is what should change.

## Design notes

**Exclusivity.** Every connect goes through `VpnController.connectVia()` or
`toggleActive()`, never straight to a backend. Those disconnect every other
connected backend, wait for them to report down (700ms polls, ~10s cap, then
proceed anyway so a stuck teardown cannot swallow the user's connect), and only
then bring the new tunnel up.

Every *disconnect* goes through `disconnectActive()` for the mirror-image
reason: the connect waiting on that teardown is part of what is being withdrawn,
and a queued action nobody cancelled fires seconds later and reconnects the
tunnel the user just asked to bring down. Picking a second target cancels the
first for the same reason — nobody clicks two countries wanting both — which
matters most when the teardown finished between the click and the next poll, so
the second connect takes the "nothing to wait for" path and would otherwise
leave the first one queued behind it.

**Optimistic state.** Both backends keep a `_desired` field: `-1` follows
reality, `0`/`1` overrides it while a command is in flight. That is what makes
the switch flip the instant it is clicked instead of waiting a poll cycle.
Reality reasserts itself once the tool agrees, or after the settle timer gives
up.

**Public IP.** Fetched with `curl https://checkip.amazonaws.com`, never polled.
The scheme is explicit — over plain HTTP anyone on the path could forge the
address the panel presents as proof the tunnel works — and the response is only
believed if it parses as an address literal. The
trigger is `connectionKey` — a string built from the connected backend's id and
summary — so a connect, a disconnect, or a server switch all invalidate it. A
2s delay lets routes settle first, since asking too early returns the old
address. One extra fetch happens at startup, because a shell restart inherits an
already-up tunnel and no change ever fires.

**Proton status parsing.** The CLI prints plain text, not JSON, and the format
moves between releases. `parseProtonStatus` matches on the leading key of each
line rather than on line position, and handles both the modern combined form
(`Server: CH#1129 in Zurich, Switzerland`) and older separate `Country`/`City`
keys.

**Proton spawns are expensive, and a signed-out CLI refuses forever.** Every
non-hidden backend is polled on the interval whether or not the panel is open,
and `protonvpn` is a Python entry point: roughly 0.75 CPU-seconds per invocation
against a Go binary's few milliseconds. So Proton asks for one thing per poll,
not three. `_configLoaded` and `countriesLoaded` both mean *asked and answered* —
latched on the answer, not on the answer being usable — and `detect(force)` is
what clears them, which is the user opening the panel or pressing `r`.

The status read that remains runs at the rate the answer can change, not at the
controller's. Connected reads every tick: a tunnel that drops behind a closed
panel leaves the chip claiming protection nobody has, and overstating protection
is the one wrong answer worth a Python start to avoid. Disconnected reads every
fourth — understating it is harmless by comparison, and the only thing that makes
it connected is somebody acting, either through the widget (`refreshNow()`, which
is what `settleTimer` and a finished action use, ignores the cadence) or at a
terminal, which the next slow tick catches inside a minute. Signed out does not
read at all. Idle goes from twelve spawns a minute to one, or to none, and a
two-monitor desktop instantiates all of this twice.

Signed out is the case that made this matter: `protonvpn status` exits 0 and
prints `Status: Disconnected`, so `detected` stays true and the poll runs
happily, while `config list` and `countries list` each exit 2 with
`Authentication required …`. Read as a plain failure that is three Python starts
every 15 seconds for the life of the shell. `protonAuthRequired` tells that
refusal apart from a tool that is unwell, `signedOut` latches it, and the panel
says `protonvpn signin` instead of `Loading countries…` forever.

**Settings are read, never owned.** `toggles` always reports what the tool
itself last said, and the widget stores no copy — nothing in `manifest.json`
asserts a desired value at startup. Turning lockdown on from the Mullvad CLI
shows up in the panel on the next poll, and a widget restart never quietly puts a
setting back. The cost is one extra read (`mullvad` answers three subcommands in
one shell; Proton answers with `protonvpn config list`), which is a local call in
both cases — but only Mullvad pays it on every refresh. Proton reads its settings
once and then when the user asks, because `protonvpn` is Python and a spawn there
costs the better part of a CPU-second; the panel is the only thing that draws
them, and opening it forces a refresh anyway.

The block is a drawer behind the hero, closed by default: settings are read once
and then left alone, while the target list is why the panel gets opened. The
chevron on the hero is the only affordance, so a backend with no `toggles` gets
the hero exactly as it was — no empty drawer, no dead handle. The open/closed
state lives on the panel, so it survives a close and reopen but not a shell
restart, and folding the drawer while the cursor is inside it moves the cursor
back to the hero rather than stranding it.

**Windscribe is a client, twice over.** `windscribe-cli` talks to the Windscribe
desktop app, so the binary being present says nothing: an app that is not running
answers nothing, and one nobody is logged into has no locations and cannot
connect. `detected` is therefore `present && loggedIn`, which takes a status read
to answer — so `detect()` runs two commands rather than one, and the two failures
are told apart in `setupHint`.

**Windscribe takes a lock, and the widget is not one process.** Two
`windscribe-cli` invocations may not overlap: the second exits with `Windscribe
CLI is already running` and does no work, so a pair started together loses both
answers. Every call the backend makes therefore goes through one queue and one
process, with reads deduplicated (a status poll already in flight is not queued
behind itself) and clicks pushed to the front.

That much is only half the problem, and the half that is easy to mistake for all
of it. The lock is per machine, and each bar instantiates the widget separately —
so a two-monitor desktop runs two of these queues, each perfectly disciplined and
each blind to the other. They poll on the same interval, so they collide on the
same tick, and both lose. A backend that treated the refusal as an answer would
hide itself on whichever screen came second, intermittently, for reasons nothing
in one instance could explain.

So a refusal is not a result. The job goes back to the head of its own queue and
is tried again, up to four times, after a jittered delay — jittered because two
instances that lost together would otherwise back off by the same amount and
collide again on every round, and the attempt count is identical on both sides so
it cannot be what breaks the tie. Past the last attempt the finisher runs and
treats the refusal as inconclusive rather than as news; the next poll asks again.
The same path covers the user running the CLI at a terminal, which is the case
that cannot be designed away.

A stall timer covers the remaining way for "one at a time" to fail: a job that
never comes back would hold the runner slot forever, and since a read already in
flight is never queued twice, the backend would quietly stop asking about the
tunnel for as long as the shell ran. It **kills** the process rather than
forgetting it — a forgotten one still holds the machine-wide lock, blocking every
other copy of the widget as well as this one, while nothing could start behind
it. Killing makes `onExited` fire and the usual path does the bookkeeping.

Nothing in the queue waits on a zero-interval timer. `pump` never arranges to be
called back while a job is on the wire; the running job's `onExited` is what
pumps. An earlier version re-armed a 0 ms timer there, which turned a hung CLI
into a shell spinning through its event loop for the length of the hang.

The queue rules themselves — dedupe, front-insertion, bounded retry, backoff —
live in `model/Windscribe.js` as a reducer over `(queue, running job)`, because
they are logic rather than plumbing and they are the part that has been wrong.

**A status that cannot be read is stale, not empty.** The last reading is kept
and flagged, never replaced with a blank one, and two things hang on that.
`detected` follows the login state, so blanking would take the chip away while a
tunnel is up — and with it the only way to bring that tunnel down, since every
verb refuses to run undetected. That is the hazard NetworkManagerBackend keeps
its own stale list to avoid. And a blank status reports the firewall as off:
losing contact with the app is exactly when the widget must not start claiming
that nothing is being blocked.

For the same reason a firewall line this parser cannot read counts as "might be
blocking" when the controller weighs whether to warn, even though the summary
line still reports only what the tool actually said. One weighs a risk, the
other states a fact.

**Windscribe connects non-blocking.** `connect -n` returns as soon as the daemon
accepts the request. A blocking call would hold the CLI lock — and with it every
status read — for the whole handshake, which is exactly the stretch the panel has
something to say. The cost is that the exit code stops meaning anything: a free
account reaching for a Pro location is accepted, exits 0, and fails seconds later
with nothing but `Connect state: Error: …` to show for it. So the optimistic
state is dropped the moment a status read reports that error, rather than waiting
out the settle timer and vouching for a tunnel that never came up. The error is
sticky in the CLI — it stands until the next successful connect — so the backend
both raises and clears it from the same reading.

**Windscribe rows are regions, not countries.** `windscribe-cli locations` prints
`Region - City - Nickname`, and `connect` takes any of the three. Regions are the
grouping the tool itself uses and the shortest useful list, so they are what the
panel shows; cities and nicknames stay searchable. `status` names only the city
and the nickname, never the region, so the row to tick is looked back up in the
list — city first across every region, since two regions sharing a nickname is
likelier than two sharing a city.

**Two kinds of settings, two places.** The drawer above holds the *tool's*
settings, which the widget only reflects. The gear in the header holds the
*widget's* own, which it owns and must persist — currently one switch per
detected tool. It writes through `bar.shell.updateEntryInline(moduleName,
settings)` into this widget's entry in `~/.config/omarchy/shell.json`, the same
file and entry Omarchy's settings dialog edits, so the two never disagree.
`settings` arrives holding only the inline overrides, so writing it back cannot
bake today's defaults into the config.

Hidden tools are dropped from `availableBackends`: no chip, no polling, no
weight in the bar icon, and exclusivity never tears them down. They are still
probed, since the settings view has to list a hidden tool for you to switch it
back on, and `detectedBackends` — everything present, hidden or not — is what
that view renders. Hiding is a view, not a drawer: it replaces the body, because
nothing in the connect list means anything while you are deciding which tools
the widget should know about. It resets on close, unlike the tool drawer, and
the gear stays reachable with the master switch gone so a widget with everything
hidden is not a dead end.

While a switch is in flight it shows the position the user just asked for, with
`busy` set. The optimistic value is dropped only for the keys the tool has since
agreed with, so a poll landing mid-flight cannot flick the other switches back —
the same shape as `_desired` for connection state. A refusal rolls that one key
back and puts the tool's complaint in `lastError`.

**Mullvad's two-step connect.** `mullvad connect` takes no target: the relay
comes from a constraint stored in the daemon by `mullvad relay set location`.
`connectTo` therefore runs two commands and stops if the first fails, since
connecting against a stale constraint would put up a tunnel in the wrong country
and report it as the one that was clicked. The chain hops through a zero-interval
timer rather than starting the second command inside the first one's `onExited`,
and `_working` covers that gap so a second click cannot interleave.

**Mullvad status is JSON.** `mullvad status -j` avoids parsing a CLI that prints
an ANSI spinner, and it carries more than the text form: the endpoint, the tunnel
interface, and whether traffic is currently blocked. `details` changes shape with
`state` — an object while connected, connecting, or disconnected, a bare string
while disconnecting — so the parser type-checks before reaching in, and anything
unparseable stays "no idea" rather than becoming "disconnected".

**Lockdown mode.** Distinct from the `error` state. `locked_down` in the status
payload means traffic is being blocked right now and is only reported while the
tunnel is down; the setting itself is read separately with
`mullvad lockdown-mode get`, because the case that matters — Mullvad connected,
another backend about to take over — is exactly when the payload omits it.

**Why OpenVPN, WireGuard and OpenConnect share one backend.** Same listing call,
same teardown, same secret-agent problem, and no settings of their own on any
side. Three chips would have meant three views of one manager. NetworkManager
types them differently — OpenVPN and OpenConnect are `vpn` connections with a
service-type plugin behind them, WireGuard is its own connection type with the
keys in the profile — and that difference is carried on each row as `kind`,
which picks the glyph, decides whether the username check applies, and decides
whether activation is an nmcli call at all.

**Why OpenConnect needs a helper.** It is the one kind that cannot be brought
up with `connection up`. Its `cookie`, `gateway`, `gwcert` and `resolve`
secrets are all flagged not-saved, so every activation needs a secret agent to
produce them, and `nmcli --ask` cannot stand in: it prompts for those four by
name, and nobody can type a session cookie. What normally answers is nm-applet,
whose whole contribution for OpenConnect is to run the auth dialog that
networkmanager-openconnect ships and hand the results back.
`bin/omarchy-openconnect-auth` does the same thing without the tray icon, so an
OpenConnect target carries a whole `command` where the other kinds carry `args`
for nmcli. The dialog is the same window the user already knows, which is the
point: it is generated from the gateway's own XML and copes with Duo, cert
prompts and form revisions that a reimplementation would break on.

**NetworkManager discovery.** Two passes. `nmcli -t -f
NAME,UUID,TYPE,ACTIVE,FILENAME connection show` gives every connection; the
`vpn` and `wireguard` rows are kept. A second call over just the `vpn` uuids
fetches `vpn.service-type` (which sorts OpenVPN from OpenConnect, and drops a
third plugin's profile) and `vpn.data` (to check for a username, and to read
the OpenConnect gateway). WireGuard rows skip that pass entirely — they are
already known to be WireGuard and have no username to be missing. The username
matters because
NetworkManager keeps it outside the secrets store, so `nmcli --ask` never
prompts for it — a profile without one authenticates as the empty user and the
server answers `AUTH_FAILED`. The backend detects that case and reports the fix
instead of opening a terminal that cannot succeed.

**Eligibility, not just installation.** NetworkManager ships on every desktop,
so "nmcli is here" says nothing about whether this machine has a tunnel to
offer. It is `detected` only while at least one eligible profile exists — one
whose kind matches an installed tool (`openvpn` for OpenVPN profiles, `wg` for
WireGuard ones), since NetworkManager lists an OpenVPN profile whether or not
anything can run it. With no eligible profile the backend disappears, and with
it the chip, the hero, and the empty list they led to; the import instructions
move to the panel's `setupHint` line so nothing is lost. Because `detected` now
follows the profile list, the question is settled by `refresh()` rather than by
`detect()`, which runs its four probes once and is a no-op after that.

**FILENAME is what keeps other tools' tunnels out.** When something brings up a
WireGuard interface itself — Mullvad's `wg0-mullvad` — NetworkManager adopts the
device and generates a volatile connection for it under `/run/NetworkManager/`.
It is `wireguard`-typed and active, so a type filter alone would list Mullvad's
tunnel as a NetworkManager profile: the same tunnel on two chips, and a
`connection down` that would yank it out from under the daemon that owns it.
Profiles the user imported live under `/etc`, so anything under `/run` is
dropped. An nmcli too old to report FILENAME leaves it empty, which keeps the
row rather than emptying the list.

**Exclusivity inside the backend.** The controller enforces one tunnel across
backends, but NetworkManager will happily run two of its own profiles at once,
and picking one is never a request for both. So `connectTo` runs two commands
when something else is up: down the active profile, then up the chosen one. A
failed teardown still proceeds, for the same reason the controller's does.

**Nerd Font glyphs** are built with `String.fromCodePoint` rather than pasted as
literal characters, because editing tools routinely mangle multi-byte sequences
in QML.

## Working on it

Files under `~/.config/omarchy/plugins/` hot-reload on save — QML files, that
is. Changes under `model/` do **not** take effect until the shell restarts,
since a `.pragma library` script stays cached:

```bash
omarchy restart shell
```

The shell writes its output to `/dev/null` under a normal session, so QML errors
are invisible. To see them, run it yourself for a while:

```bash
while timeout 5 quickshell kill -p /usr/share/omarchy/shell --any-display; do :; done
systemd-run --user --unit=omarchy-shell-debug --collect quickshell -n -p /usr/share/omarchy/shell
journalctl --user -u omarchy-shell-debug -f
```

Restore the session-owned shell afterwards:

```bash
systemctl --user stop omarchy-shell-debug && omarchy restart shell
```

On a multi-monitor setup each bar instantiates the widget separately, so
`Handler was registered but will not be used because another handler is
registered for target …` appears once per extra monitor. Every first-party
widget logs the same thing; it is not a defect.

Check a manifest change with `omarchy plugin validate .` before committing.

## Tests

The `model/` files are where every assumption about how four CLIs format their
output lives, and they are the only half of the widget that runs without a QML
engine. The suite covers them:

```bash
node tests/run.js
(cd .. && qmllint -I /usr/share/omarchy/shell jkoestinger.vpn/Panel.qml)
```

One file per invocation, and never from inside the plugin directory. qmllint
treats the directory it is pointed at as an implicit import, which makes
`Panel.qml` — a `Panel` deriving from `qs.Ui`'s `Panel` — resolve to itself and
crash with exit 255 and no message. A batch invocation adds the same directory
for the same reason. Neither is a defect in the file being checked.

No framework and no `package.json` — a suite that needed installing would not
get run, and the plugin is not built. `tests/harness.js` strips the `.pragma`
and `.import` lines, which are not JavaScript, evaluates each model file in the
node realm, and collects the names it declares, since a `.pragma library` has no
exports. `Shared.js` is loaded first and bound to a global of that name, which
is what the `.import` line resolves to inside the QML engine; that is the whole
of the emulation. `tests/run.js` then runs every `tests/model/*.test.js` it
finds, so a new backend's tests are picked up by dropping the file in. CI runs
the same command on push and pull request.

The QML halves are not covered: they are `Process` plumbing and bindings, and
the interesting logic was pushed into `model/` precisely so it could be tested.
When a bug turns out to live in a parser, the fix belongs there with a case
beside it.
