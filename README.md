# omarchy-vpn

A VPN widget for the Omarchy bar. One icon shows whether you are behind a
tunnel; one panel connects, disconnects, and switches between the VPN tools you
actually have installed.

It supports **Proton VPN**, **Mullvad**, **Windscribe**, and the **OpenVPN** and
**WireGuard** profiles NetworkManager holds. Only the tools
that have something to offer appear — install none and the widget tells you so;
have several and a chip row lets you switch between them.

<img src="preview.png" alt="The VPN panel open in the Omarchy bar, showing a Proton VPN connection to Zurich and a country list" width="365">

Each installed tool gets its own chip and its own view — Proton VPN above,
[Mullvad](#mullvad), [Windscribe](#windscribe) and
[NetworkManager](#networkmanager-profiles) below.

## Install

```bash
omarchy plugin add https://github.com/jkoestinger/omarchy-vpn.git
omarchy plugin enable jkoestinger.vpn
```

Plugins land disabled so you can read the code before it runs — it runs
unsandboxed inside `omarchy-shell`, like every Omarchy plugin. **Setup ›
Plugins** does the same thing from the menu.

The icon appears at the right end of the bar. Move it with
`omarchy bar move jkoestinger.vpn --before omarchy.clock`, or any other
placement.

To update later: `omarchy plugin update`. To remove:
`omarchy plugin remove jkoestinger.vpn`.

## Using it

The bar icon is dim when nothing is connected and bright when a tunnel is up.
Hover it to see which one.

| Action | Result |
|--------|--------|
| Left click | Open the panel |
| Right click | Connect using the tool's own default, or disconnect |
| Middle click | Refresh status and public IP |

Inside the panel:

- **Public IP** sits top-left. Click it to copy it.
- **The switch** top-right connects or disconnects. Turning one VPN on shuts
  every other one off first — you never end up with two tunnels fighting over
  your routes.
- **The gear** to its left opens the widget's own settings, which for now is one
  switch per tool found on this machine. Turn one off and the widget forgets it
  entirely: no chip, no polling, and it stops counting toward the bar icon. Turn
  it back on from the same place. The choice is written to
  `~/.config/omarchy/shell.json` and survives a restart.
- **The chips** below choose which tool you are looking at. They only appear
  when you have more than one installed.
- **The name row** is also a drawer. Tools with settings of their own get a
  chevron; click the row to fold them out, click it again to put them away. It
  starts closed and stays however you left it until the shell restarts.
- **The settings** inside are Mullvad's connect-on-startup, lockdown mode, and
  local network sharing, Proton VPN's kill switch, NetShield, and port
  forwarding, and Windscribe's firewall. They show what the tool itself reports,
  so changing one from its CLI shows up here on the next poll — the widget keeps
  no copy and never puts one back for you.
- **The list** is what you can connect to: for Proton VPN, fastest / P2P /
  random / Secure Core followed by every country; for Mullvad, any location
  followed by every country it has relays in; for Windscribe, best location
  followed by every region it serves; for NetworkManager, your OpenVPN and
  WireGuard profiles, told apart by their icon. A check mark marks where you are
  connected.

Keyboard, once the panel is open: `j`/`k` or arrows move — through the header,
the chips, the name row, the settings switches if they are open, then the list —
`Enter` connects, flips a switch, or opens and closes the settings drawer,
depending on what the cursor is on. `h`/`l` move along the chip row and between
the gear and the master switch in the header, `s` cycles tools, `/` searches
countries, `d` disconnects, `r` refreshes, `Esc` closes.

The public IP is fetched from `https://checkip.amazonaws.com` — never on a timer, only
when the connection changes, when the panel first opens, or when you ask.

## Requirements

Omarchy with its Quickshell desktop, plus at least one of:

- **Proton VPN** — the `protonvpn` CLI, signed in (`protonvpn signin`).
- **Mullvad** — the `mullvad` CLI with `mullvad-daemon` running, logged in
  (`mullvad account login <number>`).
- **Windscribe** — `windscribe-cli` with the Windscribe app running, logged in
  (`windscribe-cli login`).
- **OpenVPN or WireGuard** — `nmcli`, plus `openvpn` or `wg` (wireguard-tools),
  with at least one profile imported into NetworkManager.

## Settings

Configure these in **Setup › Plugins**, or in the widget's entry in
`~/.config/omarchy/shell.json`.

| Setting | Default | What it does |
|---------|---------|--------------|
| `refreshIntervalSec` | `15` | How often the connection status is polled |
| `preferredBackend` | `Auto` | Which tool the panel opens on. `Auto` picks whichever is connected |
| `favoriteCountries` | `CH,NL,US` | Country codes pinned to the top of the Proton VPN and Mullvad lists. Windscribe has no codes, so it matches names instead — see below |
| `hiddenBackends` | *(empty)* | Tools the widget ignores entirely: `proton`, `mullvad`, `windscribe`, `networkmanager`. The gear inside the panel writes this |

## Mullvad

<img src="preview-mullvad.png" alt="The VPN panel on the Mullvad chip, showing Any location followed by a country list" width="365">

Mullvad separates picking a relay from connecting: `mullvad relay set location`
records a constraint, `mullvad connect` brings the tunnel up against it. The
widget does both for you, so clicking a country connects to it and the choice
sticks — the switch and `quickconnect` reconnect to whatever you picked last
rather than to a "fastest server" the CLI has no notion of. **Any location**
hands the choice back to Mullvad.

Cities are searchable even though only countries are listed: typing `zurich`
finds Switzerland.

**Lockdown mode** blocks all traffic whenever Mullvad is disconnected —
including the traffic another VPN needs to connect. The widget says so before it
shuts Mullvad down for a different tool, but it will not turn lockdown off on its
own. That switch is in the panel, or:

```bash
mullvad lockdown-mode set off
```

## Windscribe

`windscribe-cli` is a client for the Windscribe desktop app, so the chip appears
only once that app is running and logged in. Until then the panel says which of
the two is missing instead of listing an empty chip.

The list is Windscribe's own regions — a country most of the time, a slice of one
where a country has too many (`US East`, `US West`). Clicking one connects to a
datacenter inside it. **Best location** hands the choice back to Windscribe, and
names the server it currently resolves to. Cities and Windscribe's server
nicknames are searchable even though only regions are listed, so both `zurich`
and `alphorn` find Switzerland.

Rows marked **Pro only** hold nothing a free account can reach. Connecting to one
fails with `Location does not exist or is disabled`, which does not say which of
the two it meant — hence the marker.

Because Windscribe names its regions and never prints a country code,
`favoriteCountries` matches them by name (`Switzerland`) and by leading word
(`US` pins US East, US Central and US West). The default `CH,NL,US` therefore
pins only the US rows on this chip.

**The firewall** is Windscribe's kill switch, and with the app's firewall mode set
to `Auto` it turns itself on before a connect and off after a disconnect. While it
is on and the tunnel is down, nothing leaves the machine — including the traffic
another VPN needs to connect. The widget says so before it shuts Windscribe down
for a different tool, but it will not turn the firewall off on its own. That
switch is in the panel, or:

```bash
windscribe-cli firewall off
```

One caveat that is Windscribe's and not the widget's: `windscribe-cli` refuses to
run while another copy of itself is running, exiting with `Windscribe CLI is
already running` rather than waiting its turn. The widget serialises its own calls
and retries the ones that lose the race, so a command you run yourself at a
terminal costs the panel a moment and nothing more.

## NetworkManager profiles

<img src="preview-networkmanager.png" alt="The VPN panel on the NetworkManager chip, listing two OpenVPN profiles and one WireGuard profile" width="365">

Neither OpenVPN nor WireGuard has a daemon of its own to ask, so both come from
NetworkManager — the thing that imports and stores tunnel configs on a desktop.
They share one chip, and the row icon says which is which. Import one with:

```bash
nmcli connection import type openvpn file ~/Downloads/office.ovpn
nmcli connection import type wireguard file ~/Downloads/home.conf
```

NetworkManager runs on every desktop, so the chip appears only once you have a
profile it can actually carry — an OpenVPN one with `openvpn` installed, or a
WireGuard one with `wireguard-tools`. Until then the panel shows the import
command above rather than a chip leading to an empty list.

A tunnel you started some other way is not listed: a bare `openvpn` process,
`openvpn-client@.service`, or a `wg-quick@` unit. Neither is a tunnel another
tool on this list owns — Mullvad brings up its own WireGuard interface, and
NetworkManager adopts it, but that belongs on the Mullvad chip and appears only
there.

Picking a profile takes down whichever one is already up. NetworkManager is
happy to run two tunnels at once; that is never what clicking a second profile
means.

A freshly imported OpenVPN profile usually has no credentials saved, and there is no
password prompt running inside the Omarchy shell. To make a profile connect in
one click:

```bash
nmcli connection modify <name> +vpn.data username=<user>
nmcli connection modify <name> +vpn.data password-flags=0
nmcli connection modify <name> vpn.secrets 'password=<password>'
```

`password-flags=0` tells NetworkManager to own the password; imported profiles
usually arrive as `2` ("always ask"), which makes it ignore anything you saved.
The password then lives in `/etc/NetworkManager/system-connections/`, readable
by root only.

Without those, clicking a profile opens a terminal running
`nmcli --ask connection up …` so you can type the password there.

WireGuard needs none of this: its keys live in the profile. The one exception is
a profile whose `wireguard.private-key-flags` were set to ask an agent, which
lands in the same terminal.

If you are importing a Proton `.ovpn`: the username and password are the
**OpenVPN/IKEv2** credentials from your Proton dashboard, not your Proton
account login.

## Troubleshooting

**"No username set" on a profile.** NetworkManager keeps the OpenVPN username
outside the secrets store, so no password prompt can supply it. Set it with the
`nmcli connection modify … +vpn.data username=<user>` line above.

**The server rejects credentials that look right.** Check them against the
tool's own CLI first — for Proton, the OpenVPN credentials are not the account
password. `journalctl -u NetworkManager -f` shows `AUTH_FAILED` when the server
is the one saying no.

**Mullvad says the daemon is not responding.** The CLI is only a client. Start
the daemon with `sudo systemctl start mullvad-daemon` (and `enable` it to have it
come back after a reboot).

**Windscribe is installed but has no chip.** `windscribe-cli` is a client too.
The panel says which half is missing — start the Windscribe app, or
`windscribe-cli login` — and picks the chip up on the next refresh.

**Nothing appears in the bar.** Confirm the plugin is enabled with
`omarchy plugin list`, then `omarchy restart shell`.

**Proton and NetworkManager fight each other.** Proton's daemon tears down foreign
tunnels when it connects. The widget already shuts other tools down before
connecting, so use the widget rather than mixing it with the Proton app.

## Scripting

The widget answers on the shell's IPC bus, so keybindings and scripts can drive
it:

```bash
omarchy-shell jkoestinger.vpn status       # "Proton VPN · CH#1129 · Zurich, Switzerland"
omarchy-shell jkoestinger.vpn ip           # current public address
omarchy-shell jkoestinger.vpn backends     # "proton mullvad windscribe networkmanager"
omarchy-shell jkoestinger.vpn use mullvad  # switch the panel's active tool
omarchy-shell jkoestinger.vpn connect CH   # country code, region or profile name, or row key
omarchy-shell jkoestinger.vpn quickconnect # each tool's default connection
omarchy-shell jkoestinger.vpn disconnect
omarchy-shell jkoestinger.vpn toggle       # open or close the panel
```

## Contributing

Adding support for another VPN tool means writing one file. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
