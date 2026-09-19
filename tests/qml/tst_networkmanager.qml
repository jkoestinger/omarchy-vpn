import QtQuick
import QtTest
import "../.." as Plugin

TestCase {
  name: "ConcurrentNetworkManager"
  Component { id: factory; Plugin.NetworkManagerBackend {} }
  property var backend

  function init() {
    backend = createTemporaryObject(factory, this)
    verify(backend !== null)
    backend._nmcliPresent = true
    backend._wireguardPresent = true
    backend.profiles = [
      { name: "cloud", uuid: "cloud", kind: "wireguard", active: true },
      { name: "work-dev", uuid: "dev", kind: "wireguard", active: true },
      { name: "work-prod", uuid: "prod", kind: "wireguard", active: false }
    ]
  }

  function actionProcess() {
    for (var i = 0; i < backend.children.length; i++) {
      var child = backend.children[i]
      if (child.running === true && child.command && child.command[0] === "nmcli"
          && child.command[1] === "connection") return child
    }
    fail("No connection command started")
    return null
  }

  function test_connect_preserves_other_profiles() {
    backend.connectTo(backend.targets[2])
    compare(actionProcess().command, ["nmcli", "connection", "up", "uuid", "prod"])
    compare(backend.connected, true)
    compare(backend.summary, "cloud + work-dev")
  }

  function test_disconnect_one_leaves_other_connected() {
    backend.disconnectTarget(backend.targets[1])
    compare(actionProcess().command, ["nmcli", "connection", "down", "uuid", "dev"])
    backend.applyProfiles([
      { name: "cloud", uuid: "cloud", kind: "wireguard", active: true },
      { name: "work-dev", uuid: "dev", kind: "wireguard", active: false }
    ])
    compare(backend.connected, true)
    compare(backend.summary, "cloud")
  }

  function test_disconnect_all_names_only_active_profiles() {
    backend.disconnect()
    compare(actionProcess().command, ["nmcli", "connection", "down", "uuid", "cloud", "uuid", "dev"])
  }

  function test_failed_connect_keeps_other_status() {
    backend.connectTo(backend.targets[2])
    var process = actionProcess()
    process.stderr.text = "Activation failed"
    process.running = false
    process.exited(1, 0)
    compare(backend.connected, true)
    compare(backend.summary, "cloud + work-dev")
    verify(backend.lastError.indexOf("Activation failed") !== -1)
  }

  function test_addresses_enrich_rows_and_failed_read_clears_them() {
    backend.applyProfiles(backend.profiles)
    var process = null
    for (var i = 0; i < backend.children.length; i++) {
      var child = backend.children[i]
      if (child.command && child.command[3] === "GENERAL.UUID,IP4.ADDRESS,IP6.ADDRESS") process = child
    }
    verify(process !== null)
    compare(process.command, ["nmcli", "-t", "-f", "GENERAL.UUID,IP4.ADDRESS,IP6.ADDRESS", "connection", "show", "uuid", "cloud", "uuid", "dev"])
    process.stdout.text = "GENERAL.UUID:cloud\nIP4.ADDRESS[1]:10.9.0.2/32\n\nGENERAL.UUID:dev\nIP4.ADDRESS[1]:10.8.0.2/32"
    process.running = false
    process.exited(0, 0)
    compare(backend.targets[1].detail, "WireGuard\n10.8.0.2/32")
    compare(backend.details.length, 0)
    compare(backend.headline, "2 profiles connected")
    process.exited(1, 0)
    compare(backend.targets[1].detail, "WireGuard")
    compare(backend.connected, true)
  }

  function test_single_profile_hero_uses_summary() {
    compare(backend.headline, "2 profiles connected")
    backend.profiles = [backend.profiles[0]]
    compare(backend.headline, "")
    compare(backend.headline || backend.summary, "cloud")
    backend.profiles = []
    compare(backend.headline, "")
    compare(backend.headline || backend.summary, "No profiles")
  }

  function test_activation_does_not_move_rows() {
    var profiles = backend.profiles.slice()
    backend.applyProfiles([profiles[1], profiles[2], profiles[0]])
    compare(backend.targets.map(function(row) { return row.uuid }), ["cloud", "dev", "prod"])
    profiles[2].active = true
    profiles[0].active = false
    backend.applyProfiles([profiles[2], profiles[1], profiles[0]])
    compare(backend.targets.map(function(row) { return row.uuid }), ["cloud", "dev", "prod"])
  }
}
