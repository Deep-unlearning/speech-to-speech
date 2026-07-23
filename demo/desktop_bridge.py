"""Minimal macOS pointer bridge for the local desktop-control demo."""

from __future__ import annotations

import platform
import math
import time
import unicodedata
from typing import Any

try:
    import Quartz
except ImportError:  # Linux deploys and installs without the optional framework.
    Quartz = None  # type: ignore[assignment]

try:
    import ApplicationServices
except ImportError:
    ApplicationServices = None  # type: ignore[assignment]


def available() -> bool:
    return platform.system() == "Darwin" and Quartz is not None and ApplicationServices is not None


def accessibility_trusted(*, prompt: bool = False) -> bool:
    if not available():
        return False
    if prompt:
        options = {ApplicationServices.kAXTrustedCheckOptionPrompt: True}
        return bool(ApplicationServices.AXIsProcessTrustedWithOptions(options))
    return bool(ApplicationServices.AXIsProcessTrusted())


def _rect_values(bounds: Any) -> tuple[float, float, float, float]:
    try:
        return (
            float(bounds.origin.x),
            float(bounds.origin.y),
            float(bounds.size.width),
            float(bounds.size.height),
        )
    except AttributeError:
        (origin_x, origin_y), (width, height) = bounds
        return float(origin_x), float(origin_y), float(width), float(height)


def normalized_point(
    x: int,
    y: int,
    bounds: Any,
) -> tuple[float, float]:
    """Map 0..1000 screenshot coordinates into the selected display bounds."""
    origin_x, origin_y, width, height = _rect_values(bounds)
    return origin_x + width * x / 1000, origin_y + height * y / 1000


def active_displays() -> list[dict[str, Any]]:
    """Return Quartz display geometry in the global pointer coordinate space."""
    if not available():
        return []
    error, display_ids, _ = Quartz.CGGetActiveDisplayList(32, None, None)
    if error:
        raise RuntimeError(f"Could not enumerate active displays (Quartz error {error}).")

    displays = []
    for display_id in display_ids:
        bounds = Quartz.CGDisplayBounds(display_id)
        origin_x, origin_y, width, height = _rect_values(bounds)
        displays.append(
            {
                "id": int(display_id),
                "main": bool(Quartz.CGDisplayIsMain(display_id)),
                "builtin": bool(Quartz.CGDisplayIsBuiltin(display_id)),
                "bounds": {
                    "x": origin_x,
                    "y": origin_y,
                    "width": width,
                    "height": height,
                },
                "pixels": {
                    "width": int(Quartz.CGDisplayPixelsWide(display_id)),
                    "height": int(Quartz.CGDisplayPixelsHigh(display_id)),
                },
            }
        )
    return displays


def select_display(
    displays: list[dict[str, Any]],
    capture_width: int | None = None,
    capture_height: int | None = None,
) -> dict[str, Any]:
    """Match a browser monitor capture to Quartz geometry by aspect ratio."""
    if not displays:
        raise RuntimeError("No active displays were found.")
    if capture_width and capture_height:
        capture_ratio = capture_width / capture_height

        def ratio_error(display: dict[str, Any]) -> float:
            pixels = display["pixels"]
            display_ratio = pixels["width"] / pixels["height"]
            return abs(math.log(display_ratio / capture_ratio))

        return min(displays, key=ratio_error)
    return next((display for display in displays if display["main"]), displays[0])


def _point_values(point: Any) -> tuple[float, float]:
    try:
        return float(point.x), float(point.y)
    except AttributeError:
        return float(point[0]), float(point[1])


def _post_mouse_event(event_type: int, point: tuple[float, float]) -> None:
    event = Quartz.CGEventCreateMouseEvent(None, event_type, point, Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)


def execute_pointer(
    action: str,
    x: int,
    y: int,
    capture_width: int | None = None,
    capture_height: int | None = None,
) -> dict[str, Any]:
    if not available():
        raise RuntimeError("Quartz pointer control is unavailable on this machine.")
    if not accessibility_trusted():
        raise PermissionError("Grant Accessibility permission to the demo Python process first.")
    if action not in {"move", "click"}:
        raise ValueError(f"Unsupported pointer action: {action}")

    display = select_display(active_displays(), capture_width, capture_height)
    display_bounds = display["bounds"]
    bounds = (
        (display_bounds["x"], display_bounds["y"]),
        (display_bounds["width"], display_bounds["height"]),
    )
    destination = normalized_point(x, y, bounds)
    current_event = Quartz.CGEventCreate(None)
    start = _point_values(Quartz.CGEventGetLocation(current_event))

    # Ease the real pointer across the display so the action remains observable.
    for step in range(1, 19):
        progress = step / 18
        eased = 1 - (1 - progress) ** 3
        point = (
            start[0] + (destination[0] - start[0]) * eased,
            start[1] + (destination[1] - start[1]) * eased,
        )
        _post_mouse_event(Quartz.kCGEventMouseMoved, point)
        time.sleep(0.012)

    if action == "click":
        _post_mouse_event(Quartz.kCGEventLeftMouseDown, destination)
        time.sleep(0.06)
        _post_mouse_event(Quartz.kCGEventLeftMouseUp, destination)

    return {
        "ok": True,
        "action": action,
        "normalized": {"x": x, "y": y},
        "screen_point": {"x": round(destination[0], 1), "y": round(destination[1], 1)},
        "display": {
            "id": display["id"],
            "main": display["main"],
            "pixels": display["pixels"],
        },
    }


def sanitize_type_text(text: str, *, max_length: int = 500) -> str:
    if not text:
        raise ValueError("Text cannot be empty.")
    if len(text) > max_length:
        raise ValueError(f"Text cannot exceed {max_length} characters.")
    if any(unicodedata.category(character) == "Cc" for character in text):
        raise ValueError("Control characters, including Enter and Tab, are not allowed.")
    return text


def execute_typing(text: str) -> dict[str, Any]:
    if not available():
        raise RuntimeError("Quartz keyboard control is unavailable on this machine.")
    if not accessibility_trusted():
        raise PermissionError("Grant Accessibility permission to the demo Python process first.")
    safe_text = sanitize_type_text(text)

    # Short chunks are reliable across native and browser text fields while
    # still preserving Unicode input. No return/submit key event is emitted.
    for start in range(0, len(safe_text), 20):
        chunk = safe_text[start : start + 20]
        key_down = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
        Quartz.CGEventKeyboardSetUnicodeString(key_down, len(chunk), chunk)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, key_down)
        key_up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, key_up)
        time.sleep(0.015)

    return {"ok": True, "action": "type", "characters": len(safe_text)}
