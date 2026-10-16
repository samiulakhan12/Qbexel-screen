import { describe, expect, it } from "vitest";
import {
	BUNDLED_STYLE_PRESET_PREFIX,
	BUNDLED_STYLE_PRESETS,
	findBundledStylePreset,
	isBundledStylePresetId,
} from "./bundledStylePresets";
import { parseStylePresetFile, serializeStylePresetFile } from "./stylePresets";

describe("bundled style presets", () => {
	it("ships the five themes the product promises, with unique ids and names", () => {
		expect(BUNDLED_STYLE_PRESETS.map((p) => p.name)).toEqual([
			"Clean documentation",
			"Modern SaaS",
			"Cinematic dark",
			"Editorial",
			"Playful creative",
		]);
		expect(new Set(BUNDLED_STYLE_PRESETS.map((p) => p.id)).size).toBe(5);
		for (const preset of BUNDLED_STYLE_PRESETS) {
			expect(preset.id.startsWith(BUNDLED_STYLE_PRESET_PREFIX)).toBe(true);
			expect(preset.builtIn).toBe(true);
			expect(preset.description.length).toBeGreaterThan(20);
		}
	});

	it("each theme is a valid preset file: what a user could save, nothing more", () => {
		for (const preset of BUNDLED_STYLE_PRESETS) {
			const json = serializeStylePresetFile({ name: preset.name, appearance: preset.appearance });
			const parsed = parseStylePresetFile(JSON.parse(json));
			expect(parsed.name).toBe(preset.name);
			// Round-trips byte for byte: no value the parser clamps or substitutes.
			expect(parsed.appearance).toEqual(preset.appearance);
		}
	});

	it("names only cursor themes that ship", () => {
		const themes = new Set(BUNDLED_STYLE_PRESETS.map((p) => p.appearance.cursorTheme));
		for (const t of themes) {
			const roundTrip = parseStylePresetFile(
				JSON.parse(
					serializeStylePresetFile({
						name: "x",
						appearance: { ...BUNDLED_STYLE_PRESETS[0].appearance, cursorTheme: t },
					}),
				),
			);
			expect(roundTrip.appearance.cursorTheme).toBe(t);
		}
	});

	it("looks up by id", () => {
		expect(isBundledStylePresetId("qbexel-editorial")).toBe(true);
		expect(isBundledStylePresetId("editorial")).toBe(false);
		expect(findBundledStylePreset("qbexel-modern-saas")?.appearance.wallpaperMotion).toBe("drift");
		expect(findBundledStylePreset("nope")).toBeNull();
	});
});
