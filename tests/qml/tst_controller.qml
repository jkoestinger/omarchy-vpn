import QtQuick
import QtTest
import "../.." as Plugin

TestCase {
  name: "IndependentProfileController"
  Component { id: factory; Plugin.VpnController {} }
  property var controller
  property var calls
  property var backend

  function init() {
    controller = createTemporaryObject(factory, this)
    verify(controller !== null)
    calls = []
    backend = {
      backendId: "test", independentTargets: true, allowConcurrent: true,
      busy: false,
      connectTo: function(target) { calls.push("up:" + target.key) },
      disconnectTarget: function(target) { calls.push("down:" + target.key) }
    }
  }

  function test_ipc_connect_does_not_toggle_active_profile() {
    controller.connectVia(backend, { key: "dev", active: true })
    compare(calls, [])
    controller.connectVia(backend, { key: "prod", active: false })
    compare(calls, ["up:prod"])
  }

  function test_click_toggles_only_selected_profile() {
    controller.toggleTarget(backend, { key: "dev", active: true })
    controller.toggleTarget(backend, { key: "prod", active: false })
    compare(calls, ["down:dev", "up:prod"])
  }
}
