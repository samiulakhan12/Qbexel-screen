import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ globalShortcut: {} }));
vi.mock("./ipc/handlers", () => ({ SHORTCUTS_FILE: "/nonexistent/shortcuts.json" }));

import {
	bindingToAccelerator,
	type GlobalShortcutApi,
	pickGlobalBindings,
	registerGlobalShortcuts,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";

function fakeApi(refuse: Set<string> = new Set()): GlobalShortcutApi & { registered: string[] } {
	const registered: string[] = [];
	return {
		registered,
		register(accelerator) {
			if (refuse.has(accelerator)) return false;
			registered.push(accelerator);
			return true;
		},
		unregister(accelerator) {
			const i = registered.indexOf(accelerator);
			if (i >= 0) registered.splice(i, 1);
		},
		unregisterAll() {
			registered.length = 0;
		},
	};
}

const handlers = { openApp: vi.fn(), toggleRecording: vi.fn(), pauseRecording: vi.fn() };

beforeEach(() => {
	unregisterAllGlobalShortcuts(fakeApi());
});

describe("bindingToAccelerator", () => {
	it("maps modifiers and named keys to Electron accelerators", () => {
		expect(bindingToAccelerator({ key: "r", ctrl: true, shift: true })).toBe(
			"CommandOrControl+Shift+R",
		);
		expect(bindingToAccelerator({ key: " ", alt: true })).toBe("Alt+Space");
		expect(bindingToAccelerator({ key: "arrowup" })).toBe("Up");
	});
});

describe("registerGlobalShortcuts", () => {
	it("registers the three global actions under their defaults", () => {
		const api = fakeApi();
		const result = registerGlobalShortcuts({}, handlers, api);
		expect(result).toEqual({ success: true, failed: [] });
		expect(api.registered).toEqual([
			"CommandOrControl+Shift+O",
			"CommandOrControl+Shift+R",
			"CommandOrControl+Shift+P",
		]);
	});

	it("keeps the previous binding when the OS refuses the new one", () => {
		const api = fakeApi();
		registerGlobalShortcuts({}, handlers, api);
		const refusing = fakeApi(new Set(["CommandOrControl+Alt+R"]));
		refusing.registered.push(...api.registered);
		const result = registerGlobalShortcuts(
			{ toggleRecording: { key: "r", ctrl: true, alt: true } },
			handlers,
			refusing,
		);
		expect(result).toEqual({ success: false, failed: ["toggleRecording"] });
		expect(refusing.registered).toContain("CommandOrControl+Shift+R");
		expect(refusing.registered).not.toContain("CommandOrControl+Alt+R");
	});

	it("releases the old accelerator once the new one is registered", () => {
		const api = fakeApi();
		registerGlobalShortcuts({}, handlers, api);
		registerGlobalShortcuts({ openApp: { key: "o", ctrl: true, alt: true } }, handlers, api);
		expect(api.registered).toContain("CommandOrControl+Alt+O");
		expect(api.registered).not.toContain("CommandOrControl+Shift+O");
	});

	it("refuses two actions on one accelerator instead of letting the second steal it", () => {
		const api = fakeApi();
		const result = registerGlobalShortcuts(
			{
				toggleRecording: { key: "k", ctrl: true },
				pauseRecording: { key: "k", ctrl: true },
			},
			handlers,
			api,
		);
		expect(result.failed).toEqual(["pauseRecording"]);
		expect(api.registered.filter((a) => a === "CommandOrControl+K")).toHaveLength(1);
	});
});

describe("pickGlobalBindings", () => {
	it("keeps only well-formed bindings of global actions", () => {
		expect(
			pickGlobalBindings({
				openApp: { key: "o", ctrl: true },
				toggleRecording: { key: "" },
				pauseRecording: "nope",
				addZoom: { key: "z" },
			}),
		).toEqual({ openApp: { key: "o", ctrl: true } });
		expect(pickGlobalBindings(null)).toEqual({});
	});
});
