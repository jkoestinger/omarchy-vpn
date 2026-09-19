import QtQuick
// Hermetic process double: never launches a command or touches networking.
Item {
  property var command: []
  property bool running: false
  property QtObject stdout
  property QtObject stderr
  signal exited(int exitCode, int exitStatus)
}
