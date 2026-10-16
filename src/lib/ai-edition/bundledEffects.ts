// Visual effects that ship with the product, as shader-effect definitions.
//
// An effect is data (`shaderEffects[]` + `shaderEffectRanges[]`, docs/shader-effects.md): the
// compositor compiles the WGSL and applies it in preview and export alike, so a bundled effect
// needs no renderer change and is adjustable like one an agent wrote. These definitions follow
// the contract's own examples closely; the compositor checks the code when the range is posed.
//
// NOTE: this environment has no compositor, so the WGSL below is validated against the contract
// by reading, not by compiling. The first run on a device with the addon is what proves it; the
// cost tier it reports is cached on the definition then.

import { createId } from "./document/ids";
import type { AxcutDocument, AxcutShaderEffect, AxcutShaderEffectRange } from "./schema";
import { SHADER_EFFECT_CONTRACT } from "./shaderEffects";
import { anchorRegionsWithDerivedMs } from "./timeline/timelineMap";

export type BundledEffectKey = "spotlight" | "focus-vignette";

/** Stable ids, so adding the effect twice reuses one definition. */
const BUNDLED_EFFECT_IDS: Record<BundledEffectKey, string> = {
	spotlight: "fx_qbexel_spotlight",
	"focus-vignette": "fx_qbexel_focus_vignette",
};

type Definition = Omit<AxcutShaderEffect, "cost">;

const SPOTLIGHT: Definition = {
	id: BUNDLED_EFFECT_IDS.spotlight,
	name: "Spotlight",
	description:
		"Darkens everything but a soft circle around the pointer, so the viewer's eye follows the cursor. Off screen, the circle rests at the centre.",
	contract: SHADER_EFFECT_CONTRACT,
	origin: "user",
	params: [
		{ type: "number", name: "radius", label: "Radius", default: 0.22, min: 0.05, max: 0.6 },
		{ type: "number", name: "softness", label: "Softness", default: 0.12, min: 0.01, max: 0.4 },
		{ type: "number", name: "dim", label: "Dim", default: 0.65, min: 0, max: 1 },
		{ type: "color", name: "tint", label: "Tint", default: "#000000" },
	],
	code: `fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let centre = select(vec2<f32>(0.5, 0.5), ctx.cursor.xy, ctx.cursor.z > 0.5);
    let v = (uv - centre) * vec2<f32>(ctx.aspect, 1.0);
    let edge = params.radius;
    let k = smoothstep(edge, edge + params.softness, length(v)) * params.dim;
    return vec4<f32>(mix(c.rgb, params.tint.rgb, k), c.a);
}`,
};

const FOCUS_VIGNETTE: Definition = {
	id: BUNDLED_EFFECT_IDS["focus-vignette"],
	name: "Focus vignette",
	description:
		"A still vignette that darkens the frame's edges and keeps the middle bright: a quiet way to say where to look.",
	contract: SHADER_EFFECT_CONTRACT,
	origin: "user",
	params: [
		{ type: "number", name: "depth", label: "Depth", default: 0.5, min: 0, max: 1 },
		{ type: "color", name: "tint", label: "Tint", default: "#000000" },
	],
	code: `fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let v = (uv - 0.5) * vec2<f32>(ctx.aspect, 1.0);
    let k = smoothstep(0.35, 0.9, length(v)) * params.depth;
    return vec4<f32>(mix(c.rgb, params.tint.rgb, k), c.a);
}`,
};

export const BUNDLED_EFFECTS: Record<BundledEffectKey, Definition> = {
	spotlight: SPOTLIGHT,
	"focus-vignette": FOCUS_VIGNETTE,
};

export const BUNDLED_EFFECT_KEYS = Object.keys(BUNDLED_EFFECTS) as BundledEffectKey[];

/** Adds the definition if the document lacks it, then poses it over `[startMs, endMs]`. Pure. */
export function addBundledEffectRange(
	document: AxcutDocument,
	key: BundledEffectKey,
	startMs: number,
	endMs: number,
	target: AxcutShaderEffectRange["target"] = "image",
): AxcutDocument {
	const definition = BUNDLED_EFFECTS[key];
	if (!definition) throw new Error(`Unknown bundled effect: ${key}`);
	if (!(endMs > startMs)) throw new Error("The effect's span must have a positive length.");
	const effects = document.shaderEffects ?? [];
	const withDefinition = effects.some((e) => e.id === definition.id)
		? effects
		: [...effects, { ...definition, params: definition.params.map((p) => ({ ...p })) }];
	// One effect at a time: refuse a span that overlaps an existing effect range.
	const ranges = document.shaderEffectRanges ?? [];
	const overlap = ranges.find((r) => r.startMs < endMs && startMs < r.endMs);
	if (overlap) {
		throw new Error(
			`Another effect already runs from ${overlap.startMs / 1000}s to ${overlap.endMs / 1000}s; effects do not overlap.`,
		);
	}
	const draft: AxcutShaderEffectRange = {
		id: createId("fxr"),
		startMs: Math.round(startMs),
		endMs: Math.round(endMs),
		effectId: definition.id,
		values: {},
		target,
	};
	const created = anchorRegionsWithDerivedMs([draft], document.timeline.clips, () =>
		createId("fxr"),
	) as unknown as AxcutShaderEffectRange[];
	if (created.length === 0) throw new Error("The effect's span covers no clip.");
	return {
		...document,
		shaderEffects: withDefinition,
		shaderEffectRanges: [...ranges, ...created],
	};
}
