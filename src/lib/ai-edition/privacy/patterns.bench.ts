// How long the detectors take over the text of many OCR'd frames. Run with
// `npx vitest bench --run src/lib/ai-edition/privacy/patterns.bench.ts`.

import { bench, describe } from "vitest";
import { findSensitiveText } from "./patterns";

const LINES = [
	"Welcome to the billing settings of your workspace",
	"Contact jane.doe@example.com for help with the invoice",
	"API key sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c expires soon",
	"Call +1 415 555 0133 or visit 203.0.113.42 over VPN",
	"Order 2024-1187 shipped on 2026-10-16 to Berlin",
	"card 4111 1111 1111 1111 exp 12/27 cvv ***",
	"IBAN GB82 WEST 1234 5698 7654 32 for transfers",
	"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
	"Click Save, then choose the yearly plan from the list",
	"The dashboard shows 1200 users and 34 teams this month",
];

/** 120 frames of 12 lines each, as a full scan of a long recording produces. */
const FRAMES: string[][] = Array.from({ length: 120 }, (_, frame) =>
	Array.from({ length: 12 }, (_, line) => LINES[(frame + line) % LINES.length]),
);

describe("findSensitiveText", () => {
	bench("one OCR'd line", () => {
		findSensitiveText(LINES[2]);
	});
	bench("120 frames × 12 lines", () => {
		for (const frame of FRAMES) for (const line of frame) findSensitiveText(line);
	});
});
