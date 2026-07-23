import assert from "node:assert/strict";
import test from "node:test";

import { classifyDesktopIntent, normalizePointerArguments } from "./desktop-control-state.mjs";

test("accepts the declared point array", () => {
  assert.deepEqual(normalizePointerArguments({ action: "click", point: [450, 780] }), {
    action: "click",
    x: 450,
    y: 780,
  });
});

test("accepts legacy separate coordinates", () => {
  assert.deepEqual(normalizePointerArguments({ action: "move", x: 187, y: 53 }), {
    action: "move",
    x: 187,
    y: 53,
  });
});

test("accepts a VLM point packed into x", () => {
  assert.deepEqual(normalizePointerArguments({ action: "click", x: [819, 796] }), {
    action: "click",
    x: 819,
    y: 796,
  });
});

test("rejects missing or out-of-range coordinates", () => {
  assert.throws(() => normalizePointerArguments({ action: "click", point: [1001, 40] }));
  assert.throws(() => normalizePointerArguments({ action: "click", x: 10 }));
});

test("classifies pointer and typing requests", () => {
  assert.deepEqual(classifyDesktopIntent("Click the message field and write hello"), {
    request: "Click the message field and write hello",
    requiresTyping: true,
  });
  assert.deepEqual(classifyDesktopIntent("Open Settings"), {
    request: "Open Settings",
    requiresTyping: false,
  });
});

test("does not auto-enforce sensitive or conversational turns", () => {
  assert.equal(classifyDesktopIntent("Click send"), null);
  assert.equal(classifyDesktopIntent("Delete that message"), null);
  assert.equal(classifyDesktopIntent("What can you see?"), null);
});
