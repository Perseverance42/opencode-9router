// Tests for the OpenCode v2 plugin adapter (default export).
// Verifies:
//   1. The dual default export exposes v2 shape (id + setup) and the v1
//      `server()` entrypoint.
//   2. setup() registers a default 9router provider when none configured.
//   3. setup() discovers models from a running 9Router API and publishes
//      them as v2 Model.Info entries (capabilities, limit, variants).
//   4. setup() enriches pre-configured 9router-family providers instead of
//      adding a default one.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scope the discovery cache to a throwaway dir so tests never touch the
// user's real ~/.cache/opencode-9router/ (must run before the plugin import).
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "opencode-9router-test-"));
const { default: plugin } = await import("./dist/plugin.js");

console.log("=== Test 1: dual default export shape ===");
assert.equal(typeof plugin.server, "function", "v1 entrypoint `server` must be exposed");
assert.equal(typeof plugin.setup, "function", "v2 entrypoint `setup` must be exposed");
assert.equal(plugin.id, "9router", "v2 definition must carry a stable id");

const v1Hooks = await plugin.server({ client: { app: { log: async () => {} } } });
assert.equal(typeof v1Hooks.config, "function", "server() must return v1 hooks");
console.log("PASS");

// ── Mock 9Router API ─────────────────────────────────────────
const modelsBody = {
  data: [
    { id: "executor", owned_by: "combo" },
    { id: "cc/claude-opus-4-7", owned_by: "claude-code" },
  ],
};
const infoBody = {
  executor: { id: "executor", capabilities: { vision: true, tools: true, reasoning: true } },
  "cc/claude-opus-4-7": {
    id: "cc/claude-opus-4-7",
    capabilities: { tools: true, reasoning: true },
  },
};

const mockServer = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(modelsBody));
  } else if (req.url === "/v1/models/info") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(infoBody));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const port = mockServer.address().port;
const mockBaseURL = `http://127.0.0.1:${port}`;

// ── Stub v2 provider registry ───────────────────────────────
class FakeEditor {
  constructor() {
    this.providers = new Map(); // id -> { info, models: [] }
    this.modelSets = []; // history of models.set calls
  }
  list() {
    return [...this.providers.values()].map((p) => ({ provider: p.info, models: p.models }));
  }
  get(id) {
    return this.list().find((r) => r.provider.id === id);
  }
  add({ info, models }) {
    this.providers.set(info.id, { info, models: [...(models ?? [])] });
  }
  update(id, fn) {
    fn(this.providers.get(id).info);
  }
  remove(id) {
    this.providers.delete(id);
  }
  models = {
    set: (id, models) => this.modelSets.push([id, models]),
    update: () => {},
    remove: () => {},
  };
}

function makeCtx(initialProviders) {
  const editor = new FakeEditor();
  for (const info of initialProviders) editor.add({ info, models: [] });
  const ctx = {
    provider: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: editor.list().map((r) => r.provider),
      }),
      transform: async (fn) => {
        fn(editor);
      },
      reload: async () => {},
    },
  };
  return { ctx, editor };
}

function fakeProviderInfo(id, settings) {
  return {
    id,
    name: id,
    activation: "enabled",
    package: "",
    settings: settings ?? {},
  };
}

console.log("\n=== Test 2: default provider registered when none configured ===");
const t2 = makeCtx([]);
await plugin.setup(t2.ctx);
const registered = t2.editor.get("9router");
assert.ok(registered, "default 9router provider must be registered");
assert.equal(registered.provider.name, "9Router");
assert.equal(registered.provider.activation, "enabled");
assert.ok(
  String(registered.provider.settings.baseURL).endsWith("/v1"),
  "settings.baseURL must be normalized with /v1 path"
);
// Discovery against the unreachable default endpoint fails gracefully and
// must NOT wipe any model inventory (nothing published on failure).
const set2 = t2.editor.modelSets.find(([id]) => id === "9router");
assert.equal(set2, undefined, "no models.set on discovery failure");
console.log("PASS");

console.log("\n=== Test 3: pre-configured 9router-family provider is enriched, not duplicated ===");
const custom = fakeProviderInfo("9router-pro", { baseURL: mockBaseURL });
const t3 = makeCtx([custom]);
await plugin.setup(t3.ctx);
assert.ok(t3.editor.get("9router-pro"), "pre-configured provider must survive");
assert.ok(!t3.editor.get("9router"), "no default provider added when family exists");
assert.equal(t3.editor.get("9router-pro").provider.package, "@opencode/ai/providers/openai-compatible", "package must be filled in");
const set3 = t3.editor.modelSets.find(([id]) => id === "9router-pro");
assert.ok(set3 && set3[1].length === 2, "discovered models must be published for the family provider");

// v2 Model.Info shape of a discovered combo model
const executor = set3[1].find((m) => m.id === "executor");
assert.ok(executor, "executor model must be present");
assert.equal(executor.capabilities.tools, true, "capabilities.tools required");
assert.deepEqual(
  [...executor.capabilities.input].sort(),
  ["audio", "image", "text"],
  "combo forced multimodal input"
);
assert.ok(executor.limit.context > 0, "limit.context must be a positive int");

// v2 Model.Info shape of a discovered prefixed model
const opus = set3[1].find((m) => m.id === "cc/claude-opus-4-7");
assert.ok(opus, "prefixed model must be present");
assert.deepEqual(opus.capabilities.input, ["text", "image"], "unspecified capability keeps v2 default input");
assert.ok(opus.limit.context > 0 && opus.limit.output > 0, "limit requires both bounds");
assert.equal(opus.status, "active", "default status is active");
assert.equal(typeof opus.name, "string", "display name present");
console.log("PASS");
console.log("PASS");

console.log("\n=== Test 4: family detection does not match unrelated providers ===");
const unrelated = fakeProviderInfo("anthropic", { apiKey: "x" });
const t4 = makeCtx([unrelated]);
await plugin.setup(t4.ctx);
assert.ok(t4.editor.get("anthropic"), "unrelated provider untouched");
assert.ok(t4.editor.get("9router"), "default provider registered alongside unrelated ones");
console.log("PASS");

await new Promise((resolve) => mockServer.close(resolve));
console.log("\n✅ All v2 adapter tests passed!");
