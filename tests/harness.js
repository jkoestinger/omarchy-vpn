// Loads the split model files the way the QML engine does, and provides the
// three things a test file needs: `test`, `eq`, and the module namespaces.
//
// The model files are QML `.pragma library` scripts, which have no module
// system — just top-level declarations, plus an `.import` line naming the
// shared helpers. Neither directive is JavaScript, so both are stripped, and
// running what is left in this realm's global scope turns its declarations into
// globals. Collecting the names each file added gives back something shaped
// like a module. A fresh VM context would be tidier, but its arrays would carry
// that context's prototypes and every deepStrictEqual would fail on realm
// alone.
//
// Shared is loaded first and bound to a global of that name, which is what the
// `.import "Shared.js" as Shared` line resolves to inside the QML engine. That
// is the whole of the emulation: everything else is the real file.

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const MODEL = path.join(__dirname, "..", "model")

function load(file) {
  const source = fs.readFileSync(path.join(MODEL, file), "utf8")
    .replace(/^\s*\.pragma\s+library\s*$/m, "")
    .replace(/^\s*\.import\s+.*$/gm, "")

  const before = new Set(Object.getOwnPropertyNames(globalThis))
  vm.runInThisContext(source, { filename: "model/" + file })

  const namespace = {}
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!before.has(name)) namespace[name] = globalThis[name]
  }
  return namespace
}

const Shared = load("Shared.js")
globalThis.Shared = Shared

// Every model file beside Shared.js, so a new backend is picked up by dropping
// its file in rather than by editing this list.
const namespaces = { Shared: Shared }
for (const file of fs.readdirSync(MODEL).sort()) {
  if (!file.endsWith(".js") || file === "Shared.js") continue
  namespaces[path.basename(file, ".js")] = load(file)
}

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name: name, error: error })
  }
}

// Returns the process exit code rather than calling process.exit itself, so the
// runner stays the only thing that decides the suite is over.
function report() {
  for (const failure of failures) {
    console.error("FAIL  " + failure.name)
    console.error("      " + String(failure.error.message).split("\n").join("\n      "))
  }
  console.log(`${passed} passed, ${failures.length} failed`)
  return failures.length === 0 ? 0 : 1
}

module.exports = Object.assign({
  test: test,
  eq: assert.deepStrictEqual,
  report: report,
}, namespaces)
