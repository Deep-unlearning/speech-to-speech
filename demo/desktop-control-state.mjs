export function normalizePointerArguments(args = {}) {
  const packed = Array.isArray(args.point)
    ? args.point
    : Array.isArray(args.x)
      ? args.x
      : [args.x, args.y];
  const x = Number(packed[0]);
  const y = Number(packed[1]);
  if (
    !["move", "click"].includes(args.action)
    || !Number.isInteger(x)
    || !Number.isInteger(y)
    || x < 0
    || x > 1000
    || y < 0
    || y > 1000
  ) {
    throw new Error("Pointer action and a [x, y] integer point from 0 to 1000 are required.");
  }
  return { action: args.action, x, y };
}

const ACTION_PATTERN = /\b(click|press|tap|select|choose|open|close|move|type|write|enter|fill|edit|replace|change)\b/i;
const TYPING_PATTERN = /\b(type|write|enter|fill|edit|replace)\b/i;
const SENSITIVE_PATTERN = /\b(send|submit|delete|remove|purchase|buy|pay|login|log in|sign in|password|permission|authorize|install)\b/i;

export function classifyDesktopIntent(text) {
  const request = String(text || "").trim();
  if (!request || SENSITIVE_PATTERN.test(request) || !ACTION_PATTERN.test(request)) return null;
  return {
    request,
    requiresTyping: TYPING_PATTERN.test(request),
  };
}
