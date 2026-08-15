# Changelog

## 1.1.0

### Added

- **Widget settings, behind the gear in the panel header.** One switch per VPN
  tool found on this machine. Turn one off and the widget forgets it entirely:
  no chip, no polling, and it stops counting toward the bar icon. The choice is
  written to `~/.config/omarchy/shell.json` as `hiddenBackends`, the same entry
  Omarchy's own settings dialog edits, so the two never disagree.
- **A tool with nothing to offer no longer draws a chip.** NetworkManager ships
  on every desktop, so "nmcli is here" said nothing about whether this machine
  had a tunnel to offer. It now appears only once an eligible profile exists —
  an OpenVPN one with `openvpn` installed, or a WireGuard one with
  `wireguard-tools` — and the import instructions move to the panel's setup
  line rather than sitting behind a chip that led to an empty list.

### Fixed

- **The master switch could take down the wrong tunnel.** It bound its position
  to "anything is connected" while its click acted on the tool being looked at,
  so with Mullvad up and the Proton chip picked it read "Disconnect" and then
  tore Mullvad down and brought Proton up. It now follows the backend it drives.
- **Mullvad's lockdown mode could be drawn as off while it was on.** The three
  settings are read in one shell, and one shell has one exit code — the last
  subcommand's — so a failed `lockdown-mode get` left no line and no error, and
  the parser read the silence as "off". That also silently disarmed the warning
  shown before Mullvad is torn down for another tool. The parser now records
  which answers arrived and draws a switch only for those; a read that answered
  nothing leaves the last known state alone.
- **The public IP was fetched over plain HTTP.** A bare hostname left curl on
  port 80, where anyone between this machine and the exit — the very party a VPN
  is run against — could hand back any address and have the panel present it as
  proof the tunnel works. It is HTTPS now, with `--fail`, and the response is
  believed only if it parses as an address literal, so a captive portal's login
  page reaches neither the display nor the clipboard.
- **A cancelled connect could come back to life.** A connect queued behind
  another tool's teardown was never cancelled, so pressing `d`, flipping the
  master switch off, or picking a second country left the first request in the
  exclusivity timer, which fired seconds later and brought up a tunnel the user
  had already called off.
- **`connect <country code>` over IPC only worked for Proton VPN.** It matched
  the row's detail line, and Mullvad's carries a city count after the code
  (`CH · 3 cities`), so the shorthand the README documents answered
  `unknown target`. It now matches the row key, which every backend spells the
  same way.
- **A hidden NetworkManager kept polling `nmcli` every interval**, which is the
  one thing hiding a tool is supposed to stop.
- The lockdown warning was written to the backend's `lastError`, which
  `connectTo()` clears as its first act — so the action being warned about
  erased the warning on its way out. It lives on the controller now, with an
  expiry of its own.
- An optimistic switch whose command exited clean but never took would sit
  showing the position the user asked for, marked busy, for as long as the panel
  stayed open. Optimism now has a deadline.
- Turning NetShield or the kill switch off and on again restored the mode it had
  rather than silently upgrading a deliberate `malware-only` to the wider
  default.
- A relay or country list the parser could not read was re-fetched on every poll
  for as long as the shell ran, while the panel showed nothing and no reason why.
- An `nmcli` too old to report `FILENAME` rejected the whole listing rather than
  answering without the field, so the NetworkManager backend silently never
  appeared. The first refusal now drops the field and lists again.
- A failed NetworkManager details pass emptied the profile list, which took the
  chip away mid-tunnel — and with it the only way to bring that tunnel down. It
  keeps the last known list now.
- The filter field is cleared at both ends when the chip changes, so it cannot
  show text the list is not filtered by.

### Internal

- `Model.js`, where every assumption about three CLIs' output formats lives, now
  has a test suite: 35 cases, stdlib only, no `package.json`, run with
  `node tests/run.js` and on every push and pull request.

## 1.0.0

First release. Proton VPN, Mullvad, and NetworkManager's OpenVPN and WireGuard
profiles behind one bar icon, with exclusivity between them, a public-IP
readout, keyboard navigation, and an IPC surface for scripts.
