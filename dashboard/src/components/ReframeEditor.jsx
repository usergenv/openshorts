import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, Crosshair, RotateCcw, AlertCircle, Play, Pause, Columns2 } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiJson } from '../lib/api';

// Manual reframing: the automatic crop is right most of the time and grossly
// wrong occasionally, and until now there was no way to say "frame it here".
//
// The unit is the scene, because a podcast cuts between a fixed close camera
// and a fixed wide one and the right crop differs per camera. Scenes the user
// does not touch stay automatic, so fixing one bad shot cannot spoil the good
// ones — only adjusted scenes are sent.
//
// Two things a still frame cannot tell you, and both are handled here:
//   - WHO is talking. Each scene plays its own range of an uncropped preview,
//     with sound, and the rectangle stays overlaid while it plays.
//   - Whether one window is even enough. A scene can be split into two stacked
//     regions, positioned independently.

const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
};

const CUSTOM_PRESETS = {
    gameplay_70_30: [0.70, 0.30], gameplay_60_40: [0.60, 0.40],
    gameplay_80_20: [0.80, 0.20], webcam_70_30: [0.70, 0.30],
    split_50_50: [0.50, 0.50], split_60_40: [0.60, 0.40],
    split_70_30: [0.70, 0.30], split_80_20: [0.80, 0.20],
    split_90_10: [0.90, 0.10],
};
const LAST_CUSTOM_LAYOUT_KEY = 'openshorts:last-custom-layout:v1';
const defaultCustom = (preset = 'gameplay_70_30') => applyCustomPreset({
    layout_type: 'custom', editor_version: 2, preset, orientation: 'vertical',
    // Initial boxes are only starting points. Users should move the gameplay
    // box away from any webcam already baked into the source image.
    area_a: { x: 0.72, y: 0.68, w: 0.25, h: 0.28, out_h_ratio: 0.3, out_y_offset: 0.7,
        out_x: 0, out_y: 0.7, out_w: 1, out_h: 0.3, scale: 1, fit: 'cover', z_index: 1 },
    area_b: { x: 0, y: 0, w: 0.72, h: 1, out_h_ratio: 0.7, out_y_offset: 0,
        out_x: 0, out_y: 0, out_w: 1, out_h: 0.7, scale: 1, fit: 'cover', z_index: 0 },
}, preset);
function applyCustomPreset(recipe, name = recipe.preset || 'gameplay_70_30') {
    const [first, second] = CUSTOM_PRESETS[name] || CUSTOM_PRESETS.gameplay_70_30;
    let aTop = first, bTop = second;
    if (name.startsWith('gameplay_')) { aTop = second; bTop = first; }
    const aY = name.startsWith('gameplay_') ? first : 0;
    const bY = name.startsWith('gameplay_') ? 0 : first;
    const area = (current, y, h, z) => ({ ...current, out_x: 0, out_y: y, out_w: 1, out_h: h,
        out_h_ratio: h, out_y_offset: y, z_index: z });
    return { ...recipe, layout_type: 'custom', editor_version: 2, preset: name, orientation: 'vertical',
        area_a: area(recipe.area_a, aY, aTop, 1), area_b: area(recipe.area_b, bY, bTop, 0) };
}
function upgradeCustomRecipe(recipe) {
    if (recipe?.layout_type !== 'custom' || Number(recipe.editor_version) >= 2) return recipe;
    const upgradeArea = (area = {}, name) => ({ ...area,
        out_x: 0,
        out_y: Number(area.out_y_offset) || 0,
        out_w: 1,
        out_h: Number(area.out_h_ratio) || 0.5,
        scale: 1,
        fit: 'cover',
        z_index: name === 'area_a' ? 1 : 0,
    });
    return { ...recipe, editor_version: 2,
        area_a: upgradeArea(recipe.area_a, 'area_a'),
        area_b: upgradeArea(recipe.area_b, 'area_b') };
}
function readLastCustomLayout() {
    try {
        const saved = localStorage.getItem(LAST_CUSTOM_LAYOUT_KEY);
        const recipe = saved ? upgradeCustomRecipe(JSON.parse(saved)) : null;
        return recipe?.layout_type === 'custom' ? recipe : null;
    } catch { return null; }
}
function writeLastCustomLayout(recipe) {
    if (recipe?.layout_type !== 'custom') return;
    try {
        const { layout_type, editor_version, preset, orientation, area_a, area_b } = recipe;
        localStorage.setItem(LAST_CUSTOM_LAYOUT_KEY, JSON.stringify({
            layout_type, editor_version, preset, orientation, area_a, area_b,
        }));
    } catch { /* Storage may be disabled; per-clip server persistence still works. */ }
}
const stableJson = (value) => JSON.stringify(value, (_key, item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') return item;
    return Object.keys(item).sort().reduce((sorted, key) => { sorted[key] = item[key]; return sorted; }, {});
});

export default function ReframeEditor({ jobId, clipIndex, clipTitle, onClose, onReframed }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState(null);
    const [overrides, setOverrides] = useState({});   // idx -> number | {top,bottom}
    const [initialOverrides, setInitialOverrides] = useState({});
    const [playing, setPlaying] = useState(null);     // scene index being played
    const [saving, setSaving] = useState(false);
    const [lastCustomScene, setLastCustomScene] = useState(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiJson(`/api/clip/${jobId}/${clipIndex}/scenes`);
                if (!alive) return;
                setData(res);
                // Start from what is already applied. A re-render rebuilds
                // from source with only what it receives, so opening blank
                // would quietly discard every earlier adjustment on the next
                // save.
                const salvos = res.saved_overrides || {};
                const loaded = { ...Object.fromEntries(Object.entries(salvos).map(([k, v]) => [Number(k), v])),
                    ...Object.fromEntries(Object.entries(res.saved_custom_layout_overrides || {}).map(([k, v]) => [Number(k), upgradeCustomRecipe(v)])) };
                setOverrides(loaded);
                setInitialOverrides(loaded);
            } catch (e) {
                if (alive) setError(e?.message || 'Could not read the scenes of this clip.');
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [jobId, clipIndex]);

    const half = (data?.crop_width_fraction ?? 0.5) / 2;
    const clamp = useCallback((v) => Math.min(1 - half, Math.max(half, v)), [half]);

    // What a scene shows right now: the user's value, else the backend's
    // suggestion (the biggest face in the shot).
    const valueOf = useCallback((scene) => (
        overrides[scene.index] ?? clamp(scene.suggested_center)
    ), [overrides, clamp]);

    const setSingle = useCallback((idx, fraction) => {
        setOverrides((o) => ({ ...o, [idx]: clamp(fraction) }));
    }, [clamp]);

    const setSplitHalf = useCallback((idx, which, fraction) => {
        setOverrides((o) => {
            const cur = o[idx];
            const base = (cur && typeof cur === 'object')
                ? cur
                : { top: { x: clamp(0.3), y: 0.5 }, bottom: { x: clamp(0.7), y: 0.5 } };
            const anterior = base[which] || { y: 0.5 };
            return { ...o, [idx]: {
                ...base,
                [which]: { x: clamp(fraction), y: anterior.y ?? 0.5 },
            } };
        });
    }, [clamp]);

    const toggleSplit = useCallback((idx, scene) => {
        setOverrides((o) => {
            const cur = o[idx];
            if (cur && typeof cur === 'object') {
                // back to a single window, kept where the top half was
                return { ...o, [idx]: cur.top?.x ?? 0.5 };
            }
            const centre = typeof cur === 'number' ? cur : clamp(scene.suggested_center);
            // SPLIT halves crop vertically as well, so each carries the face
            // height the backend measured for this scene.
            const y = scene.suggested_center_y ?? 0.5;
            return { ...o, [idx]: {
                top: { x: clamp(centre - 0.2), y },
                bottom: { x: clamp(centre + 0.2), y },
            } };
        });
    }, [clamp]);

    const resetScene = useCallback((idx) => {
        setOverrides((o) => {
            const next = { ...o };
            delete next[idx];
            return next;
        });
    }, []);

    const adjusted = Object.keys(overrides).length;
    const hasChanges = stableJson(overrides) !== stableJson(initialOverrides);

    const handleSave = async () => {
        if (!hasChanges || saving) return;
        const invalidCustom = Object.entries(overrides).find(([, v]) => v?.layout_type === 'custom' &&
            ['area_a', 'area_b'].some((name) => {
                const a = v[name];
                return !a || !['x','y','w','h','out_h_ratio','out_y_offset','out_x','out_y','out_w','out_h','scale'].every((k) => Number.isFinite(a[k])) ||
                    a.x < 0 || a.y < 0 || a.w <= 0 || a.h <= 0 || a.x + a.w > 1 || a.y + a.h > 1 ||
                    a.out_x < 0 || a.out_y < 0 || a.out_w <= 0 || a.out_h <= 0 || a.out_x + a.out_w > 1 || a.out_y + a.out_h > 1 ||
                    a.scale < 0.05 || a.scale > 20 || !['cover','contain'].includes(a.fit) || ![0,1].includes(a.z_index);
            }));
        if (invalidCustom) {
            setError(`Scene ${Number(invalidCustom[0]) + 1}: custom areas must be positive and fit within the source and vertical output frame.`);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const cropPayload = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v?.layout_type !== 'custom').map(([k, v]) => [
                String(k),
                typeof v === 'object'
                    ? { top: { x: Number(v.top.x.toFixed(4)), y: Number(v.top.y.toFixed(4)) },
                        bottom: { x: Number(v.bottom.x.toFixed(4)), y: Number(v.bottom.y.toFixed(4)) } }
                    : Number(v.toFixed(4)),
            ]));
            const customPayload = Object.fromEntries(Object.entries(overrides)
                .filter(([, v]) => v?.layout_type === 'custom')
                .map(([k, v]) => [String(k), v]));
            const res = await apiJson('/api/clip/reframe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, clip_index: clipIndex, crop_overrides: cropPayload, custom_layout_overrides: customPayload }),
            });
            const lastRecipe = customPayload[String(lastCustomScene)]
                || Object.values(customPayload).slice(-1)[0];
            if (lastRecipe) writeLastCustomLayout(lastRecipe);
            if (onReframed) onReframed(clipIndex, res);
            onClose();
        } catch (e) {
            setError(e?.message || 'The re-render failed.');
        } finally {
            setSaving(false);
        }
    };

    return (
        /* Bottom sheet on a phone, centred dialog from sm — same shape as the
           shared Modal so the app has one overlay idiom, not two. */
        <div className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="card w-full max-w-3xl max-h-[92vh] sm:max-h-[90vh] flex flex-col rounded-b-none sm:rounded-card animate-sheet-up sm:animate-none">
                <div className="flex items-center justify-between p-4 border-b border-rule">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <Crosshair size={18} className="text-brass shrink-0" />
                        <div className="min-w-0">
                            <h2 className="text-base font-medium text-ink lowercase truncate">reframing</h2>
                            {clipTitle && <p className="text-xs text-muted truncate">{clipTitle}</p>}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 hover:bg-paper3 rounded-input transition-colors">
                        <X size={18} className="text-muted" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-4 space-y-5">
                    <p className="text-xs text-muted leading-relaxed">
                        Play a scene to hear who is talking, then drag the rectangle over
                        the person you want. Each scene is one camera. Scenes you leave
                        alone keep the automatic camera.
                    </p>

                    {loading && (
                        <div className="flex items-center gap-2 text-sm text-muted py-8 justify-center">
                            <Loader2 size={18} className="animate-spin text-brass" />
                            reading the scenes…
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-2 text-xs text-warn border border-warn/40 rounded-input p-3">
                            <AlertCircle size={14} className="shrink-0 mt-0.5" />
                            <span>{error}</span>
                        </div>
                    )}

                    {data?.scenes?.map((scene) => (
                        <SceneRow
                            key={scene.index}
                            scene={scene}
                            value={valueOf(scene)}
                            widthFraction={data.crop_width_fraction}
                            previewUrl={data.preview_url}
                            sourceWidth={data.source_width}
                            sourceHeight={data.source_height}
                            touched={scene.index in overrides}
                            playing={playing === scene.index}
                            onPlayToggle={() => setPlaying((p) => (p === scene.index ? null : scene.index))}
                            onMoveSingle={(f) => setSingle(scene.index, f)}
                            onMoveHalf={(which, f) => setSplitHalf(scene.index, which, f)}
                            onToggleSplit={() => toggleSplit(scene.index, scene)}
                            onSetMode={(mode) => {
                                if (mode === 'custom') setLastCustomScene(scene.index);
                                setOverrides((o) => {
                                if (mode === 'automatic') { const n = {...o}; delete n[scene.index]; return n; }
                                if (mode === 'custom') {
                                    const current = o[scene.index];
                                    if (current?.layout_type === 'custom') return o;
                                    const savedForClip = initialOverrides[scene.index]?.layout_type === 'custom'
                                        ? upgradeCustomRecipe(initialOverrides[scene.index]) : null;
                                    return {...o, [scene.index]: savedForClip || readLastCustomLayout() || defaultCustom()};
                                }
                                const v = o[scene.index];
                                if (v && typeof v === 'object' && v.layout_type !== 'custom') return o;
                                const centre = typeof v === 'number' ? v : clamp(scene.suggested_center);
                                const y = scene.suggested_center_y ?? 0.5;
                                return {...o, [scene.index]: {top:{x:clamp(centre-0.2),y}, bottom:{x:clamp(centre+0.2),y}}};
                                });
                            }}
                            onCustomChange={(v) => { setLastCustomScene(scene.index); setOverrides((o) => ({...o, [scene.index]: v})); }}
                            onReset={() => resetScene(scene.index)}
                        />
                    ))}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-t border-rule">
                    <span className="text-xs text-muted">
                        {adjusted === 0
                            ? 'nothing adjusted yet'
                            : `${adjusted} scene${adjusted > 1 ? 's' : ''} reframed by hand`}
                    </span>
                    <div className="flex items-center gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
                        <button onClick={onClose} className="btn-quiet py-2 px-4 text-sm">cancel</button>
                        <button
                            onClick={handleSave}
                            disabled={!hasChanges || saving}
                            className="btn-primary py-2 px-4 text-sm disabled:opacity-40"
                        >
                            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                            {saving ? 're-rendering…' : 'apply reframing'}
                        </button>
                    </div>
                </div>
                <div className="sm:hidden safe-bottom" />
            </div>
        </div>
    );
}


// One scene. While it plays, the frame is replaced by the uncropped preview
// seeked to this scene, so the rectangle can be judged against moving pictures
// and sound rather than a single still.
function SceneRow({ scene, value, widthFraction, previewUrl, sourceWidth, sourceHeight, touched, playing,
                    onPlayToggle, onMoveSingle, onMoveHalf, onToggleSplit, onReset, onSetMode, onCustomChange }) {
    const boxRef = useRef(null);
    const videoRef = useRef(null);
    const [dragging, setDragging] = useState(null);   // null | 'single' | 'top' | 'bottom'
    const [activeCustomSource, setActiveCustomSource] = useState('area_a');

    const isCustom = value?.layout_type === 'custom';
    const isSplit = value && typeof value === 'object' && !isCustom;

    // Play only this scene's slice of the shared preview.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (!playing) { v.pause(); return; }
        v.currentTime = scene.start;
        v.play().catch(() => {});
        const stopAtEnd = () => { if (v.currentTime >= scene.end) { v.pause(); } };
        v.addEventListener('timeupdate', stopAtEnd);
        return () => v.removeEventListener('timeupdate', stopAtEnd);
    }, [playing, scene.start, scene.end]);

    const fractionFromEvent = useCallback((clientX) => {
        const el = boxRef.current;
        if (!el) return 0.5;
        const rect = el.getBoundingClientRect();
        return (clientX - rect.left) / rect.width;
    }, []);

    useEffect(() => {
        if (!dragging) return;
        const move = (e) => {
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            const f = fractionFromEvent(x);
            if (dragging === 'single') onMoveSingle(f);
            else onMoveHalf(dragging, f);
        };
        const up = () => setDragging(null);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        window.addEventListener('touchmove', move);
        window.addEventListener('touchend', up);
        return () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('touchmove', move);
            window.removeEventListener('touchend', up);
        };
    }, [dragging, fractionFromEvent, onMoveSingle, onMoveHalf]);

    const startDrag = (which) => (e) => {
        e.stopPropagation();
        setDragging(which);
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        if (which === 'single') onMoveSingle(fractionFromEvent(x));
        else onMoveHalf(which, fractionFromEvent(x));
    };

    const win = (centre, label, which) => {
        const leftPct = (centre - widthFraction / 2) * 100;
        return (
            <div
                key={which}
                onMouseDown={startDrag(which)}
                onTouchStart={startDrag(which)}
                className="absolute inset-y-0 border-2 border-brass cursor-ew-resize"
                style={{ left: `${leftPct}%`, width: `${widthFraction * 100}%` }}
            >
                {label && (
                    <span className="absolute top-1 left-1 text-[10px] px-1 rounded bg-brass text-paper lowercase">
                        {label}
                    </span>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <button
                        onClick={onPlayToggle}
                        className="flex items-center gap-1 text-ink2 hover:text-brass transition-colors"
                        title="play this scene with sound"
                    >
                        {playing ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <select value={isCustom ? 'custom' : (isSplit ? 'split' : (touched ? 'split' : 'automatic'))}
                        onChange={(e) => onSetMode(e.target.value)} className="bg-paper3 text-ink rounded-input px-2 py-1 text-xs">
                        <option value="automatic">Automatic</option><option value="split">Split</option><option value="custom">Custom Layout</option>
                    </select>
                    <span className="readout text-muted truncate">
                        scene {scene.index + 1} · {fmt(scene.start)}–{fmt(scene.end)}
                    </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    <button
                        onClick={onToggleSplit}
                        className={`flex items-center gap-1 transition-colors ${
                            isSplit ? 'text-brass' : 'text-muted hover:text-ink2'}`}
                        title="stack two regions instead of one window"
                    >
                        <Columns2 size={12} /> split
                    </button>
                    {touched ? (
                        <button onClick={onReset} className="flex items-center gap-1 text-brass hover:underline">
                            <RotateCcw size={12} /> automatic
                        </button>
                    ) : (
                        <span className="text-muted">automatic</span>
                    )}
                </div>
            </div>

            <div
                ref={boxRef}
                className={`relative overflow-hidden rounded-input select-none border ${
                    touched ? 'border-brass' : 'border-rule'}`}
            >
                {playing && previewUrl ? (
                    <video
                        ref={videoRef}
                        src={getApiUrl(previewUrl)}
                        playsInline
                        className="w-full block"
                    />
                ) : scene.thumbnail_url ? (
                    <img
                        src={getApiUrl(scene.thumbnail_url)}
                        alt=""
                        draggable={false}
                        className="w-full block pointer-events-none"
                    />
                ) : (
                    <div className="w-full aspect-video bg-paper3" />
                )}

                {/* Everything outside the kept region is dimmed, so what survives
                    the crop is what stays bright. */}
                {!isSplit && !isCustom && (
                    <>
                        <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none"
                             style={{ width: `${Math.max(0, (value - widthFraction / 2) * 100)}%` }} />
                        <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none"
                             style={{ width: `${Math.max(0, 100 - (value + widthFraction / 2) * 100)}%` }} />
                    </>
                )}

                {isCustom ? null : isSplit
                    ? [win(value.top.x, 'top', 'top'), win(value.bottom.x, 'bottom', 'bottom')]
                    : win(value, null, 'single')}
                {isCustom && <SourceSelectionOverlay recipe={value} activeSource={activeCustomSource}
                    onChange={onCustomChange} />}
            </div>

            {isCustom && <CustomLayoutEditor value={value} onChange={onCustomChange}
                activeSource={activeCustomSource} onActiveSourceChange={setActiveCustomSource}
                scene={scene} sourceWidth={sourceWidth} sourceHeight={sourceHeight}
                previewUrl={previewUrl} playing={playing} sourceVideoRef={videoRef} />}
            {isSplit && !isCustom && (
                <p className="text-[11px] text-muted leading-snug">
                    Two regions stacked in the vertical frame: <strong>top</strong> above,
                    <strong> bottom</strong> below. Drag each one onto the person it should hold.
                </p>
            )}
        </div>
    );
}

function SourceSelectionOverlay({ recipe, activeSource, onChange }) {
    const [drag, setDrag] = useState(null);
    const canvasRef = useRef(null);
    const point = useCallback((event) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    }, []);
    const begin = (event, name, mode, handle = null) => {
        event.preventDefault();
        event.stopPropagation();
        const p = point(event);
        setDrag({ name, mode, handle, start: p, initial: { ...recipe[name] } });
    };
    useEffect(() => {
        if (!drag) return undefined;
        const move = (event) => {
            const p = point(event), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
            const r = drag.initial;
            if (drag.mode === 'draw') {
                const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y);
                onChange({ ...recipe, [drag.name]: { ...r, x, y, w: Math.max(0.005, Math.abs(dx)), h: Math.max(0.005, Math.abs(dy)) } });
                return;
            }
            if (drag.mode === 'move') {
                const x = Math.max(0, Math.min(1 - r.w, r.x + dx));
                const y = Math.max(0, Math.min(1 - r.h, r.y + dy));
                onChange({ ...recipe, [drag.name]: { ...r, x, y } });
                return;
            }
            let left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
            if (drag.handle.includes('w')) left = Math.min(right - 0.01, Math.max(0, r.x + dx));
            if (drag.handle.includes('e')) right = Math.max(left + 0.01, Math.min(1, r.x + r.w + dx));
            if (drag.handle.includes('n')) top = Math.min(bottom - 0.01, Math.max(0, r.y + dy));
            if (drag.handle.includes('s')) bottom = Math.max(top + 0.01, Math.min(1, r.y + r.h + dy));
            onChange({ ...recipe, [drag.name]: { ...r, x: left, y: top, w: right - left, h: bottom - top } });
        };
        const up = () => setDrag(null);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [drag, onChange, point, recipe]);

    const handles = ['nw','n','ne','e','se','s','sw','w'];
    const handleStyle = (handle) => ({
        nw: { left: -5, top: -5, cursor: 'nwse-resize' }, n: { left: '50%', top: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
        ne: { right: -5, top: -5, cursor: 'nesw-resize' }, e: { right: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
        se: { right: -5, bottom: -5, cursor: 'nwse-resize' }, s: { left: '50%', bottom: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
        sw: { left: -5, bottom: -5, cursor: 'nesw-resize' }, w: { left: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
    })[handle];
    return <div ref={canvasRef} data-source-canvas className="absolute inset-0 z-10 cursor-crosshair touch-none"
        onMouseDown={(event) => begin(event, activeSource, 'draw')}>
        {['area_a','area_b'].map((name) => {
            const r = recipe[name], webcam = name === 'area_a';
            if (!r.w || !r.h) return null;
            return <div key={name} onMouseDown={(event) => begin(event, name, 'move')}
                className={`absolute border-2 ${webcam ? 'border-brass bg-brass/15' : 'border-sky-400 bg-sky-400/15'} ${name === activeSource ? 'ring-2 ring-white/80' : ''} cursor-move`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>
                <span className={`absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[10px] font-bold ${webcam ? 'bg-brass text-paper' : 'bg-sky-400 text-black'}`}>{webcam ? 'WEBCAM' : 'GAMEPLAY'}</span>
                {handles.map((handle) => <button key={handle} type="button" aria-label={`Resize ${webcam ? 'webcam' : 'gameplay'} ${handle}`}
                    onMouseDown={(event) => begin(event, name, 'resize', handle)} className="absolute z-20 h-2.5 w-2.5 rounded-sm border border-black bg-white" style={handleStyle(handle)} />)}
            </div>;
        })}
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] text-white">drag blank space to redraw {activeSource === 'area_a' ? 'WEBCAM' : 'GAMEPLAY'}</span>
    </div>;
}

function CustomLayoutEditor({ value, onChange, activeSource, onActiveSourceChange,
    scene, sourceWidth, sourceHeight, previewUrl, playing, sourceVideoRef }) {
    const compVideoRefs = useRef({});
    const previewRef = useRef(null);
    const [activeOutput, setActiveOutput] = useState('area_a');
    const [outputDrag, setOutputDrag] = useState(null);
    const update = (name, key, raw) => {
        const area = value[name];
        const sourceFields = ['x','y','w','h'];
        const outputFields = ['out_x','out_y','out_w','out_h','scale'];
        let n = Number(raw);
        if (!Number.isFinite(n)) return;
        n = outputFields.includes(key) ? Math.max(0, Math.min(key === 'scale' ? 20 : 1, n)) : Math.max(0, Math.min(1, n));
        // Keep each rectangle inside its own coordinate frame while editing.
        // Without this, changing e.g. Output Y while retaining a tall Output
        // Height made an invalid recipe that could only be diagnosed at save.
        if (sourceFields.includes(key)) {
            if (key === 'x') n = Math.min(n, 1 - area.w);
            if (key === 'y') n = Math.min(n, 1 - area.h);
            if (key === 'w') n = Math.min(n, 1 - area.x);
            if (key === 'h') n = Math.min(n, 1 - area.y);
        }
        if (key === 'out_x') n = Math.min(n, 1 - area.out_w);
        if (key === 'out_y') n = Math.min(n, 1 - area.out_h);
        if (key === 'out_w') n = Math.min(n, 1 - area.out_x);
        if (key === 'out_h') n = Math.min(n, 1 - area.out_y);
        const next = { ...area, [key]: n };
        if (key === 'out_y') { next.out_y_offset = n; }
        if (key === 'out_h') { next.out_h_ratio = n; }
        onChange({ ...value, [name]: next });
    };
    const preset = (name) => onChange(applyCustomPreset(value, name));
    const outputPoint = useCallback((event) => {
        const rect = previewRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    }, []);
    const beginOutputDrag = (event, mode, handle = null) => {
        event.preventDefault();
        event.stopPropagation();
        setActiveOutput(activeOutput);
        setOutputDrag({ name: activeOutput, mode, handle, start: outputPoint(event), initial: { ...value[activeOutput] } });
    };
    const changeOutputArea = useCallback((name, patch) => {
        const next = { ...value[name], ...patch };
        if (patch.out_y !== undefined) next.out_y_offset = patch.out_y;
        if (patch.out_h !== undefined) next.out_h_ratio = patch.out_h;
        onChange({ ...value, [name]: next });
    }, [value, onChange]);
    useEffect(() => {
        if (!outputDrag) return undefined;
        const move = (event) => {
            const p = outputPoint(event), dx = p.x - outputDrag.start.x, dy = p.y - outputDrag.start.y;
            const r = outputDrag.initial;
            if (outputDrag.mode === 'move') {
                changeOutputArea(outputDrag.name, {
                    out_x: Math.max(0, Math.min(1 - r.out_w, r.out_x + dx)),
                    out_y: Math.max(0, Math.min(1 - r.out_h, r.out_y + dy)),
                });
                return;
            }
            let left = r.out_x, right = r.out_x + r.out_w, top = r.out_y, bottom = r.out_y + r.out_h;
            if (outputDrag.handle.includes('w')) left = Math.min(right - 0.01, Math.max(0, r.out_x + dx));
            if (outputDrag.handle.includes('e')) right = Math.max(left + 0.01, Math.min(1, r.out_x + r.out_w + dx));
            if (outputDrag.handle.includes('n')) top = Math.min(bottom - 0.01, Math.max(0, r.out_y + dy));
            if (outputDrag.handle.includes('s')) bottom = Math.max(top + 0.01, Math.min(1, r.out_y + r.out_h + dy));
            changeOutputArea(outputDrag.name, { out_x: left, out_y: top, out_w: right - left, out_h: bottom - top });
        };
        const up = () => setOutputDrag(null);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [outputDrag, outputPoint, changeOutputArea]);
    const removeArea = (name) => {
        const r = value[name];
        const box = name === 'area_a' ? { x: 0.72, y: 0.68, w: 0.25, h: 0.28 } : { x: 0, y: 0, w: 0.72, h: 1 };
        onChange({ ...value, [name]: { ...r, ...box } });
    };
    useEffect(() => {
        const outputs = Object.values(compVideoRefs.current).filter(Boolean);
        const source = sourceVideoRef?.current;
        if (!playing) { outputs.forEach((output) => output.pause()); return undefined; }
        const sync = () => {
            outputs.forEach((output) => {
                if (source?.paused && source.currentTime >= scene.end - 0.05) output.pause();
                try {
                    if (!source || Math.abs(output.currentTime - source.currentTime) > 0.18) output.currentTime = source?.currentTime ?? scene.start;
                } catch { /* Wait for loadedmetadata before seeking the preview. */ }
            });
        };
        sync();
        outputs.forEach((output) => output.play().catch(() => {}));
        source?.addEventListener('timeupdate', sync);
        outputs.forEach((output) => output.addEventListener('loadedmetadata', sync));
        return () => {
            source?.removeEventListener('timeupdate', sync);
            outputs.forEach((output) => { output.removeEventListener('loadedmetadata', sync); output.pause(); });
        };
    }, [playing, previewUrl, scene.start, scene.end, sourceVideoRef]);

    return <div className="rounded-input border border-rule p-3 space-y-3">
        <div className="text-xs font-medium text-ink2">Two source regions · vertical 9:16 composition</div>
        <p className="text-[11px] text-warn">A webcam baked into the original cannot be removed or recovered behind. Draw GAMEPLAY around that overlay to avoid showing the webcam twice.</p>
        <div className="flex flex-wrap gap-2">{Object.entries(CUSTOM_PRESETS).map(([name, ratios]) =>
            <button type="button" key={name} onClick={() => preset(name)} className={`text-[10px] p-1.5 rounded ${value.preset === name ? 'bg-brass text-paper' : 'bg-paper3 text-ink2'}`}>{name.replaceAll('_',' ')}<br/>{Math.round(ratios[0]*100)}/{Math.round(ratios[1]*100)}</button>)}</div>
        <div>
                <div className="mb-1 text-[11px] text-ink2">B · final composition preview</div>
                <div className="mb-2 flex justify-center gap-2">
                    <button type="button" onClick={() => setActiveOutput('area_a')} className={`rounded px-2 py-1 text-[10px] ${activeOutput === 'area_a' ? 'bg-brass text-paper' : 'bg-paper3 text-ink2'}`}>Select WEBCAM</button>
                    <button type="button" onClick={() => setActiveOutput('area_b')} className={`rounded px-2 py-1 text-[10px] ${activeOutput === 'area_b' ? 'bg-sky-400 text-black' : 'bg-paper3 text-ink2'}`}>Select GAMEPLAY</button>
                </div>
                <div ref={previewRef} className="relative mx-auto aspect-[9/16] w-full max-w-[216px] overflow-hidden border border-rule bg-black">
                    {['area_a','area_b'].map((name) => {
                        const a = value[name], zoom = Math.max(0.05, Number(a.scale) || 1);
                        if (!a.w || !a.h) return null;
                        const sw = Math.min(1, a.w / zoom), sh = Math.min(1, a.h / zoom);
                        const sx = Math.max(0, Math.min(1 - sw, a.x + (a.w - sw) / 2));
                        const sy = Math.max(0, Math.min(1 - sh, a.y + (a.h - sh) / 2));
                        const cw = sw * sourceWidth, ch = sh * sourceHeight;
                        const dw = a.out_w * 1080, dh = a.out_h * 1920;
                        const fitScale = a.fit === 'contain' ? Math.min(dw / cw, dh / ch) : Math.max(dw / cw, dh / ch);
                        const mediaUrl = playing && previewUrl ? getApiUrl(previewUrl) : getApiUrl(scene.thumbnail_url || '');
                        return <div key={name} className="absolute overflow-hidden bg-black pointer-events-none" style={{ left: `${a.out_x*100}%`, top: `${a.out_y*100}%`, width: `${a.out_w*100}%`, height: `${a.out_h*100}%`, zIndex: a.z_index }}>
                            {playing && previewUrl ? <video ref={(el) => { compVideoRefs.current[name] = el; }} src={mediaUrl} muted playsInline className="absolute max-w-none"
                                style={{ width: `${sourceWidth * fitScale / dw * 100}%`, height: `${sourceHeight * fitScale / dh * 100}%`, left: `${-sx * sourceWidth * fitScale / dw * 100}%`, top: `${-sy * sourceHeight * fitScale / dh * 100}%` }} />
                                : <img src={mediaUrl} alt={name === 'area_a' ? 'Webcam output' : 'Gameplay output'} className="absolute max-w-none" draggable={false}
                                    style={{ width: `${sourceWidth * fitScale / dw * 100}%`, height: `${sourceHeight * fitScale / dh * 100}%`, left: `${-sx * sourceWidth * fitScale / dw * 100}%`, top: `${-sy * sourceHeight * fitScale / dh * 100}%` }} />}
                        </div>;
                    })}
                    {(() => {
                        const a = value[activeOutput];
                        const webcam = activeOutput === 'area_a';
                        const handles = ['nw','n','ne','e','se','s','sw','w'];
                        const styles = {
                            nw: { left: -5, top: -5, cursor: 'nwse-resize' }, n: { left: '50%', top: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
                            ne: { right: -5, top: -5, cursor: 'nesw-resize' }, e: { right: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
                            se: { right: -5, bottom: -5, cursor: 'nwse-resize' }, s: { left: '50%', bottom: -5, transform: 'translateX(-50%)', cursor: 'ns-resize' },
                            sw: { left: -5, bottom: -5, cursor: 'nesw-resize' }, w: { left: -5, top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' },
                        };
                        return <div className={`absolute border-2 ${webcam ? 'border-brass' : 'border-sky-400'} pointer-events-none`}
                            style={{ left: `${a.out_x*100}%`, top: `${a.out_y*100}%`, width: `${a.out_w*100}%`, height: `${a.out_h*100}%`, zIndex: 10 }}>
                            {handles.map((handle) => <button key={handle} type="button" data-output-handle aria-label={`Resize ${webcam ? 'webcam' : 'gameplay'} output ${handle}`}
                                onMouseDown={(event) => beginOutputDrag(event, 'resize', handle)} className="absolute pointer-events-auto h-2.5 w-2.5 rounded-sm border border-black bg-white" style={styles[handle]} />)}
                        </div>;
                    })()}
                    <div className="absolute inset-0 z-[9] cursor-move" aria-label={`Move ${activeOutput === 'area_a' ? 'webcam' : 'gameplay'} output`}
                        onMouseDown={(event) => {
                            const p = outputPoint(event), a = value[activeOutput];
                            if (p.x >= a.out_x && p.x <= a.out_x + a.out_w && p.y >= a.out_y && p.y <= a.out_y + a.out_h) beginOutputDrag(event, 'move');
                        }} />
                </div>
                <div className="mt-1 text-center text-[10px] text-muted">Preview follows the source scene while it plays.</div>
        </div>
        <div className="flex gap-2">
            <button type="button" onClick={() => onActiveSourceChange('area_a')} className={`rounded px-2 py-1 text-xs ${activeSource === 'area_a' ? 'bg-brass text-paper' : 'bg-paper3 text-ink2'}`}>WEBCAM · SOURCE A</button>
            <button type="button" onClick={() => onActiveSourceChange('area_b')} className={`rounded px-2 py-1 text-xs ${activeSource === 'area_b' ? 'bg-sky-400 text-black' : 'bg-paper3 text-ink2'}`}>GAMEPLAY · SOURCE B</button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {['area_a','area_b'].map((name) => {
                const area = value[name], webcam = name === 'area_a';
                const sourceFields = [['x','Source X'],['y','Source Y'],['w','Source width'],['h','Source height']];
                const outputFields = [['out_x','Output X'],['out_y','Output Y'],['out_w','Output width'],['out_h','Output height'],['scale','Scale']];
                return <fieldset key={name} className="rounded-input border border-rule p-2 space-y-2">
                    <legend className={`px-1 text-xs ${webcam ? 'text-brass' : 'text-sky-400'}`}>{webcam ? 'SOURCE A · WEBCAM' : 'SOURCE B · GAMEPLAY'}</legend>
                    <div className="grid grid-cols-4 gap-1">{sourceFields.map(([key,label]) => <label key={key} className="text-[10px] text-muted">{label}<input aria-label={`${webcam ? 'Webcam' : 'Gameplay'} ${label}`} type="number" min="0" max="1" step="0.01" value={area[key]} onChange={(e)=>update(name,key,e.target.value)} className="block w-full bg-paper3 rounded px-1 py-1 text-ink" /></label>)}</div>
                    <div className="grid grid-cols-5 gap-1">{outputFields.map(([key,label]) => <label key={key} className="text-[10px] text-muted">{label}<input aria-label={`${webcam ? 'Webcam' : 'Gameplay'} ${label}`} type="number" min={key === 'scale' ? '0.05' : '0'} max={key === 'scale' ? '20' : '1'} step={key === 'scale' ? '0.1' : '0.01'} value={area[key]} onChange={(e)=>update(name,key,e.target.value)} className="block w-full bg-paper3 rounded px-1 py-1 text-ink" /></label>)}
                        <label className="text-[10px] text-muted">Fit<select aria-label={`${webcam ? 'Webcam' : 'Gameplay'} fit`} value={area.fit} onChange={(e)=>onChange({...value,[name]:{...area,fit:e.target.value}})} className="block w-full bg-paper3 rounded px-1 py-1 text-ink"><option value="cover">cover</option><option value="contain">contain</option></select></label>
                        <label className="text-[10px] text-muted">Layer<select aria-label={`${webcam ? 'Webcam' : 'Gameplay'} layer`} value={area.z_index} onChange={(e)=>onChange({...value,[name]:{...area,z_index:Number(e.target.value)}})} className="block w-full bg-paper3 rounded px-1 py-1 text-ink"><option value={0}>behind</option><option value={1}>front</option></select></label>
                    </div>
                    <span className="text-[10px] text-muted">Selected {Math.round(area.w*sourceWidth)}×{Math.round(area.h*sourceHeight)} px · {Math.round(area.w*100)}%×{Math.round(area.h*100)}%</span>
                    <button type="button" onClick={() => onChange({...value,[name]:{...area,w:0,h:0}})} className="ml-2 text-[10px] text-muted hover:text-warn">Clear</button>
                    <button type="button" onClick={() => removeArea(name)} className="ml-2 text-[10px] text-muted hover:text-warn">Reset box</button>
                </fieldset>;
            })}
        </div>
        <p className="text-[10px] text-muted">Source and output values are normalized to 0–1. Move or resize either colored source box; presets only change output placement.</p>
    </div>;
}
