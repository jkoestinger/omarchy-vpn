# VPN

One bar icon for whichever VPN tools are installed. The widget probes for each
supported tool at startup, shows only the ones it finds, and offers a switcher
when there is more than one.

## Backends

| Backend | Detected when | Drives |
|---------|---------------|--------|
| Proton VPN | `protonvpn` on `PATH` | `protonvpn status` / `connect` / `disconnect` / `countries list` |
| OpenVPN | `nmcli` and `openvpn` on `PATH` | NetworkManager connections whose `vpn.service-type` contains `openvpn` |

OpenVPN has no session daemon to query, so its profiles come from
NetworkManager — the thing that actually imports and stores `.ovpn` files on a
desktop. Import one with:

```bash
nmcli connection import type openvpn file ~/Downloads/office.ovpn
```

Profiles started outside NetworkManager (a bare `openvpn` process, or
`openvpn-client@.service`) are not listed.

### Credentials

An imported `.ovpn` usually carries no password, and the Omarchy shell runs no
NetworkManager secret agent, so a headless `nmcli connection up` fails with
`No valid secrets`. When that happens the widget reopens the same activation in
a floating terminal as `nmcli --ask connection up uuid <uuid>`, which prompts
for whatever is missing.

The username is a different matter. NetworkManager keeps it in `vpn.data`, not
in `vpn.secrets`, so `--ask` never prompts for it — a profile without one
authenticates as the empty user and the server answers `AUTH_FAILED`. The
widget checks for this up front and shows the fix instead of opening a terminal
that cannot succeed.

To make a profile connect in one click:

```bash
nmcli connection modify <name> +vpn.data username=<user>
nmcli connection modify <name> +vpn.data password-flags=0
nmcli connection modify <name> vpn.secrets 'password=<password>'
```

`password-flags=0` means "NetworkManager owns this secret"; an imported profile
often arrives as `2` (always ask), which makes NetworkManager ignore a stored
password. Proton VPN's OpenVPN credentials are the per-service username and
password from the account dashboard, not the Proton account login.

## Adding a backend

A backend is any `Item` exposing the contract documented at the top of
`VpnController.qml`: identity (`backendId`, `label`, `glyph`), state
(`detected`, `connected`, `summary`, `details`, `targets`, `currentKey`),
feedback (`busy`, `actionStatus`, `lastError`), and the four verbs
`detect()`, `refresh()`, `connectTo(target)`, `disconnect()`. Drop the file in,
add it to `VpnController.backends`, and the panel picks it up — nothing in
`Panel.qml` knows about a specific tool.

## Interaction

- Left click opens the panel, right click connects/disconnects the active
  backend, middle click refreshes.
- Keyboard: `j`/`k` move, `Enter` connects, `h`/`l` switch backend from the
  chip row, `s` cycles backends, `/` filters (Proton VPN countries), `d`
  disconnects, `r` refreshes, `Esc` closes.

## IPC

```bash
omarchy-shell jkoestinger.vpn status         # "Proton VPN · NL#42, Netherlands"
omarchy-shell jkoestinger.vpn backends       # "proton openvpn"
omarchy-shell jkoestinger.vpn use openvpn
omarchy-shell jkoestinger.vpn connect CH     # country code, profile name, or row key
omarchy-shell jkoestinger.vpn disconnect
```

## Settings

`refreshIntervalSec`, `preferredBackend` (Auto / Proton VPN / OpenVPN), and
`favoriteCountries` for the Proton VPN list.
