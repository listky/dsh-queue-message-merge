import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { buildMergePlan, mergeQueuedMessages } from "./client.source.mjs";

const message = (id, ...texts) => ({
  id,
  role: "user",
  content: texts.map((text) => ({ type: "text", text }))
});

function makeGuard(initiallyLocked = false) {
  let locked = initiallyLocked;
  const calls = [];
  return {
    calls,
    get locked() { return locked; },
    isLocked() { return locked; },
    lock() { calls.push("lock"); locked = true; },
    unlock() { calls.push("unlock"); locked = false; }
  };
}

function makeSession(initialInbox, { failAt, throwAt, unknownReceiptAt, suppressProjectionAt, onSubscribe } = {}) {
  let inbox = structuredClone(initialInbox);
  const listeners = new Set();
  const calls = [];
  let callNumber = 0;
  const setInbox = (next) => {
    inbox = next;
    for (const listener of listeners) listener();
  };
  const projection = {
    getSnapshot: () => inbox,
    subscribe(listener) {
      listeners.add(listener);
      onSubscribe?.({ getInbox: () => inbox, setInbox });
      return () => listeners.delete(listener);
    }
  };
  const session = {
    sessionId: "session-test",
    projections: { faceOf: () => projection },
    async updateQueue(id, action) {
      callNumber += 1;
      calls.push({ id, action });
      if (callNumber === throwAt) throw new Error("injected transport failure");
      if (callNumber === failAt) return { ok: false, error: { code: "test/failure", message: "injected rejection" } };

      const messages = inbox["next-turn"];
      const index = messages.findIndex((item) => item.id === id);
      if (index < 0) return { ok: false, error: { code: "session/queue-item-not-found", message: "missing" } };

      if (action.kind === "edit") {
        const nextInbox = {
          ...inbox,
          "next-turn": messages.map((item, i) => i === index ? { ...item, content: action.content } : item)
        };
        if (callNumber !== suppressProjectionAt) setInbox(nextInbox);
      } else if (action.kind === "remove") {
        const nextInbox = { ...inbox, "next-turn": messages.filter((item) => item.id !== id) };
        if (callNumber !== suppressProjectionAt) setInbox(nextInbox);
      } else {
        throw new Error(`Unexpected action: ${action.kind}`);
      }

      // Simulate a server applying the edit but its acknowledgement being lost.
      if (callNumber === unknownReceiptAt) return undefined;
      return { ok: true, value: { accepted: true } };
    }
  };
  return { session, calls, getInbox: () => inbox };
}

test("builds an order-preserving plan from ordinary next-turn text only", () => {
  const inbox = {
    "next-turn": [message("q1", "第一", "条"), message("q2", "第二")],
    "next-step": [message("steer", "不可触碰")]
  };
  const plan = buildMergePlan(inbox);
  assert.equal(plan.ok, true);
  assert.equal(plan.combined, "第一条;第二");
  assert.deepEqual(plan.items, [
    { id: "q1", text: "第一条" },
    { id: "q2", text: "第二" }
  ]);
});

test("does not treat steering as an ordinary queued message", () => {
  const plan = buildMergePlan({ "next-turn": [], "next-step": [message("s1", "steering")] });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "too-few");
  assert.equal(plan.count, 0);
});

test("fails closed for attachments, non-text blocks, blank text, and unstable IDs", () => {
  const attachment = { id: "q2", role: "user", content: [{ type: "file", file: { name: "x.txt" } }] };
  assert.equal(buildMergePlan({ "next-turn": [message("q1", "ok"), attachment] }).reason, "unsupported");
  assert.equal(buildMergePlan({ "next-turn": [message("q1", "ok"), message("q2", "  ")] }).reason, "unsupported");
  assert.equal(buildMergePlan({ "next-turn": [message("q1", "one"), message("q1", "two")] }).reason, "unsupported");
  assert.equal(buildMergePlan({ "next-turn": [message("q1", "one"), { role: "user", content: [{ type: "text", text: "two" }] }] }).reason, "unsupported");
});

test("writes recovery lock before edit, then removes remaining IDs and leaves one queued item", async () => {
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B"), message("q3", "C")],
    "next-step": [message("s1", "untouched")]
  });
  const plan = buildMergePlan(getInbox());
  const guard = makeGuard();
  const result = await mergeQueuedMessages(session, plan, guard);

  assert.deepEqual(result, { status: "success" });
  assert.deepEqual(calls, [
    { id: "q1", action: { kind: "edit", content: [{ type: "text", text: "A;B;C" }] } },
    { id: "q2", action: { kind: "remove" } },
    { id: "q3", action: { kind: "remove" } }
  ]);
  assert.deepEqual(getInbox()["next-turn"], [message("q1", "A;B;C")]);
  assert.deepEqual(getInbox()["next-step"], [message("s1", "untouched")]);
  assert.deepEqual(guard.calls, ["lock", "unlock"]);
  assert.equal(guard.locked, false);
});

test("clears the recovery lock after an explicit first-edit rejection", async () => {
  const original = { "next-turn": [message("q1", "A"), message("q2", "B")] };
  const { session, calls, getInbox } = makeSession(original, { failAt: 1 });
  const guard = makeGuard();
  const result = await mergeQueuedMessages(session, buildMergePlan(getInbox()), guard);

  assert.deepEqual(result, { status: "edit-failed" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.kind, "edit");
  assert.deepEqual(getInbox(), original);
  assert.deepEqual(guard.calls, ["lock", "unlock"]);
  assert.equal(guard.locked, false);
});

test("retains the recovery lock after a remove failure and blocks a retry", async () => {
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B"), message("q3", "C")]
  }, { failAt: 2 });
  const plan = buildMergePlan(getInbox());
  const guard = makeGuard();
  const result = await mergeQueuedMessages(session, plan, guard);

  assert.deepEqual(result, { status: "partial" });
  assert.deepEqual(calls.map((call) => call.action.kind), ["edit", "remove"]);
  assert.equal(guard.locked, true);
  assert.deepEqual(getInbox()["next-turn"], [message("q1", "A;B;C"), message("q2", "B"), message("q3", "C")]);

  assert.deepEqual(await mergeQueuedMessages(session, plan, guard), { status: "recovery-required" });
  assert.equal(calls.length, 2, "a retry must not issue another edit or removal");
});

test("locks after an applied edit with an unknown acknowledgement and blocks duplicate retry", async () => {
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B")]
  }, { unknownReceiptAt: 1 });
  const plan = buildMergePlan(getInbox());
  const guard = makeGuard();

  assert.deepEqual(await mergeQueuedMessages(session, plan, guard), { status: "uncertain" });
  assert.equal(guard.locked, true);
  assert.deepEqual(getInbox()["next-turn"], [message("q1", "A;B"), message("q2", "B")]);

  assert.deepEqual(await mergeQueuedMessages(session, plan, guard), { status: "recovery-required" });
  assert.equal(calls.length, 1, "a lost acknowledgement must not duplicate the combined text");
});

test("keeps the recovery lock after an accepted removal with stale projection and blocks retry", async () => {
  let resolveSubscribed;
  const subscribed = new Promise((resolve) => { resolveSubscribed = resolve; });
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B")]
  }, {
    suppressProjectionAt: 2,
    onSubscribe: () => resolveSubscribed()
  });
  const plan = buildMergePlan(getInbox());
  const guard = makeGuard();
  const mergePromise = mergeQueuedMessages(session, plan, guard);

  await subscribed;
  assert.deepEqual(await mergePromise, { status: "partial" });
  assert.equal(guard.locked, true);
  assert.deepEqual(calls.map((call) => call.action.kind), ["edit", "remove"]);
  assert.deepEqual(getInbox()["next-turn"], [message("q1", "A;B"), message("q2", "B")]);

  assert.deepEqual(await mergeQueuedMessages(session, plan, guard), { status: "recovery-required" });
  assert.equal(calls.length, 2, "a stale projection after accepted remove must not trigger retry writes");
});

test("locks after a thrown request because the server may have applied it", async () => {
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B")]
  }, { throwAt: 1 });
  const guard = makeGuard();

  assert.deepEqual(await mergeQueuedMessages(session, buildMergePlan(getInbox()), guard), { status: "uncertain" });
  assert.equal(guard.locked, true);
  assert.equal(calls.length, 1);
});

test("rejects a stale plan before locking or mutating", async () => {
  const { session, calls, getInbox } = makeSession({ "next-turn": [message("q1", "A"), message("q2", "B")] });
  const plan = buildMergePlan(getInbox());
  getInbox()["next-turn"][1] = message("q2", "changed");
  const guard = makeGuard();

  assert.deepEqual(await mergeQueuedMessages(session, plan, guard), { status: "changed" });
  assert.equal(calls.length, 0);
  assert.deepEqual(guard.calls, []);
});

test("stops when a new queued message appears during merge and keeps the guard locked", async () => {
  let injected = false;
  const { session, calls, getInbox } = makeSession({
    "next-turn": [message("q1", "A"), message("q2", "B")]
  }, {
    onSubscribe: ({ getInbox: currentInbox, setInbox }) => {
      if (injected) return;
      injected = true;
      queueMicrotask(() => {
        const current = currentInbox();
        setInbox({ ...current, "next-turn": [...current["next-turn"], message("q3", "arrived")] });
      });
    }
  });
  const guard = makeGuard();
  const result = await mergeQueuedMessages(session, buildMergePlan(getInbox()), guard);

  assert.deepEqual(result, { status: "partial" });
  assert.deepEqual(calls.map((call) => call.action.kind), ["edit"]);
  assert.deepEqual(getInbox()["next-turn"], [
    message("q1", "A;B"),
    message("q2", "B"),
    message("q3", "arrived")
  ]);
  assert.equal(guard.locked, true);
});

test("requires a recovery guard instead of mutating without one", async () => {
  const { session, calls, getInbox } = makeSession({ "next-turn": [message("q1", "A"), message("q2", "B")] });
  assert.deepEqual(await mergeQueuedMessages(session, buildMergePlan(getInbox())), { status: "guard-unavailable" });
  assert.equal(calls.length, 0);
});

test("generated Client entry resolves React, store, and Toast from the ModuleLoader", async () => {
  const clientSource = await readFile(new URL("./client.js", import.meta.url), "utf8");
  const reactStub = { Fragment: "fragment", createElement() {}, useState() {} };
  const moduleStubs = {
    react: reactStub,
    "@deepseek-ai/dsh-client-store": {
      defineStore(spec) { return { spec }; }
    },
    "@deepseek-ai/dsh-client-ui-primitives": {
      Toast() {}
    }
  };
  let moduleExports;
  const context = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          moduleExports = definition.factory((name) => {
            assert.ok(Object.hasOwn(moduleStubs, name), `unexpected ModuleLoader dependency: ${name}`);
            return moduleStubs[name];
          });
        }
      }
    }
  };

  runInNewContext(clientSource, context);
  assert.equal(typeof moduleExports.apply, "function");
  assert.equal(typeof moduleExports.mergeQueuedMessages, "function");

  let registration;
  const scope = {
    slots: {
      inject(_name, register) { register(); },
      register(options, component) { registration = { options, component }; return () => {}; }
    },
    sessions: { binding() { return undefined; } }
  };
  moduleExports.apply({
    effect(callback) { return callback(); },
    locale: { register() { return () => {}; } },
    inject(_dependencies, callback) { callback(scope); }
  });
  assert.equal(registration.options.store.spec.persist, "dsh.queue-message-merge.recovery.v1");
  assert.equal(registration.options.store.spec.init().recoveryRequired, false);
  assert.equal(typeof registration.options.store.spec.actions.requireRecovery, "function");
  assert.equal(typeof registration.options.store.spec.actions.clearRecovery, "function");
  assert.equal(typeof registration.component, "function");
});

test("queue control remains a compact icon and uses visible recovery Toast feedback", async () => {
  const source = await readFile(new URL("./client.source.mjs", import.meta.url), "utf8");
  assert.match(source, /return React\.createElement\(\s*React\.Fragment/);
  assert.match(source, /React\.createElement\(\s*"button"/);
  assert.match(source, /width: "30px"/);
  assert.match(source, /title: tooltip/);
  assert.match(source, /tooltip: "Merge \{count\} queued messages\."/);
  assert.match(source, /React\.createElement\(Toast/);
  assert.match(source, /store: recoveryStore/);
  assert.match(source, /guard\.lock\(\)/);
  assert.doesNotMatch(source, /aria-description/);
  assert.doesNotMatch(source, /React\.createElement\(\s*"span"/);
});

test("plugin source contains no direct send, prompt, network, or dynamic-evaluation path", async () => {
  const source = await readFile(new URL("./client.source.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.prompt\s*\(|\.send\s*\(|\bfetch\s*\(|XMLHttpRequest|\beval\s*\(|new Function\s*\(/);
});
