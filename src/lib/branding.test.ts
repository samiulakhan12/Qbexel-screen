import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND, BRAND_I18N_VARIABLES, parseBranding, repositoryUrl } from "./branding";

const root = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

/** A JSON5 scalar at the top level of electron-builder.json5, by key. */
function builderValue(config: string, key: string): string | undefined {
	return config.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']*)["']`))?.[1];
}

describe("branding.json", () => {
	it("parses and keeps the compatibility constants", () => {
		expect(BRAND.productName.length).toBeGreaterThan(0);
		expect(BRAND.projectFileExtension).toBe(".openscreen");
		expect(BRAND.stylePresetExtension).toBe(".openscreenpreset");
		expect(BRAND.mcpServerName).toBe("openscreen");
		expect(BRAND.upstream.name).toBe("OpenScreen");
	});

	it("keeps the upstream MIT attribution in the copyright line", () => {
		expect(BRAND.copyright).toContain("OpenScreen contributors");
		expect(BRAND.copyright).toContain("MIT");
	});

	it("rejects a copyright line that drops the upstream notice", () => {
		expect(() => parseBranding({ ...BRAND, copyright: "© 2026 Someone" })).toThrow();
	});

	it("rejects an executable name with spaces", () => {
		expect(() => parseBranding({ ...BRAND, executableName: "My App" })).toThrow();
	});

	it("exposes the product name to the locale strings", () => {
		expect(BRAND_I18N_VARIABLES.product).toBe(BRAND.productName);
	});

	it("builds a repository URL only when one is configured", () => {
		expect(repositoryUrl(null)).toBeNull();
		expect(repositoryUrl({ owner: "a", repo: "b" })).toBe("https://github.com/a/b");
	});
});

// electron-builder stamps the installer, the executable, the About box's counterpart strings
// and the update feed from its own config. Nothing links that file to branding.json at build
// time, so this is what keeps the two from drifting: the identity a user sees on disk must be
// the identity the app says it is.
describe("electron-builder.json5 agrees with branding.json", () => {
	const config = read("electron-builder.json5");

	it("uses the branded app id, product name, executable and copyright", () => {
		expect(builderValue(config, "appId")).toBe(BRAND.appId);
		expect(builderValue(config, "productName")).toBe(BRAND.productName);
		expect(builderValue(config, "executableName")).toBe(BRAND.executableName);
		expect(builderValue(config, "copyright")).toBe(BRAND.copyright);
	});

	it("publishes to the update repository when one is configured", () => {
		if (!BRAND.updates) return;
		expect(builderValue(config, "owner")).toBe(BRAND.updates.owner);
		expect(builderValue(config, "repo")).toBe(BRAND.updates.repo);
	});

	it("names the product in the macOS permission prompts", () => {
		const usage = config.match(/NS\w+UsageDescription["']?\s*:\s*["']([^"']*)["']/g) ?? [];
		expect(usage.length).toBeGreaterThan(0);
		for (const line of usage) {
			expect(line).toContain(BRAND.productName);
			expect(line).not.toContain("OpenScreen needs");
		}
	});
});

describe("package.json agrees with branding.json", () => {
	const pkg = JSON.parse(read("package.json")) as { name: string; homepage: string };

	it("is named after the product", () => {
		expect(pkg.name).toBe(BRAND.executableName.toLowerCase());
		expect(pkg.homepage).toBe(`${BRAND.website}/`);
	});
});

describe("locale strings", () => {
	it("never hard-code the upstream product name", () => {
		const locales = ["en", "fr", "de", "ja-JP", "zh-CN"];
		for (const locale of locales) {
			for (const ns of ["common", "launch", "editor", "settings", "dialogs", "timeline"]) {
				const text = read(`src/i18n/locales/${locale}/${ns}.json`);
				// Only VALUES are checked: keys such as `openscreenProject` are stable identifiers.
				const values = text.replace(/"[^"\n]*"\s*:/g, "");
				expect(values, `${locale}/${ns}.json`).not.toMatch(/OpenScreen|Openscreen/);
			}
		}
	});
});
