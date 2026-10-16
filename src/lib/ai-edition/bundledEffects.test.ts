import { describe, expect, it } from "vitest";
import { addBundledEffectRange, BUNDLED_EFFECT_KEYS, BUNDLED_EFFECTS } from "./bundledEffects";
import { createEmptyDocument, documentSchema, shaderEffectSchema } from "./schema";

function doc() {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	return {
		...base,
		assets: [
			{
				id: "a",
				kind: "video" as const,
				label: "t",
				originalPath: "/x.mp4",
				durationSec: 20,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};
}

describe("bundled effects", () => {
	it("every definition satisfies the document's shader-effect schema", () => {
		for (const key of BUNDLED_EFFECT_KEYS) {
			const parsed = shaderEffectSchema.parse(BUNDLED_EFFECTS[key]);
			expect(parsed.code).toContain("fn effect(uv: vec2<f32>) -> vec4<f32>");
			// Only the contract's inputs: nothing the compositor does not provide.
			expect(parsed.code).not.toMatch(/@group|@binding|textureSample|var<uniform>/);
		}
	});

	it("poses an effect over a span and reuses the definition the second time", () => {
		const once = addBundledEffectRange(doc(), "spotlight", 2000, 6000);
		expect(once.shaderEffects).toHaveLength(1);
		expect(once.shaderEffectRanges).toHaveLength(1);
		expect(once.shaderEffectRanges?.[0]).toMatchObject({
			effectId: "fx_qbexel_spotlight",
			clipId: "c1",
			sourceStartSec: 2,
			sourceEndSec: 6,
		});
		const twice = addBundledEffectRange(once, "spotlight", 8000, 9000);
		expect(twice.shaderEffects).toHaveLength(1);
		expect(twice.shaderEffectRanges).toHaveLength(2);
		expect(() => documentSchema.parse(twice)).not.toThrow();
	});

	it("refuses an overlapping span and an empty one", () => {
		const once = addBundledEffectRange(doc(), "focus-vignette", 2000, 6000);
		expect(() => addBundledEffectRange(once, "spotlight", 5000, 7000)).toThrow(/do not overlap/);
		expect(() => addBundledEffectRange(doc(), "spotlight", 5000, 5000)).toThrow(/positive length/);
	});
});
