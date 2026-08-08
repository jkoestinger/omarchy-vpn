# Architecture

The panel knows nothing about any particular VPN tool. It renders whatever the
active backend exposes, and the controller decides which backend that is. Adding
a tool means writing one file and adding one line.

## Files

| File | Role |
|------|------|
| `manifest.json` | Plugin id, kind (`bar-widget`), entry point, settings schema |
| `Panel.qml` | Bar button and popup. Layout, cursor, keyboard, IPC surface |
| `VpnController.qml` | Owns the backends, picks the active one, enforces exclusivity, fetches the public IP |
| `ProtonBackend.qml` | Proton VPN, via the `protonvpn` CLI |
| `OpenVpnBackend.qml` | OpenVPN, via NetworkManager |
| `Model.js` | Pure parsing and row-building. No QML, no side effects |

## The backend contract

A backend is any `Item` exposing these. Nothing enforces it — the controller
duck-types, so a backend that omits something simply renders as blank.

**Identity**

| Property | Meaning |
|----------|---------|
| `backendId` | Stable key used by settings and IPC (`proton`, `openvpn`) |
| `label` | Name on the switcher chip and hero |
| `glyph` | Nerd Font character for the hero icon |
| `supportsFilter`, `filterPlaceholder` | Whether the panel shows its filter field |
| `filter` | The panel writes the current filter text here |

**State**

| Property | Meaning |
|----------|---------|
| `detected` | Tool is installed and usable. Everything else is ignored until this is true |
| `connected` | A tunnel is up |
| `summary` | One line under the hero title |
| `details` | `[{ label, value }]` rows shown while connected |
| `targets` | `[{ key, label, detail, glyph, args }]` — the connectable list |
| `currentKey` | The `key` of the target currently connected, or `""` |
| `emptyText` | Shown when `targets` is empty |
| `busy`, `actionStatus`, `lastError` | Transient feedback |

**Verbs**

`detect()`, `refresh()`, `connectTo(target)`, `disconnect()`,
`toggleConnection()`.

`toggleConnection()` is the backend's own idea of a default connection — Proton
picks the fastest server; OpenVPN connects the only profile if there is exactly
one, and otherwise asks the user to pick.

## Adding a backend

1. Write `WireGuardBackend.qml` implementing the contract above.
2. Add it to `VpnController.backends` and instantiate it alongside the others.

That is the whole integration. The chips, hero, detail rows, target list,
keyboard navigation, exclusivity, and public-IP refresh all follow from the
contract.

## Design notes

**Exclusivity.** Every connect goes through `VpnController.connectVia()` or
`toggleActive()`, never straight to a backend. Those disconnect every other
connected backend, wait for them to report down (700ms polls, ~10s cap, then
proceed anyway so a stuck teardown cannot swallow the user's connect), and only
then bring the new tunnel up.

**Optimistic state.** Both backends keep a `_desired` field: `-1` follows
reality, `0`/`1` overrides it while a command is in flight. That is what makes
the switch flip the instant it is clicked instead of waiting a poll cycle.
Reality reasserts itself once the tool agrees, or after the settle timer gives
up.

**Public IP.** Fetched with `curl checkip.amazonaws.com`, never polled. The
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

**OpenVPN discovery.** Two passes. `nmcli -t -f NAME,UUID,TYPE,ACTIVE connection
show` gives every VPN-typed connection; a second call over just those uuids
fetches `vpn.service-type` (to keep only OpenVPN ones) and `vpn.data` (to check
for a username). The username matters because NetworkManager keeps it outside
the secrets store, so `nmcli --ask` never prompts for it — a profile without one
authenticates as the empty user and the server answers `AUTH_FAILED`. The
backend detects that case and reports the fix instead of opening a terminal
that cannot succeed.

**Nerd Font glyphs** are built with `String.fromCodePoint` rather than pasted as
literal characters, because editing tools routinely mangle multi-byte sequences
in QML.

## Working on it

Files under `~/.config/omarchy/plugins/` hot-reload on save — QML files, that
is. Changes to `Model.js` do **not** take effect until the shell restarts, since
a `.pragma library` script stays cached:

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
