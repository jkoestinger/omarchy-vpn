// The model files are where every assumption about how a VPN CLI formats its
// output lives, and they are the only half of the widget that runs without a
// QML engine. This runs the suite over them:
//
//   node tests/run.js
//
// No dependencies and no test framework: the plugin ships no package.json and
// is not built, so a test suite that needed installing would not get run.
//
// Every tests/model/*.test.js file is picked up automatically, so adding a
// backend means adding a file here rather than editing this one.

const fs = require("fs")
const path = require("path")
const harness = require("./harness.js")

const dir = path.join(__dirname, "model")
const files = fs.readdirSync(dir).filter(name => name.endsWith(".test.js")).sort()

if (files.length === 0) {
  console.error("no test files found in tests/model/")
  process.exit(1)
}

for (const file of files) require(path.join(dir, file))

process.exit(harness.report())
