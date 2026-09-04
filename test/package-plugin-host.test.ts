import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVrevServer } from "../src/index.js";

test("a directly depended-on package server is started and routed without a legacy plugin copy", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-package-host-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Package host</h1>");
  const plugin = path.join(root, "node_modules/@fixture/package-server");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@fixture/package-server": "1.0.0" } }));
  writeFileSync(path.join(plugin, "package.json"), JSON.stringify({
    name: "@fixture/package-server",
    version: "1.0.0",
    type: "module",
    vrev: { apiVersion: 1, manifest: "./vrev.plugin.json" },
  }));
  writeFileSync(path.join(plugin, "README.md"), "# Package server\n");
  writeFileSync(path.join(plugin, "contract.json"), JSON.stringify({
    schema_version: 1,
    queries: [{
      name: "fixture.get",
      permission: "fixture.read",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      resources: ["fixture"],
    }],
    commands: [],
  }));
  writeFileSync(path.join(plugin, "server.js"), `export default {
    apiVersion: 1,
    create() {
      return {
        start() {},
        async query(name, request) { return name === "fixture.get" ? { ok: true, data: { value: "from-package" } } : { ok: false, error: { code: "NOT_FOUND", message: "missing", retryable: false, request_id: request.request_id } }; },
        async command(_name, request) { return { ok: false, error: { code: "NOT_FOUND", message: "missing", retryable: false, request_id: request.request_id } }; },
        stop() {}
      };
    }
  };\n`);
  writeFileSync(path.join(plugin, "vrev.plugin.json"), JSON.stringify({
    schema_version: 4,
    id: "package-server",
    version: "1.0.0",
    display: { title: "Package server", summary: "Direct package fixture", readme: "./README.md" },
    configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server.js", contract: "./contract.json" },
    requires: [],
    provides: [],
  }));

  const vrev = createVrevServer({ projectRoot: root, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => vrev.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = vrev.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugin-host/v1/plugins/package-server/queries/fixture.get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: "package-query", input: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { value: "from-package" } });
  } finally {
    await vrev.close();
  }
});
