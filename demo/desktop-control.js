// @ts-check

import { S2sWsRealtimeClient } from "./ws/s2s-ws-client.js";
import { classifyDesktopIntent, normalizePointerArguments } from "./desktop-control-state.mjs";

const FALLBACK_WS_URL = "ws://localhost:8765/v1/realtime";
const SNAPSHOT_MAX_EDGE = 1440;
const SNAPSHOT_QUALITY = 0.82;
const OBSERVATION_MAX_AGE_MS = 20_000;

const DESKTOP_TOOLS = [
  {
    type: "function",
    name: "inspect_screen",
    description: "Capture and attach a fresh screenshot of the user-shared desktop. Always call this before locating, moving to, or clicking a visual target.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "desktop_pointer",
    description: "Move or left-click the real macOS pointer at a target located in the latest screenshot. Provide point as [x, y] on a 0 to 1000 grid with origin at the screenshot's top-left.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["move", "click"] },
        point: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 1000 },
          minItems: 2,
          maxItems: 2,
          description: "Target coordinate [x, y] on the latest screenshot.",
        },
        target: { type: "string", description: "Short visible label or description of the intended target." },
      },
      required: ["action", "point", "target"],
    },
  },
  {
    type: "function",
    name: "desktop_type",
    description: "Type plain text into the field that desktop_pointer just clicked. This never presses Enter or sends the text. Do not use for passwords, secrets, or sensitive data.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500, description: "Exact plain text to type without Enter." },
        target: { type: "string", description: "Short description of the focused field." },
      },
      required: ["text", "target"],
    },
  },
];

const DESKTOP_INSTRUCTIONS = [
  "You are a local desktop voice controller operating the user's shared macOS display.",
  "You cannot know the current screen until you call inspect_screen; use it before every new visual action request.",
  "After receiving the screenshot, locate the requested visible target and call desktop_pointer with point=[x,y] using integers from 0 to 1000, with top-left as [0,0] and bottom-right as [1000,1000].",
  "An action is complete only after the corresponding tool returns ok=true. Never say that you will click, move, or type without calling the tool in that same response.",
  "Never guess coordinates from an old image and never claim an action occurred before its tool result.",
  "For ordinary navigation, perform one pointer action and then confirm briefly.",
  "When the user asks to type, first inspect the screen, click the intended text field, then call desktop_type in the follow-up response with the exact requested text.",
  "Typing never presses Enter or sends; do not claim a message was sent unless a later confirmed click performs that action.",
  "Before purchases, deletion, sending messages, changing permissions, authentication, or other sensitive or irreversible clicks, ask for explicit spoken confirmation and wait for the next user turn.",
  "Never request, reveal, or type passwords or other secrets.",
  "Keep spoken responses concise and do not mention internal tool names.",
].join(" ");

const $ = (selector) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const screenFrame = /** @type {HTMLElement} */ ($("#screen-frame"));
const screenVideo = /** @type {HTMLVideoElement} */ ($("#screen-preview"));
const frameResolution = /** @type {HTMLElement} */ ($("#frame-resolution"));
const observationAge = /** @type {HTMLElement} */ ($("#observation-age"));
const shareButton = /** @type {HTMLButtonElement} */ ($("#share-screen"));
const accessButton = /** @type {HTMLButtonElement} */ ($("#request-access"));
const armMouse = /** @type {HTMLInputElement} */ ($("#arm-mouse"));
const voiceButton = /** @type {HTMLButtonElement} */ ($("#voice-button"));
const voiceBar = /** @type {HTMLElement} */ ($(".voice-bar"));
const voiceKicker = /** @type {HTMLElement} */ ($("#voice-kicker"));
const voiceCaption = /** @type {HTMLElement} */ ($("#voice-caption"));
const runtimeBadge = /** @type {HTMLElement} */ ($("#runtime-badge"));
const runtimeLabel = /** @type {HTMLElement} */ ($("#runtime-label"));
const eventLog = /** @type {HTMLElement} */ ($("#event-log"));
const transcriptFeed = /** @type {HTMLElement} */ ($("#transcript-feed"));
const errorDialog = /** @type {HTMLDialogElement} */ ($("#error-dialog"));
const errorMessage = /** @type {HTMLElement} */ ($("#error-message"));

let screenStream = /** @type {MediaStream | null} */ (null);
let micStream = /** @type {MediaStream | null} */ (null);
let client = /** @type {S2sWsRealtimeClient | null} */ (null);
let bridgeTrusted = false;
let inputArmed = false;
let lastSnapshotAt = 0;
let lastPointerClickAt = 0;
let stopping = false;
let pendingDesktopIntent = null;
let responseToolObserved = false;
let actionRetryCount = 0;
const transcriptNodes = new Map();

function setStep(name, complete) {
  document.querySelector(`[data-step="${name}"]`)?.classList.toggle("complete", complete);
}

function logEvent(label, detail = "") {
  eventLog.querySelector(".event-empty")?.remove();
  const row = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = label;
  row.append(strong, document.createTextNode(detail ? ` ${detail}` : ""));
  eventLog.prepend(row);
}

function showError(error) {
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
  if (!errorDialog.open) errorDialog.showModal();
}

function setRuntime(state, label) {
  runtimeBadge.dataset.state = state;
  runtimeLabel.textContent = label;
}

function setVoiceState(status) {
  const labels = {
    connecting: ["Connecting local models", "Preparing the desktop voice loop"],
    connected: ["Desktop voice is live", "Listening for a screen task"],
    "user-speaking": ["Listening to you", "Finish the desktop instruction"],
    processing: ["Inspecting and planning", "The local VLM is working"],
    "ai-speaking": ["Action response", "The assistant is speaking"],
    closed: ["Desktop voice is off", screenStream ? "Start voice control" : "Share a display to begin"],
    error: ["Voice connection failed", "Check the local runtime"],
  };
  const [kicker, caption] = labels[status] || labels.connected;
  voiceKicker.textContent = kicker;
  voiceCaption.textContent = caption;
  voiceBar.dataset.active = String(!["closed", "error"].includes(status));
  voiceButton.setAttribute("aria-label", status === "closed" ? "Start desktop voice control" : "Stop desktop voice control");
  setStep("voice", !["closed", "error", "connecting"].includes(status));
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

async function getConfig() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not read the local demo configuration.");
  return response.json();
}

async function refreshBridgeStatus() {
  try {
    const response = await fetch("/api/desktop/status");
    if (!response.ok) throw new Error((await response.json()).detail || "Desktop bridge unavailable.");
    const status = await response.json();
    bridgeTrusted = Boolean(status.available && status.trusted);
    armMouse.disabled = !bridgeTrusted || !screenStream;
    accessButton.disabled = bridgeTrusted;
    setStep("access", bridgeTrusted);
    setRuntime(bridgeTrusted ? "ready" : "warning", bridgeTrusted ? "Native pointer ready" : "Accessibility permission needed");
  } catch (error) {
    bridgeTrusted = false;
    armMouse.disabled = true;
    setStep("access", false);
    setRuntime("offline", "Desktop bridge disabled");
    logEvent("bridge", error instanceof Error ? error.message : String(error));
  }
}

async function requestAccessibility() {
  try {
    const response = await fetch("/api/desktop/request-access", { method: "POST" });
    if (!response.ok) throw new Error((await response.json()).detail || "Could not request Accessibility permission.");
    logEvent("permission", "macOS request opened");
    await refreshBridgeStatus();
  } catch (error) {
    showError(error);
  }
}

async function shareScreen() {
  if (screenStream) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 } },
      audio: false,
    });
    screenVideo.srcObject = screenStream;
    await screenVideo.play();
    const track = screenStream.getVideoTracks()[0];
    track.addEventListener("ended", stopScreenShare, { once: true });
    const settings = track.getSettings();
    if (settings.displaySurface && settings.displaySurface !== "monitor") {
      stopScreenShare();
      throw new Error("Share an Entire Screen, not a window or browser tab, so pointer coordinates can be mapped safely.");
    }
    frameResolution.textContent = `${settings.width || screenVideo.videoWidth} x ${settings.height || screenVideo.videoHeight}`;
    screenFrame.classList.add("shared");
    shareButton.textContent = "Display shared";
    shareButton.disabled = true;
    setStep("screen", true);
    armMouse.disabled = !bridgeTrusted;
    logEvent("screen", track.label || "display shared");
    setVoiceState(client ? "connected" : "closed");
  } catch (error) {
    showError(error);
  }
}

function stopScreenShare() {
  for (const track of screenStream?.getTracks() || []) track.stop();
  screenStream = null;
  screenVideo.srcObject = null;
  screenFrame.classList.remove("shared");
  shareButton.textContent = "Share my screen";
  shareButton.disabled = false;
  armMouse.checked = false;
  armMouse.disabled = true;
  inputArmed = false;
  lastSnapshotAt = 0;
  lastPointerClickAt = 0;
  observationAge.textContent = "Not observed";
  frameResolution.textContent = "No frame";
  setStep("screen", false);
  if (client) void stopVoice();
}

function captureScreen() {
  if (!screenStream || !screenVideo.videoWidth) return null;
  const width = screenVideo.videoWidth;
  const height = screenVideo.videoHeight;
  const scale = Math.min(1, SNAPSHOT_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
  lastSnapshotAt = Date.now();
  observationAge.textContent = "Observed now";
  screenFrame.classList.remove("scanning");
  void screenFrame.offsetWidth;
  screenFrame.classList.add("scanning");
  return canvas.toDataURL("image/jpeg", SNAPSHOT_QUALITY);
}

function requiredToolResponse(activeClient, tool, instructions, image) {
  activeClient.requestResponse({
    ...(image ? { image } : {}),
    instructions,
    toolChoice: "required",
    tools: [tool],
  });
}

function recoverMissingAction(activeClient) {
  if (!pendingDesktopIntent || actionRetryCount >= 2) return;
  const image = captureScreen();
  if (!image) return;
  actionRetryCount += 1;
  logEvent("retry", `enforcing pointer tool (${actionRetryCount}/2)`);
  requiredToolResponse(
    activeClient,
    DESKTOP_TOOLS[1],
    `Execute this request now: "${pendingDesktopIntent.request}". The fresh screenshot is attached. You MUST call desktop_pointer exactly once; do not reply with a promise or explanation. For typing requests, click the intended text field first.`,
    image,
  );
}

async function executePointer(args) {
  if (!inputArmed) throw new Error("Native input is disarmed. Ask the user to enable Arm mouse + typing.");
  const { action, x, y } = normalizePointerArguments(args);
  const track = screenStream?.getVideoTracks()[0];
  const settings = track?.getSettings() || {};
  const captureWidth = settings.width || screenVideo.videoWidth;
  const captureHeight = settings.height || screenVideo.videoHeight;
  if (!captureWidth || !captureHeight) throw new Error("The shared display dimensions are unavailable.");
  const response = await fetch("/api/desktop/pointer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      x,
      y,
      capture_width: captureWidth,
      capture_height: captureHeight,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "Native pointer action failed.");
  return payload;
}

async function executeTyping(args) {
  if (!inputArmed) throw new Error("Native input is disarmed. Ask the user to enable Arm mouse + typing.");
  if (Date.now() - lastPointerClickAt > 30_000) {
    throw new Error("No recent agent click focused a text field. Inspect the screen and click the intended field first.");
  }
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) throw new Error("Plain text is required.");
  const response = await fetch("/api/desktop/type", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "Native typing failed.");
  return payload;
}

async function handleToolCall(activeClient, detail) {
  const { name, arguments: argumentsJson, callId } = detail;
  let args = {};
  try { args = JSON.parse(argumentsJson || "{}"); } catch { /* validated below */ }

  try {
    if (name === "inspect_screen") {
      const image = captureScreen();
      if (!image) throw new Error("No shared display frame is available.");
      const output = "Fresh desktop screenshot captured and attached. Locate the requested target in this image.";
      activeClient.sendToolOutput(callId, output);
      logEvent("observe", "fresh frame attached");
      activeClient.requestResponse({ image });
      return;
    }

    if (name === "desktop_pointer") {
      if (Date.now() - lastSnapshotAt > OBSERVATION_MAX_AGE_MS) {
        const image = captureScreen();
        const output = JSON.stringify({
          ok: false,
          retry: true,
          error: "Screen observation was stale. A fresh screenshot is attached; locate the target again.",
        });
        activeClient.sendToolOutput(callId, output);
        logEvent("refresh", "stale frame replaced; pointer tool required again");
        requiredToolResponse(
          activeClient,
          DESKTOP_TOOLS[1],
          `The previous coordinates for "${args.target || "the requested target"}" expired. A fresh screenshot is attached. Re-locate the target and call desktop_pointer exactly once now. Do not reply with text.`,
          image,
        );
        return;
      }
      const result = await executePointer(args);
      const target = typeof args.target === "string" ? args.target : "target";
      const output = JSON.stringify({ ...result, target });
      activeClient.sendToolOutput(callId, output);
      const display = result.display ? ` on display ${result.display.id}` : "";
      logEvent(result.action, `${target} at ${result.normalized.x},${result.normalized.y}${display}`);
      if (result.action === "click") {
        lastPointerClickAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 450));
        const image = captureScreen();
        if (pendingDesktopIntent?.requiresTyping) {
          requiredToolResponse(
            activeClient,
            DESKTOP_TOOLS[2],
            `The requested text field was clicked successfully. Complete the user's request "${pendingDesktopIntent.request}" by calling desktop_type exactly once with the requested text. Do not press Enter and do not reply without the tool call.`,
            image,
          );
        } else {
          pendingDesktopIntent = null;
          activeClient.requestResponse({ ...(image ? { image } : {}), toolChoice: "none" });
        }
      } else {
        if (pendingDesktopIntent?.requiresTyping) recoverMissingAction(activeClient);
        else {
          pendingDesktopIntent = null;
          activeClient.requestResponse({ toolChoice: "none" });
        }
      }
      return;
    }

    if (name === "desktop_type") {
      const result = await executeTyping(args);
      const target = typeof args.target === "string" ? args.target : "focused field";
      activeClient.sendToolOutput(callId, JSON.stringify({ ...result, target }));
      logEvent("type", `${result.characters} characters into ${target}`);
      pendingDesktopIntent = null;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const image = captureScreen();
      activeClient.requestResponse({ ...(image ? { image } : {}), toolChoice: "none" });
      return;
    }

    throw new Error(`Unknown desktop tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    activeClient.sendToolOutput(callId, JSON.stringify({ ok: false, error: message }));
    logEvent("blocked", message);
    if (name === "desktop_type" && pendingDesktopIntent && message.includes("No recent agent click")) {
      logEvent("recover", "typing requires a fresh field click");
      recoverMissingAction(activeClient);
    } else {
      if (message.includes("disarmed")) showError(error);
      activeClient.requestResponse();
    }
  }
}

function addTranscript({ role, text, partial, itemId = "", responseId = "" }) {
  if (!text) return;
  transcriptFeed.querySelector(".empty-copy")?.remove();
  const key = `${role}:${itemId || responseId || "latest"}`;
  let row = transcriptNodes.get(key);
  if (!row) {
    row = document.createElement("p");
    row.className = "transcript-line";
    const label = document.createElement("strong");
    const content = document.createElement("span");
    label.textContent = role === "user" ? "You" : "Pilot";
    row.append(label, content);
    transcriptNodes.set(key, row);
    transcriptFeed.append(row);
  }
  row.lastElementChild.textContent = text;
  row.classList.toggle("partial", partial);
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

function handleTranscript(detail) {
  addTranscript(detail);
  if (detail.role !== "user" || detail.partial) return;
  const intent = classifyDesktopIntent(detail.text);
  if (intent) {
    pendingDesktopIntent = intent;
    actionRetryCount = 0;
  }
  responseToolObserved = false;
}

function handleResponseFinished(activeClient, detail) {
  const calledTool = responseToolObserved;
  responseToolObserved = false;
  if (detail.status === "completed" && pendingDesktopIntent && !calledTool) {
    recoverMissingAction(activeClient);
  }
}

function createAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");
  const context = new AudioContextClass({ latencyHint: "interactive" });
  if (context.state === "suspended") void context.resume();
  return context;
}

async function startVoice() {
  if (client) return;
  if (!screenStream) {
    await shareScreen();
    if (!screenStream) return;
  }
  setVoiceState("connecting");
  const audioContext = createAudioContext();
  try {
    const config = await getConfig();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const activeClient = new S2sWsRealtimeClient({
      directUrl: normalizeWsUrl(config.s2sUrl),
      voice: "Aiden",
      instructions: DESKTOP_INSTRUCTIONS,
      micStream,
      audioContext,
      tools: DESKTOP_TOOLS,
      noiseGate: { enabled: true, thresholdDb: -50 },
    });
    client = activeClient;
    activeClient.addEventListener("status", (event) => setVoiceState(event.detail.status));
    activeClient.addEventListener("transcript", (event) => handleTranscript(event.detail));
    activeClient.addEventListener("toolcall", (event) => {
      responseToolObserved = true;
      void handleToolCall(activeClient, event.detail);
    });
    activeClient.addEventListener("response-finished", (event) => handleResponseFinished(activeClient, event.detail));
    activeClient.addEventListener("error", (event) => {
      showError(event.detail.error);
      void stopVoice();
    });
    activeClient.addEventListener("server-error", (event) => showError(event.detail.error));
    await activeClient.connect();
    logEvent("voice", "realtime session connected");
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

shareButton.addEventListener("click", () => { void shareScreen(); });
accessButton.addEventListener("click", () => { void requestAccessibility(); });
armMouse.addEventListener("change", () => {
  inputArmed = armMouse.checked && bridgeTrusted && Boolean(screenStream);
  if (!inputArmed) lastPointerClickAt = 0;
  logEvent("input", inputArmed ? "mouse and typing armed" : "disarmed");
});
voiceButton.addEventListener("click", () => {
  if (client) void stopVoice();
  else void startVoice();
});
$("#clear-transcript").addEventListener("click", () => {
  transcriptNodes.clear();
  transcriptFeed.innerHTML = '<p class="empty-copy">Voice and tool events will appear here.</p>';
});
$("#error-close").addEventListener("click", () => errorDialog.close());
window.addEventListener("pagehide", () => {
  void stopVoice();
  stopScreenShare();
});

setInterval(() => {
  if (!lastSnapshotAt) return;
  const seconds = Math.round((Date.now() - lastSnapshotAt) / 1000);
  observationAge.textContent = seconds < 2 ? "Observed now" : `Observed ${seconds}s ago`;
}, 1000);

setVoiceState("closed");
void refreshBridgeStatus();
