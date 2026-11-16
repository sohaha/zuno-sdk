import { test } from "node:test";
import assert from "node:assert/strict";
import { ZunoClient, type CreateSessionOptions } from "../dist/index.js";
import { startMockHarness } from "./mock-harness.ts";

const cases: { name: string; options?: string | CreateSessionOptions; prompt?: string; workingDir?: string }[] = [
  { name: "provided", options: { workingDir: "/project", systemPrompt: "Review precisely.\nKeep Unicode: λ" }, prompt: "Review precisely.\nKeep Unicode: λ", workingDir: "/project" },
  { name: "empty", options: { systemPrompt: "" }, prompt: "" },
  { name: "omitted", options: { workingDir: "/project" }, workingDir: "/project" },
  { name: "undefined", options: { systemPrompt: undefined } },
  { name: "default options", options: {} },
  { name: "no arguments" },
  { name: "legacy working directory", options: "/legacy", workingDir: "/legacy" },
];

for (const { name, options, prompt, workingDir } of cases) {
  test(`createSession system prompt wire behavior: ${name}`, async (t) => {
    const requests: any[] = [];
    const server = await startMockHarness({
      onRequest(req, send) {
        requests.push(req);
        send({ v: 1, reply_to: req.id, ev: "attached", session: { session_id: "created" } });
      },
    });
    t.after(() => server.close());
    const client = await ZunoClient.connect({ socketPath: server.socketPath });
    t.after(() => client.close());
    assert.equal((await client.createSession(options)).session_id, "created");
    assert.equal(requests.length, 1);
    const wire = requests[0];
    assert.equal(wire.req, "create_session");
    assert.equal(wire.working_dir, workingDir);
    assert.equal(wire.system_prompt, prompt);
    assert.equal(Object.hasOwn(wire, "system_prompt"), prompt !== undefined);
    assert.equal(Object.hasOwn(wire, "systemPrompt"), false);
  });
}

test("createSession forwards provider channel and builtin-skill switches", async (t) => {
  const requests: any[] = [];
  const server = await startMockHarness({
    onRequest(req, send) {
      requests.push(req);
      send({ v: 1, reply_to: req.id, ev: "attached", session: { session_id: "created" } });
    },
  });
  t.after(() => server.close());
  const client = await ZunoClient.connect({ socketPath: server.socketPath });
  t.after(() => client.close());

  await client.createSession({
    providerChannel: {
      channel_type: "anthropic-compatible",
      base_url: "https://llm.example.com/v1",
      api_key: "sk-test",
      default_model: "test-model",
    },
    disableBuiltinSkills: true,
    disableGlobalSkills: true,
  });
  assert.equal(requests.length, 1);
  const wire = requests[0];
  assert.equal(wire.provider_channel.base_url, "https://llm.example.com/v1");
  assert.equal(wire.provider_channel.channel_type, "anthropic-compatible");
  assert.equal(wire.provider_channel.api_key, "sk-test");
  assert.equal(wire.provider_channel.default_model, "test-model");
  assert.equal(wire.disable_builtin_skills, true);
  assert.equal(wire.disable_global_skills, true);

  // 缺省时不携带这两个字段，保持与 Rust SDK 一致的线上形状。
  requests.length = 0;
  await client.createSession({});
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0], "provider_channel"), false);
  assert.equal(Object.hasOwn(requests[0], "disable_builtin_skills"), false);
  assert.equal(Object.hasOwn(requests[0], "disable_global_skills"), false);
});
