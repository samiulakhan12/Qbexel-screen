import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import {
	DEFAULT_SHORTCUTS,
	GLOBAL_SHORTCUT_ACTIONS,
	type GlobalShortcutAction,
	type ShortcutBinding,
} from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

export function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

export type GlobalShortcutHandlers = Record<GlobalShortcutAction, () => void>;
export type GlobalShortcutBindings = Partial<Record<GlobalShortcutAction, ShortcutBinding>>;

/** The accelerator each action is currently registered under, so a re-register can release it. */
const current = new Map<GlobalShortcutAction, string>();

/** The subset of Electron's `globalShortcut` this module uses; injected by the tests. */
export interface GlobalShortcutApi {
	register(accelerator: string, callback: () => void): boolean;
	unregister(accelerator: string): void;
	unregisterAll(): void;
}

/**
 * Registers every global action under its binding (the default where none is given). An action
 * whose accelerator is taken by another app keeps its previous binding, and is reported in
 * `failed` so the settings dialog can say so. Two actions bound to the same keys would race for
 * one accelerator; the second is reported failed rather than silently stealing the first.
 */
export function registerGlobalShortcuts(
	bindings: GlobalShortcutBindings,
	handlers: GlobalShortcutHandlers,
	api: GlobalShortcutApi = globalShortcut,
): { success: boolean; failed: GlobalShortcutAction[] } {
	const failed: GlobalShortcutAction[] = [];
	const claimed = new Set<string>();
	for (const action of GLOBAL_SHORTCUT_ACTIONS) {
		const accelerator = bindingToAccelerator(bindings[action] ?? DEFAULT_SHORTCUTS[action]);
		if (claimed.has(accelerator)) {
			failed.push(action);
			continue;
		}
		const previous = current.get(action);
		if (previous === accelerator) {
			claimed.add(accelerator);
			continue;
		}
		// Register the new shortcut before unregistering the old, so a failure leaves the old
		// binding intact.
		const success = api.register(accelerator, handlers[action]);
		if (success) {
			if (previous) api.unregister(previous);
			current.set(action, accelerator);
			claimed.add(accelerator);
			console.log(`Global shortcut registered: ${accelerator} (${action})`);
		} else {
			failed.push(action);
			if (previous) claimed.add(previous);
			console.warn(`Failed to register global shortcut: ${accelerator} (${action})`);
		}
	}
	return { success: failed.length === 0, failed };
}

export async function loadAndRegisterGlobalShortcuts(
	handlers: GlobalShortcutHandlers,
	api: GlobalShortcutApi = globalShortcut,
): Promise<void> {
	let bindings: GlobalShortcutBindings = {};
	try {
		const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
		const shortcuts = JSON.parse(data) as Record<string, unknown>;
		bindings = pickGlobalBindings(shortcuts);
	} catch {
		// No saved shortcuts yet: the defaults apply.
	}
	registerGlobalShortcuts(bindings, handlers, api);
}

/** The global actions' bindings out of a saved config, ignoring anything malformed. */
export function pickGlobalBindings(config: unknown): GlobalShortcutBindings {
	const bindings: GlobalShortcutBindings = {};
	if (!config || typeof config !== "object") return bindings;
	for (const action of GLOBAL_SHORTCUT_ACTIONS) {
		const candidate = (config as Record<string, unknown>)[action];
		if (
			candidate &&
			typeof candidate === "object" &&
			typeof (candidate as ShortcutBinding).key === "string" &&
			(candidate as ShortcutBinding).key.length > 0
		) {
			bindings[action] = candidate as ShortcutBinding;
		}
	}
	return bindings;
}

export function unregisterAllGlobalShortcuts(api: GlobalShortcutApi = globalShortcut): void {
	api.unregisterAll();
	current.clear();
}
