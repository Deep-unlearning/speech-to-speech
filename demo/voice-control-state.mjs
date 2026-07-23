export const DEFAULT_APP_STATE = Object.freeze({
  theme: "ember",
  counter: 12,
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

export const VOICE_TOOLS = Object.freeze([
  {
    type: "function",
    name: "get_app_state",
    description: "Read the current visible application state before deciding what to change.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "set_theme",
    description: "Select the application's Ember, Tide, or Meadow theme. Use this when the user asks to click, press, choose, select, switch to, or change a named theme option.",
    parameters: {
      type: "object",
      properties: {
        theme: {
          type: "string",
          enum: ["ember", "tide", "meadow"],
          description: "The new visible theme.",
        },
      },
      required: ["theme"],
    },
  },
  {
    type: "function",
    name: "change_counter",
    description: "Set, increase, or decrease the large counter shown in the application.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["set", "increase", "decrease"] },
        amount: {
          type: "integer",
          minimum: 0,
          maximum: 99,
          description: "For set, the new value. Otherwise, the amount to add or subtract.",
        },
      },
      required: ["mode", "amount"],
    },
  },
  {
    type: "function",
    name: "open_panel",
    description: "Open the Overview, Activity, Launch Brief, or Settings panel. Use this when the user asks to click, press, choose, select, open, or go to a named panel tab.",
    parameters: {
      type: "object",
      properties: {
        panel: { type: "string", enum: ["overview", "activity", "brief", "settings"] },
      },
      required: ["panel"],
    },
  },
  {
    type: "function",
    name: "set_run_state",
    description: "Set the application's process state to ready, running, or paused.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["ready", "running", "paused"] },
      },
      required: ["state"],
    },
  },
  {
    type: "function",
    name: "set_brief_field",
    description: "Set exactly one Launch Brief field. Call once per field, then continue with the next requested field after the tool result.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["name", "email", "company", "goal", "budget", "priority", "updates"] },
        value: { type: "string", description: "The field value. Use yes/no for updates, normal/high for priority, and starter/growth/scale for budget." },
      },
      required: ["field", "value"],
    },
  },
  {
    type: "function",
    name: "get_unfilled_brief_fields",
    description: "Return required Launch Brief fields that are still missing or invalid. Use before asking a follow-up question or submitting an incomplete brief.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "submit_brief",
    description: "Submit the Launch Brief after the user explicitly asks to submit, create, or send the brief. This is a local demo submission and does not contact an external service.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "reset_brief",
    description: "Clear every field in the Launch Brief and return it to its defaults.",
    parameters: { type: "object", properties: {}, required: [] },
  },
]);

export const VOICE_INSTRUCTIONS = [
  "You control a small dashboard through the provided tools.",
  "Use tools for every requested UI change; never claim a change before its tool result arrives.",
  "Treat click, press, choose, and select as requests to perform the matching app action.",
  "Ember, Tide, and Meadow are theme controls; Overview, Activity, Launch Brief, and Settings are panel controls.",
  "Use set_brief_field with exactly one field per call. For a request with several fields, continue field by field after each tool result.",
  "For a multi-field request, call the next set_brief_field in the follow-up response until every requested field is updated; do not stop after the first field.",
  "Use get_unfilled_brief_fields before asking what is missing or when a brief is incomplete.",
  "Only use submit_brief when the user explicitly asks to submit, create, or send the brief; it is a local simulation.",
  "If submission validation fails, briefly ask for the missing fields.",
  "Never say you cannot click a named control when one of the provided tools represents it.",
  "Use get_app_state when the request depends on the current screen.",
  "After the requested tool sequence is complete, give one short spoken sentence confirming what is now visible.",
  "Keep confirmations under twelve words and do not list internal tool names.",
].join(" ");

const THEMES = new Set(["ember", "tide", "meadow"]);
const PANELS = new Set(["overview", "activity", "brief", "settings"]);
const RUN_STATES = new Set(["ready", "running", "paused"]);
const BRIEF_BUDGETS = new Set(["starter", "growth", "scale"]);
const BRIEF_PRIORITIES = new Set(["normal", "high"]);
const BRIEF_TEXT_FIELDS = Object.freeze({
  name: ["briefName", 80],
  email: ["briefEmail", 120],
  company: ["briefCompany", 100],
  goal: ["briefGoal", 300],
});
const BRIEF_LABELS = Object.freeze({
  name: "Name",
  email: "Email",
  company: "Company",
  goal: "Launch goal",
  budget: "Budget",
  priority: "Priority",
  updates: "Product updates",
});

export function getMissingBriefFields(state) {
  const missing = [];
  if (!String(state.briefName || "").trim()) missing.push("name");
  if (!/^\S+@\S+\.\S+$/.test(String(state.briefEmail || ""))) missing.push("email");
  if (!String(state.briefGoal || "").trim()) missing.push("goal");
  return missing;
}

export function buildAppStateContext(currentState) {
  const state = { ...DEFAULT_APP_STATE, ...currentState };
  const missing = getMissingBriefFields(state);
  return [
    "Visible app state update.",
    `panel=${state.panel}; theme=${state.theme}; counter=${state.counter}; process=${state.runState}.`,
    `Brief: name=${state.briefName || "<empty>"}; email=${state.briefEmail || "<empty>"}; company=${state.briefCompany || "<empty>"}; goal=${state.briefGoal || "<empty>"}; budget=${state.briefBudget}; priority=${state.briefPriority}; updates=${state.briefUpdates ? "yes" : "no"}; submitted=${state.briefSubmitted ? "yes" : "no"}.`,
    `Missing required brief fields: ${missing.length ? missing.join(", ") : "none"}.`,
  ].join(" ");
}

function result(ok, state, message) {
  return { ok, state: { ...state }, message };
}

export function executeVoiceTool(currentState, name, args = {}) {
  const state = { ...DEFAULT_APP_STATE, ...currentState };

  if (name === "get_app_state") {
    return result(true, state, "Current application state returned.");
  }

  if (name === "set_theme") {
    if (!THEMES.has(args.theme)) return result(false, state, "Unknown theme.");
    state.theme = args.theme;
    return result(true, state, `Theme changed to ${state.theme}.`);
  }

  if (name === "change_counter") {
    if (!["set", "increase", "decrease"].includes(args.mode) || !Number.isInteger(args.amount)) {
      return result(false, state, "Counter mode and integer amount are required.");
    }
    if (args.amount < 0 || args.amount > 99) {
      return result(false, state, "Counter amount must be between zero and ninety-nine.");
    }
    const next = args.mode === "set"
      ? args.amount
      : state.counter + (args.mode === "increase" ? args.amount : -args.amount);
    state.counter = Math.max(0, Math.min(99, next));
    return result(true, state, `Counter is now ${state.counter}.`);
  }

  if (name === "open_panel") {
    if (!PANELS.has(args.panel)) return result(false, state, "Unknown panel.");
    state.panel = args.panel;
    return result(true, state, `${state.panel} panel opened.`);
  }

  if (name === "set_run_state") {
    if (!RUN_STATES.has(args.state)) return result(false, state, "Unknown process state.");
    state.runState = args.state;
    return result(true, state, `Process is now ${state.runState}.`);
  }

  if (name === "set_brief_field") {
    const field = args.field;
    if (!(field in BRIEF_LABELS) || typeof args.value !== "string") {
      return result(false, state, "A supported field and text value are required.");
    }
    const value = args.value.trim();
    if (field in BRIEF_TEXT_FIELDS) {
      const [stateKey, maxLength] = BRIEF_TEXT_FIELDS[field];
      if (!value || value.length > maxLength) {
        return result(false, state, `${BRIEF_LABELS[field]} must be between 1 and ${maxLength} characters.`);
      }
      if (field === "email" && !/^\S+@\S+\.\S+$/.test(value)) {
        return result(false, state, "Email must be a valid address.");
      }
      state[stateKey] = value;
    } else if (field === "budget") {
      const normalized = value.toLowerCase();
      if (!BRIEF_BUDGETS.has(normalized)) return result(false, state, "Budget must be starter, growth, or scale.");
      state.briefBudget = normalized;
    } else if (field === "priority") {
      const normalized = value.toLowerCase();
      if (!BRIEF_PRIORITIES.has(normalized)) return result(false, state, "Priority must be normal or high.");
      state.briefPriority = normalized;
    } else if (field === "updates") {
      const normalized = value.toLowerCase();
      if (!["yes", "no", "on", "off", "true", "false"].includes(normalized)) {
        return result(false, state, "Product updates must be yes or no.");
      }
      state.briefUpdates = ["yes", "on", "true"].includes(normalized);
    }
    state.panel = "brief";
    state.briefSubmitted = false;
    return result(true, state, `${BRIEF_LABELS[field]} updated.`);
  }

  if (name === "get_unfilled_brief_fields") {
    const missing = getMissingBriefFields(state);
    return result(
      true,
      state,
      missing.length ? `Missing required fields: ${missing.join(", ")}.` : "All required brief fields are complete.",
    );
  }

  if (name === "submit_brief") {
    const missing = getMissingBriefFields(state);
    state.panel = "brief";
    if (missing.length) return result(false, state, `Add ${missing.join(", ")} before submitting.`);
    state.briefSubmitted = true;
    return result(true, state, `Launch brief created for ${state.briefName}.`);
  }

  if (name === "reset_brief") {
    state.panel = "brief";
    state.briefName = "";
    state.briefEmail = "";
    state.briefCompany = "";
    state.briefGoal = "";
    state.briefBudget = "growth";
    state.briefPriority = "normal";
    state.briefUpdates = false;
    state.briefSubmitted = false;
    return result(true, state, "Launch brief cleared.");
  }

  return result(false, state, `Unknown tool: ${name}.`);
}
