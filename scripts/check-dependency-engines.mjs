import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const require = createRequire(import.meta.url);
const sdkDirectory = fileURLToPath(
  new URL("../node_modules/@modelcontextprotocol/sdk/", import.meta.url)
);
const dependencyEntry = require.resolve("@hono/node-server", {
  paths: [sdkDirectory],
});
const dependency = JSON.parse(
  await readFile(new URL("../package.json", pathToFileURL(dependencyEntry)), "utf8")
);

assert.equal(
  root.engines?.node,
  ">=18.14.1",
  "the package must accurately declare its Node 18 patch-level minimum"
);
assert.equal(
  root.overrides?.["@hono/node-server"],
  "1.19.17",
  "the Node 18-compatible transport dependency must remain pinned"
);
assert.equal(
  dependency.version,
  "1.19.17",
  "installed @hono/node-server drifted from the reviewed Node 18-compatible release"
);
assert.equal(
  dependency.engines?.node,
  ">=18.14.1",
  "installed @hono/node-server no longer declares Node 18 compatibility"
);

console.log("dependency engines support Node >=18.14.1");
