pragma Singleton
import QtQml

QtObject {
  // Processes are inert; preserve quoting for command construction only.
  function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'" }
}
