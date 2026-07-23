// @ts-check

import { S2sWsRealtimeClient } from "./ws/s2s-ws-client.js";
import {
  buildAppStateContext,
  DEFAULT_APP_STATE,
  getMissingBriefFields,
  VOICE_INSTRUCTIONS,
  VOICE_TOOLS,
  executeVoiceTool,
} from "./voice-control-state.mjs";

const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};
const FALLBACK_WS_URL = "ws://localhost:8765/v1/realtime";

const $ = (selector) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const voiceButton = /** @type {HTMLButtonElement} */ ($("#voice-button"));
const voiceDock = /** @type {HTMLElement} */ ($(".voice-dock"));
const voiceKicker = /** @type {HTMLElement} */ ($("#voice-kicker"));
const voiceCaption = /** @type {HTMLElement} */ ($("#voice-caption"));
const connectionPill = /** @type {HTMLElement} */ ($(".connection-pill"));
const connectionLabel = /** @type {HTMLElement} */ ($("#connection-label"));
const transcriptFeed = /** @type {HTMLElement} */ ($("#transcript-feed"));
const activityList = /** @type {HTMLOListElement} */ ($("#activity-list"));
const ledgerCount = /** @type {HTMLElement} */ ($("#ledger-count"));
const errorDialog = /** @type {HTMLDialogElement} */ ($("#error-dialog"));
const errorMessage = /** @type {HTMLElement} */ ($("#error-message"));
const ghostCursor = /** @type {HTMLElement} */ ($("#ghost-cursor"));
const ghostCursorLabel = /** @type {HTMLElement} */ ($("#ghost-cursor-label"));
const briefForm = /** @type {HTMLFormElement} */ ($("#brief-form"));

let appState = { ...DEFAULT_APP_STATE };
const requestedPanel = new URLSearchParams(window.location.search).get("panel");
if (["overview", "activity", "brief", "settings"].includes(requestedPanel || "")) {
  appState.panel = requestedPanel;
}
let client = /** @type {S2sWsRealtimeClient | null} */ (null);
let micStream = /** @type {MediaStream | null} */ (null);
let actionCount = 0;
let stopping = false;
const transcriptNodes = new Map();
let cursorPosition = null;
let cursorTimers = [];
let contextSyncTimer = 0;

function renderAppState() {
  document.body.dataset.theme = appState.theme;
  $("#counter-value").textContent = String(appState.counter);
  $("#run-state").textContent = appState.runState[0].toUpperCase() + appState.runState.slice(1);
  const widths = { ready: "32%", running: "68%", paused: "100%" };
  /** @type {HTMLElement} */ ($("#state-track-fill")).style.width = widths[appState.runState];

  document.querySelectorAll("[data-panel]").forEach((element) => {
    element.classList.toggle("active", element.getAttribute("data-panel") === appState.panel);
  });
  document.querySelectorAll("[data-panel-target]").forEach((element) => {
    element.classList.toggle("active", element.getAttribute("data-panel-target") === appState.panel);
  });
  document.querySelectorAll("[data-theme-target]").forEach((element) => {
    element.classList.toggle("active", element.getAttribute("data-theme-target") === appState.theme);
  });

  /** @type {HTMLInputElement} */ ($("#brief-name")).value = appState.briefName;
  /** @type {HTMLInputElement} */ ($("#brief-email")).value = appState.briefEmail;
  /** @type {HTMLInputElement} */ ($("#brief-company")).value = appState.briefCompany;
  /** @type {HTMLTextAreaElement} */ ($("#brief-goal")).value = appState.briefGoal;
  const selectedBudget = briefForm.querySelector(`input[name="budget"][value="${appState.briefBudget}"]`);
  if (selectedBudget instanceof HTMLInputElement) selectedBudget.checked = true;
  /** @type {HTMLInputElement} */ ($("#brief-priority")).checked = appState.briefPriority === "high";
  /** @type {HTMLInputElement} */ ($("#brief-updates")).checked = appState.briefUpdates;
  renderBriefSummary();
}

function renderBriefSummary() {
  const validEmail = /^\S+@\S+\.\S+$/.test(appState.briefEmail);
  const complete = Boolean(appState.briefName && validEmail && appState.briefGoal);
  const briefState = /** @type {HTMLElement} */ ($("#brief-state"));
  briefState.dataset.complete = String(complete);
  briefState.querySelector("span").textContent = appState.briefSubmitted ? "Created" : complete ? "Ready" : "Draft";

  const missing = getMissingBriefFields(appState);
  const completed = 3 - missing.length;
  $("#brief-progress-count").textContent = `${completed} of 3 complete`;
  /** @type {HTMLElement} */ ($("#brief-progress-fill")).style.width = `${(completed / 3) * 100}%`;
  const fieldLabels = { name: "Name", email: "Email", goal: "Launch goal" };
  $("#brief-missing-fields").replaceChildren(...Object.entries(fieldLabels).map(([field, label]) => {
    const chip = document.createElement("span");
    chip.textContent = label;
    chip.classList.toggle("complete", !missing.includes(field));
    return chip;
  }));

  const receipt = /** @type {HTMLElement} */ ($("#brief-receipt"));
  receipt.classList.toggle("submitted", appState.briefSubmitted);
  const identity = appState.briefCompany || appState.briefName;
  $("#receipt-monogram").textContent = identity ? identity.trim().charAt(0).toUpperCase() : "?";
  $("#receipt-company").textContent = appState.briefCompany || "Not set";
  $("#receipt-budget").textContent = appState.briefBudget;
  $("#receipt-priority").textContent = appState.briefPriority;
  if (appState.briefSubmitted) {
    $("#receipt-title").textContent = "Brief received.";
    $("#receipt-copy").textContent = `${appState.briefName}, your local demo brief is ready.`;
    $("#receipt-quote").textContent = appState.briefGoal;
  } else {
    $("#receipt-title").textContent = "Build it out loud.";
    $("#receipt-copy").textContent = "Try one natural command with several details:";
    $("#receipt-quote").textContent = '"Set my name to Maya, company Northstar, budget to scale, and make it high priority."';
  }
}

function syncBriefFromForm() {
  const budget = briefForm.querySelector('input[name="budget"]:checked');
  appState = {
    ...appState,
    briefName: /** @type {HTMLInputElement} */ ($("#brief-name")).value,
    briefEmail: /** @type {HTMLInputElement} */ ($("#brief-email")).value,
    briefCompany: /** @type {HTMLInputElement} */ ($("#brief-company")).value,
    briefGoal: /** @type {HTMLTextAreaElement} */ ($("#brief-goal")).value,
    briefBudget: budget instanceof HTMLInputElement ? budget.value : "growth",
    briefPriority: /** @type {HTMLInputElement} */ ($("#brief-priority")).checked ? "high" : "normal",
    briefUpdates: /** @type {HTMLInputElement} */ ($("#brief-updates")).checked,
    briefSubmitted: false,
  };
  renderBriefSummary();
  scheduleStateContext();
}

function scheduleStateContext() {
  clearTimeout(contextSyncTimer);
  contextSyncTimer = setTimeout(() => {
    client?.sendSystemContext(buildAppStateContext(appState));
  }, 350);
}

function showActionToast(message, ok = true) {
  const stack = $("#toast-stack");
  const toast = document.createElement("div");
  toast.className = `action-toast${ok ? "" : " error"}`;
  const mark = document.createElement("i");
  const text = document.createElement("span");
  mark.textContent = ok ? "OK" : "!";
  text.textContent = message;
  toast.append(mark, text);
  stack.append(toast);
  setTimeout(() => toast.classList.add("leaving"), 2600);
  setTimeout(() => toast.remove(), 2900);
}

function addActivity(message) {
  activityList.querySelector(".activity-empty")?.remove();
  const item = document.createElement("li");
  const text = document.createElement("span");
  const time = document.createElement("time");
  text.textContent = message;
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
  item.append(text, time);
  activityList.prepend(item);
  actionCount += 1;
  ledgerCount.textContent = `${actionCount} action${actionCount === 1 ? "" : "s"}`;
}

function elementCenter(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function isVisible(element) {
  return Boolean(element && element.getClientRects().length);
}

function voiceActionTarget(name, state, args = {}) {
  if (name === "open_panel") {
    return document.querySelector(`[data-panel-target="${state.panel}"]`);
  }
  if (name === "set_theme") {
    const swatch = document.querySelector(`[data-theme-target="${state.theme}"]`);
    return isVisible(swatch) ? swatch : $(".brand-mark");
  }
  if (name === "change_counter") {
    const card = document.querySelector(".counter-card");
    return isVisible(card) ? card : document.querySelector('[data-panel-target="overview"]');
  }
  if (name === "set_run_state") {
    const card = document.querySelector(".status-card");
    return isVisible(card) ? card : document.querySelector('[data-panel-target="overview"]');
  }
  if (name === "set_brief_field") {
    return document.querySelector(`[data-brief-target="${args.field || "goal"}"]`);
  }
  if (name === "submit_brief") return $("#brief-submit");
  if (name === "reset_brief") return $("#brief-reset");
  return null;
}

function moveGhostCursor(target, label) {
  if (!(target instanceof HTMLElement)) return;
  cursorTimers.forEach((timer) => clearTimeout(timer));
  cursorTimers = [];
  document.querySelectorAll(".voice-targeted").forEach((element) => element.classList.remove("voice-targeted"));

  const origin = cursorPosition || elementCenter(voiceButton);
  const destination = elementCenter(target);
  ghostCursor.classList.remove("moving", "clicking");
  ghostCursor.style.setProperty("--cursor-x", `${origin.x}px`);
  ghostCursor.style.setProperty("--cursor-y", `${origin.y}px`);
  ghostCursorLabel.textContent = label;
  void ghostCursor.offsetWidth;

  requestAnimationFrame(() => {
    ghostCursor.classList.add("moving");
    ghostCursor.style.setProperty("--cursor-x", `${destination.x}px`);
    ghostCursor.style.setProperty("--cursor-y", `${destination.y}px`);
  });

  cursorTimers.push(setTimeout(() => {
    ghostCursor.classList.add("clicking");
    target.classList.add("voice-targeted");
  }, 720));
  cursorTimers.push(setTimeout(() => {
    ghostCursor.classList.remove("moving", "clicking");
    target.classList.remove("voice-targeted");
  }, 1700));
  cursorPosition = destination;
}

function addTranscript({ role, text, partial, itemId = "", responseId = "" }) {
  if (!text) return;
  transcriptFeed.querySelector(".transcript-empty")?.remove();
  const key = `${role}:${itemId || responseId || "latest"}`;
  let row = transcriptNodes.get(key);
  if (!row) {
    row = document.createElement("p");
    row.className = "transcript-line";
    const label = document.createElement("strong");
    const content = document.createElement("span");
    label.textContent = role === "user" ? "You" : "Assistant";
    row.append(label, content);
    transcriptNodes.set(key, row);
    transcriptFeed.append(row);
  }
  row.lastElementChild.textContent = text;
  row.classList.toggle("partial", partial);
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

function clearTranscript() {
  transcriptNodes.clear();
  transcriptFeed.innerHTML = '<p class="transcript-empty">Your conversation will appear here.</p>';
}

function setConnection(kind, label) {
  connectionPill.dataset.connection = kind;
  connectionLabel.textContent = label;
}

function setVoiceState(status) {
  const states = {
    connecting: ["Connecting to local voice", "Preparing audio", "busy"],
    connected: ["Voice control is live", "Listening for a command", "online"],
    "user-speaking": ["Command in progress", "Listening to you", "online"],
    processing: ["Applying your request", "Thinking and acting", "busy"],
    "ai-speaking": ["Change confirmed", "Assistant is speaking", "online"],
    closed: ["Voice control is off", "Start listening", "offline"],
    error: ["Voice control needs attention", "Try connecting again", "offline"],
  };
  const [kicker, caption, connection] = states[status] || states.connected;
  voiceKicker.textContent = kicker;
  voiceCaption.textContent = caption;
  voiceDock.dataset.active = String(!["closed", "error"].includes(status));
  voiceButton.setAttribute("aria-label", status === "closed" ? "Start voice control" : "Stop voice control");
  if (status === "closed") setConnection("offline", "Offline");
  else if (connection === "busy") setConnection("busy", "Working");
  else if (connection === "online") setConnection("online", "Connected");
}

function createAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");
  const context = new AudioContextClass({ latencyHint: "interactive" });
  if (context.state === "suspended") void context.resume();
  return context;
}

function normalizeWsUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return FALLBACK_WS_URL;
  if (value.startsWith("http://")) value = `ws://${value.slice(7)}`;
  if (value.startsWith("https://")) value = `wss://${value.slice(8)}`;
  if (!/^wss?:\/\//.test(value)) value = `ws://${value}`;
  const url = new URL(value);
  if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/realtime";
  return url.toString();
}

async function getBackendUrl() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const config = await response.json();
      if (config.s2sUrl) return normalizeWsUrl(config.s2sUrl);
    }
  } catch {
    // The standalone page can also be served by a basic static server.
  }
  return FALLBACK_WS_URL;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  errorMessage.textContent = message;
  if (!errorDialog.open) errorDialog.showModal();
}

function attachClientEvents(activeClient) {
  activeClient.addEventListener("status", (event) => {
    const { status } = event.detail;
    setVoiceState(status);
  });
  activeClient.addEventListener("transcript", (event) => addTranscript(event.detail));
  activeClient.addEventListener("toolcall", (event) => {
    const { name, arguments: argumentsJson, callId } = event.detail;
    let args = {};
    try { args = JSON.parse(argumentsJson || "{}"); } catch { /* validated below */ }

    const outcome = executeVoiceTool(appState, name, args);
    if (outcome.ok) {
      appState = outcome.state;
      renderAppState();
      if (!["get_app_state", "get_unfilled_brief_fields"].includes(name)) {
        addActivity(outcome.message);
        moveGhostCursor(voiceActionTarget(name, appState, args), outcome.message);
        showActionToast(outcome.message);
      }
    } else {
      showActionToast(outcome.message, false);
    }

    activeClient.sendToolOutput(callId, JSON.stringify({
      ok: outcome.ok,
      message: outcome.message,
      visible_state: outcome.state,
    }));
    activeClient.sendSystemContext(buildAppStateContext(appState));
    activeClient.requestResponse();
  });
  activeClient.addEventListener("error", (event) => {
    showError(event.detail.error);
    void stopVoice();
  });
  activeClient.addEventListener("server-error", (event) => showError(event.detail.error));
}

async function startVoice() {
  if (client) return;
  setVoiceState("connecting");
  const audioContext = createAudioContext();
  try {
    micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const activeClient = new S2sWsRealtimeClient({
      directUrl: await getBackendUrl(),
      voice: "Aiden",
      instructions: VOICE_INSTRUCTIONS,
      micStream,
      audioContext,
      tools: [...VOICE_TOOLS],
      noiseGate: { enabled: true, thresholdDb: -50 },
    });
    client = activeClient;
    attachClientEvents(activeClient);
    await activeClient.connect();
    activeClient.sendSystemContext(buildAppStateContext(appState));
  } catch (error) {
    for (const track of micStream?.getTracks() || []) track.stop();
    micStream = null;
    client = null;
    void audioContext.close();
    setVoiceState("error");
    showError(error);
  }
}

async function stopVoice() {
  if (stopping) return;
  stopping = true;
  const activeClient = client;
  client = null;
  try { await activeClient?.close(); } catch { /* best effort */ }
  for (const track of micStream?.getTracks() || []) track.stop();
  micStream = null;
  stopping = false;
  setVoiceState("closed");
}

voiceButton.addEventListener("click", () => {
  if (client) void stopVoice();
  else void startVoice();
});

document.querySelectorAll("[data-panel-target]").forEach((button) => {
  button.addEventListener("click", () => {
    appState.panel = button.getAttribute("data-panel-target") || "overview";
    renderAppState();
    scheduleStateContext();
  });
});

document.querySelectorAll("[data-theme-target]").forEach((button) => {
  button.addEventListener("click", () => {
    appState.theme = button.getAttribute("data-theme-target") || "ember";
    renderAppState();
    scheduleStateContext();
  });
});

briefForm.addEventListener("input", syncBriefFromForm);
briefForm.addEventListener("change", syncBriefFromForm);
briefForm.addEventListener("submit", (event) => {
  event.preventDefault();
  syncBriefFromForm();
  const outcome = executeVoiceTool(appState, "submit_brief");
  appState = outcome.state;
  renderAppState();
  addActivity(outcome.message);
  showActionToast(outcome.message, outcome.ok);
  moveGhostCursor(voiceActionTarget("submit_brief", appState), outcome.message);
  client?.sendSystemContext(buildAppStateContext(appState));
});

$("#brief-reset").addEventListener("click", () => {
  const outcome = executeVoiceTool(appState, "reset_brief");
  appState = outcome.state;
  renderAppState();
  addActivity(outcome.message);
  showActionToast(outcome.message);
  moveGhostCursor(voiceActionTarget("reset_brief", appState), outcome.message);
  client?.sendSystemContext(buildAppStateContext(appState));
});

$("#clear-transcript").addEventListener("click", clearTranscript);
$("#error-close").addEventListener("click", () => errorDialog.close());
window.addEventListener("pagehide", () => { void stopVoice(); });

renderAppState();
setVoiceState("closed");
