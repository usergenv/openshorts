"""CUSTOM layout: two independently-configurable regions composited into a vertical frame.

This is the fourth layout after TRACK, GENERAL, SPLIT, SCREENCAST, INSET and WIDE.
It lets the user define two source regions (Area A and Area B) and a vertical
split ratio, then composites them via ffmpeg filtergraphs.

Usage: set CUSTOM_LAYOUT=1 and provide a layout recipe via crop_overrides or
the clip editor's custom-layout panel. The recipe is a dict mapping scene indices
to a custom-layout configuration.

The recipe shape:
{
    "area_a": {
        "x": float,        # source x as fraction of source width (0-1)
        "y": float,        # source y as fraction of source height (0-1)
        "w": float,        # source crop width as fraction of source width (0-1)
        "h": float,        # source crop height as fraction of source height (0-1)
        "out_h_ratio": float,  # fraction of output height this area fills (0-1)
        "out_y_offset": float,   # vertical offset fraction of output (0-1)
    },
    "area_b": { ... same shape ... },
    "orientation": "vertical"   # vertical or horizontal (future)
}

Area A goes on top, Area B below, in a 9:16 vertical frame. The ratio between
them is configurable: 90/10, 70/30, 50/50, etc. The user picks the source
regions interactively in the clip editor.
"""
import os
import numpy as np
from ffmpeg_utils import blurred_backdrop

ENABLED = os.environ.get("CUSTOM_LAYOUT", "0") == "1"

# Minimum fraction of each area's output height to keep it readable.
MIN_AREA_RATIO = 0.10
# Maximum fraction — the other area must have at least this much.
MAX_AREA_RATIO = 0.90

# Presets: name -> (area_a_ratio, area_b_ratio) where ratio is fraction of output height.
PRESETS = {
    "gameplay_70_30": (0.70, 0.30),
    "gameplay_60_40": (0.60, 0.40),
    "gameplay_80_20": (0.80, 0.20),
    "webcam_70_30": (0.70, 0.30),
    "split_50_50": (0.50, 0.50),
    "split_60_40": (0.60, 0.40),
    "split_70_30": (0.70, 0.30),
    "split_80_20": (0.80, 0.20),
    "split_90_10": (0.90, 0.10),
}

# --- Preset selection --------------------------------------------------------

def detect_custom_scenes(video_path, scenes, strategies, overrides=None):
    """Detect scenes that should use CUSTOM layout.

    Returns ``{scene_index: recipe}`` where recipe is a dict with area_a and
    area_b configurations. If overrides are provided they take precedence.

    This is the entry point called from reframe_v2.py's render loop, the same
    pattern used by screencast_layout.detect_screencast_scenes and
    split_layout.detect_split_scenes.
    """
    overrides = overrides or {}
    fallback = overrides.get("*") or overrides.get("__all__")
    explicit = {int(k): v for k, v in overrides.items()
                if str(k).lstrip('-').isdigit() and isinstance(v, dict)
                and v.get("layout_type") == "custom"}
    if not isinstance(fallback, dict) or fallback.get("layout_type") != "custom":
        fallback = None
    # Explicit editor recipes always work; ENABLED only gates auto-detection.
    if not ENABLED:
        if fallback:
            for scene_idx in range(len(scenes)):
                explicit.setdefault(scene_idx, fallback)
        return explicit

    found = dict(explicit)
    if fallback:
        for scene_idx in range(len(scenes)):
            found.setdefault(scene_idx, fallback)

    import cv2
    import main as m
    import frame_sampler

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return found

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0



    try:
        for scene_idx, (start, end) in enumerate(scenes):
                s_f = start.get_frames()
                e_f = end.get_frames()
                duration = (e_f - s_f) / fps

                # Only consider scenes that are TRACK or GENERAL — these are the
                # ones where CUSTOM is a meaningful upgrade.
                if scene_idx >= len(strategies):
                    continue
                strategy = strategies[scene_idx]
                if strategy not in ('TRACK', 'GENERAL'):
                    continue

                # Skip very short scenes.
                if duration < 2.0:
                    continue

                # Check for overrides first.
                if scene_idx in found:
                    continue
                if overrides and str(scene_idx) in overrides:
                    recipe = overrides[str(scene_idx)]
                    if recipe.get("layout_type") == "custom":
                        found[scene_idx] = recipe
                        continue

                # Sample frames and look for two distinct regions.
                n_samples = max(4, min(int(duration / 1.5), 24))
                samples = []
                for i in range(n_samples):
                    frame_idx = int(s_f + i * (e_f - s_f) / n_samples)
                    if frame_idx >= total_frames:
                        break
                    frame = frame_sampler.read_at_path(video_path, cap, [frame_idx])
                    if frame is None:
                        continue
                    if frame.mean() < 16:
                        continue
                    samples.append(frame)

                if len(samples) < max(3, n_samples // 2):
                    continue

                # Look for a face/person in the lower region and content above.
                # This is the classic gameplay+webcam pattern.
                face_detected = False
                for frame in samples:
                    candidates = m.detect_face_candidates(frame)
                    if candidates:
                        face_detected = True
                        break

                if not face_detected:
                    # Also check for person detection.
                    for frame in samples:
                        person = m.detect_person_yolo(frame)
                        if person:
                            face_detected = True
                            break

                if not face_detected:
                    continue

                # This scene qualifies for custom layout. Use the default preset.
                preset_key = "gameplay_70_30"
                area_a_ratio, area_b_ratio = PRESETS[preset_key]

                # Build the recipe.
                recipe = {
                    "layout_type": "custom",
                    "preset": preset_key,
                    "area_a": {
                        "x": 0.0,
                        "y": 0.0,
                        "w": 1.0,
                        "h": area_a_ratio,
                        "out_h_ratio": area_a_ratio,
                        "out_y_offset": 0.0,
                    },
                    "area_b": {
                        "x": 0.0,
                        "y": area_a_ratio,
                        "w": 1.0,
                        "h": area_b_ratio,
                        "out_h_ratio": area_b_ratio,
                        "out_y_offset": area_a_ratio,
                    },
                    "orientation": "vertical",
                }
                found[scene_idx] = recipe

    finally:
        cap.release()

    return found


# --- Filtergraph generation ---------------------------------------------------

def custom_filtergraph(orig_w, orig_h, out_w, out_h, recipe):
    """Build an ffmpeg filtergraph for a custom-layout recipe.

    Returns the filtergraph string, or None when the recipe is invalid.

    The recipe contains area_a and area_b configurations. Each area is cropped
    from the source and scaled to fill its assigned portion of the output frame.
    Areas are composited vertically (area_a on top, area_b below).

    The filtergraph follows the pattern used by camera_inset.inset_filtergraph
    and screencast_layout.screencast_filtergraph: a single [0:v] split, each
    branch crops and scales, then they are overlaid vertically.
    """
    areas = [recipe.get("area_a", {}), recipe.get("area_b", {})]
    editor_v2 = int(recipe.get("editor_version", 1)) >= 2

    def source_crop(area):
        # Scale is a source zoom around the selected rectangle's centre. It
        # never mutates the stored selection and cannot reveal hidden pixels.
        scale = float(area.get("scale", 1.0)) if editor_v2 else 1.0
        scale = max(0.05, scale)
        width = min(1.0, float(area.get("w", 1.0)) / scale)
        height = min(1.0, float(area.get("h", 1.0)) / scale)
        cx = float(area.get("x", 0.0)) + float(area.get("w", 1.0)) / 2
        cy = float(area.get("y", 0.0)) + float(area.get("h", 1.0)) / 2
        x = min(max(cx - width / 2, 0.0), 1.0 - width)
        y = min(max(cy - height / 2, 0.0), 1.0 - height)
        cw = max(2, min(orig_w, int(round(width * orig_w))))
        ch = max(2, min(orig_h, int(round(height * orig_h))))
        cw -= cw % 2
        ch -= ch % 2
        px = max(0, min(int(round(x * orig_w)), orig_w - cw))
        py = max(0, min(int(round(y * orig_h)), orig_h - ch))
        px -= px % 2
        py -= py % 2
        return px, py, cw, ch

    def destination(area):
        if not editor_v2:
            h = int(round(out_h * float(area.get("out_h_ratio", 0.5))))
            h = max(2, h - h % 2)
            y = int(round(out_h * float(area.get(
                "out_y_offset", 0.0 if area is areas[0] else 1.0 - area.get("out_h_ratio", 0.5)))))
            return 0, y, out_w, h
        x = int(round(out_w * float(area.get("out_x", 0.0))))
        y = int(round(out_h * float(area.get("out_y", 0.0))))
        w = int(round(out_w * float(area.get("out_w", 1.0))))
        h = int(round(out_h * float(area.get("out_h", area.get("out_h_ratio", 0.5)))))
        x, y = max(0, min(x, out_w - 2)), max(0, min(y, out_h - 2))
        w, h = max(2, min(w, out_w - x)), max(2, min(h, out_h - y))
        return x, y, w - w % 2, h - h % 2

    if editor_v2:
        branches = "[0:v]split=2[sa][sb];color=c=black:s=%dx%d:r=30[bg];" % (out_w, out_h)
        layer_specs = []
        for idx, area in enumerate(areas):
            sx, sy, sw, sh = source_crop(area)
            dx, dy, dw, dh = destination(area)
            fit = area.get("fit", "cover")
            label = "a" if idx == 0 else "b"
            if fit == "contain":
                fit_filters = (f"scale={dw}:{dh}:force_original_aspect_ratio=decrease,"
                               f"pad={dw}:{dh}:(ow-iw)/2:(oh-ih)/2:color=black")
            else:
                fit_filters = (f"scale={dw}:{dh}:force_original_aspect_ratio=increase,"
                               f"crop={dw}:{dh}")
            branches += f"[s{label}]crop={sw}:{sh}:{sx}:{sy},{fit_filters}[area_{label}];"
            z = int(area.get("z_index", 1 if idx == 0 else 0))
            layer_specs.append((z, f"area_{label}", dx, dy, label))
        composite = "bg"
        for index, (_z, source, x, y, label) in enumerate(sorted(layer_specs)):
            out = f"placed_{index}"
            branches += f"[{composite}][{source}]overlay={x}:{y}:shortest=1[{out}];"
            composite = out
        return branches + f"[{composite}]setsar=1[v]"

    # Existing recipes keep their legacy blurred backdrop and stacked layout.
    geometries = [source_crop(area) for area in areas]
    destinations = [destination(area) for area in areas]
    graph = f"[0:v]split=3[bga][sa][ba];[bga]{blurred_backdrop(out_w, out_h, 12)}[bg];"
    for index, (area, geom, dest, label, branch) in enumerate(zip(
            areas, geometries, destinations, ("a", "b"), ("sa", "ba"))):
        sx, sy, sw, sh = geom
        _x, _y, dw, dh = dest
        graph += f"[{branch}]crop={sw}:{sh}:{sx}:{sy},scale={dw}:{dh}[area_{label}];"
    ax, ay, _aw, _ah = destinations[0]
    bx, by, _bw, _bh = destinations[1]
    return (graph + f"[bg][area_a]overlay={ax}:{ay}[with_a];"
            f"[with_a][area_b]overlay={bx}:{by},setsar=1[v]")


def custom_filtergraph_single(recipe, orig_w, orig_h, out_w, out_h):
    """Build a simplified filtergraph for a single-area custom layout.

    This is used when only one area is defined (area_a), and the rest of the
    output is filled with a blurred backdrop. Useful for quick custom crops
    without a second area.
    """
    area = recipe.get("area", {})
    x = int(round(area.get("x", 0.0) * orig_w))
    y = int(round(area.get("y", 0.0) * orig_h))
    w = int(round(area.get("w", 1.0) * orig_w))
    h = int(round(area.get("h", 1.0) * orig_h))
    out_h_ratio = area.get("out_h_ratio", 0.5)

    area_out_h = int(round(out_h * out_h_ratio))
    area_out_h -= area_out_h % 2

    filler_h = out_h - area_out_h
    bg_filter = blurred_backdrop(out_w, out_h, 12)

    return (
        f"[0:v]split=2[bga][sa];"
        f"[bga]{bg_filter}[bg];"
        f"[sa]crop={w}:{h}:{x}:{y},scale={out_w}:{area_out_h}[area];"
        f"[bg][area]overlay=0:{filler_h // 2},setsar=1[v]"
    )


# --- Preset application -------------------------------------------------------

def apply_custom_preset(recipe, preset_name):
    """Apply a preset to a recipe, updating area ratios.

    Returns the modified recipe dict.
    """
    if preset_name not in PRESETS:
        return recipe

    area_a_ratio, area_b_ratio = PRESETS[preset_name]

    recipe["area_a"]["out_h_ratio"] = area_a_ratio
    recipe["area_a"]["out_y_offset"] = 0.0
    recipe["area_b"]["out_h_ratio"] = area_b_ratio
    recipe["area_b"]["out_y_offset"] = area_a_ratio
    recipe["preset"] = preset_name

    return recipe


# --- Integration with crop_overrides ------------------------------------------

def apply_custom_overrides(xs, strategies, scene_boundaries, overrides,
                           crop_w, orig_w, orig_h=None, splits=None):
    """Apply custom-layout overrides to the trajectory and strategies.

    This mirrors apply_crop_overrides() in reframe_v2.py but handles custom-layout
    recipes instead of single-crop centres.

    ``overrides`` maps scene indices to custom-layout recipes.
    """
    if not overrides:
        return xs, strategies

    for raw_idx, value in overrides.items():
        try:
            idx = int(raw_idx)
        except (TypeError, ValueError):
            continue
        if not 0 <= idx < len(scene_boundaries):
            continue

        if isinstance(value, dict) and value.get("layout_type") == "custom":
            strategies[idx] = 'CUSTOM'
            continue

    return xs, strategies
