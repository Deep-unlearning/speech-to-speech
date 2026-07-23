import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "demo" / "desktop_bridge.py"
SPEC = importlib.util.spec_from_file_location("desktop_bridge_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
desktop_bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(desktop_bridge)


def test_normalized_point_maps_into_display_bounds():
    bounds = ((100, 50), (1728, 1117))
    assert desktop_bridge.normalized_point(0, 0, bounds) == (100, 50)
    assert desktop_bridge.normalized_point(1000, 1000, bounds) == (1828, 1167)
    assert desktop_bridge.normalized_point(500, 250, bounds) == (964, 329.25)


def test_select_display_matches_capture_aspect_ratio():
    displays = [
        {"id": 1, "main": True, "pixels": {"width": 1728, "height": 1117}},
        {"id": 11, "main": False, "pixels": {"width": 5120, "height": 1440}},
    ]

    assert desktop_bridge.select_display(displays, 3456, 2234)["id"] == 1
    assert desktop_bridge.select_display(displays, 5120, 1440)["id"] == 11
    assert desktop_bridge.select_display(displays)["id"] == 1


def test_typing_sanitizer_allows_plain_unicode_text():
    assert desktop_bridge.sanitize_type_text("Hello Zurich - cafe") == "Hello Zurich - cafe"


def test_typing_sanitizer_rejects_control_characters_and_long_text():
    for text in ["send\n", "next\tfield", ""]:
        try:
            desktop_bridge.sanitize_type_text(text)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Expected text to be rejected: {text!r}")

    try:
        desktop_bridge.sanitize_type_text("x" * 501)
    except ValueError:
        pass
    else:
        raise AssertionError("Expected overlong text to be rejected")
