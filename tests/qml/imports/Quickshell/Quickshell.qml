pragma Singleton
import QtQml

QtObject {
  function env(name) { return name === "HOME" ? "/home/test" : "" }
}
