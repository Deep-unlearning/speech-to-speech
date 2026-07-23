import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppStateContext,
  DEFAULT_APP_STATE,
  executeVoiceTool,
  getMissingBriefFields,
} from "./voice-control-state.mjs";

test("changes theme without mutating the input state", () => {
  const input = { ...DEFAULT_APP_STATE };
  const output = executeVoiceTool(input, "set_theme", { theme: "tide" });

  assert.equal(output.ok, true);
  assert.equal(output.state.theme, "tide");
  assert.equal(input.theme, "ember");
});

test("counter changes are clamped to the visible range", () => {
  const high = executeVoiceTool(DEFAULT_APP_STATE, "change_counter", { mode: "increase", amount: 99 });
  const low = executeVoiceTool(DEFAULT_APP_STATE, "change_counter", { mode: "decrease", amount: 99 });

  assert.equal(high.state.counter, 99);
  assert.equal(low.state.counter, 0);
});

test("rejects invalid tool arguments without changing state", () => {
  const output = executeVoiceTool(DEFAULT_APP_STATE, "open_panel", { panel: "billing" });

  assert.equal(output.ok, false);
  assert.deepEqual(output.state, DEFAULT_APP_STATE);
});

test("returns a complete state snapshot", () => {
  const output = executeVoiceTool({ theme: "meadow", counter: 7 }, "get_app_state");

  assert.deepEqual(output.state, {
    theme: "meadow",
    counter: 7,
    panel: "overview",
    runState: "ready",
    briefName: "",
    briefEmail: "",
    briefCompany: "",
    briefGoal: "",
    briefBudget: "growth",
    briefPriority: "normal",
    briefUpdates: false,
    briefSubmitted: false,
  });
});

test("updates one brief field while preserving the others", () => {
  const output = executeVoiceTool(
    { ...DEFAULT_APP_STATE, briefCompany: "Acme" },
    "set_brief_field",
    { field: "name", value: "Maya" },
  );

  assert.equal(output.ok, true);
  assert.equal(output.state.panel, "brief");
  assert.equal(output.state.briefName, "Maya");
  assert.equal(output.state.briefCompany, "Acme");
  assert.equal(output.state.briefPriority, "normal");
});

test("normalizes structured brief fields", () => {
  const priority = executeVoiceTool(DEFAULT_APP_STATE, "set_brief_field", { field: "priority", value: "HIGH" });
  const updates = executeVoiceTool(DEFAULT_APP_STATE, "set_brief_field", { field: "updates", value: "yes" });
  assert.equal(priority.state.briefPriority, "high");
  assert.equal(updates.state.briefUpdates, true);
});

test("validates and submits a complete brief", () => {
  const incomplete = executeVoiceTool(DEFAULT_APP_STATE, "submit_brief");
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.message, /name/);

  const complete = executeVoiceTool(
    {
      ...DEFAULT_APP_STATE,
      briefName: "Maya",
      briefEmail: "maya@example.com",
      briefGoal: "Launch Orbit",
    },
    "submit_brief",
  );
  assert.equal(complete.ok, true);
  assert.equal(complete.state.briefSubmitted, true);
});

test("resets the brief to its defaults", () => {
  const output = executeVoiceTool(
    { ...DEFAULT_APP_STATE, briefName: "Maya", briefBudget: "scale", briefUpdates: true },
    "reset_brief",
  );
  assert.equal(output.state.briefName, "");
  assert.equal(output.state.briefBudget, "growth");
  assert.equal(output.state.briefUpdates, false);
});

test("reports missing fields and builds model context", () => {
  const state = { ...DEFAULT_APP_STATE, briefName: "Maya", briefEmail: "maya@example.com" };
  assert.deepEqual(getMissingBriefFields(state), ["goal"]);
  assert.match(buildAppStateContext(state), /Missing required brief fields: goal/);

  const output = executeVoiceTool(state, "get_unfilled_brief_fields");
  assert.equal(output.message, "Missing required fields: goal.");
});
