import { describe, expect, it } from "vitest";
import type { AxcutStoryboard } from "../../../src/lib/ai-edition/schema";
import { buildEnrichPrompt, enrichStoryboard, parseEnrichReply } from "./enrich";

function storyboard(): AxcutStoryboard {
	return {
		version: 1,
		generatedAt: "2026-10-16T00:00:00.000Z",
		clipSignature: "sig",
		enrichment: null,
		scenes: [
			{
				id: "scene_1",
				order: 0,
				title: "Open the settings page from the sidebar",
				startMs: 0,
				endMs: 8000,
				clipId: "clip_1",
				narration: "Open the settings page from the sidebar",
				observed: [{ kind: "click", atMs: 2000, cx: 0.2, cy: 0.7 }],
				inferred: [
					{
						kind: "title",
						text: "Open the settings page from the sidebar",
						confidence: 0.5,
						source: "heuristic",
					},
				],
			},
			{
				id: "scene_2",
				order: 1,
				title: "Scene 2",
				startMs: 8000,
				endMs: 20000,
				clipId: "clip_1",
				narration: "",
				observed: [{ kind: "silence", atMs: 9000, endMs: 11000 }],
				inferred: [{ kind: "title", text: "Scene 2", confidence: 0.1, source: "heuristic" }],
			},
		],
		suggestions: [],
	};
}

const config = {
	projectTitle: "Billing tour",
	provider: "openai",
	model: "gpt-test",
	apiKey: "sk-secret",
	now: () => new Date("2026-10-16T01:00:00.000Z"),
};

describe("buildEnrichPrompt", () => {
	it("sends narration and counts, never the credential or a file path", () => {
		const prompt = buildEnrichPrompt(storyboard(), "Billing tour", "en");
		expect(prompt).toContain('"Billing tour"');
		expect(prompt).toContain("The narration is in en.");
		expect(prompt).toContain("Open the settings page from the sidebar");
		expect(prompt).toContain('"clicks":1');
		expect(prompt).toContain('"silences":1');
		expect(prompt).not.toContain("sk-secret");
		expect(prompt).not.toContain("/tmp");
	});
});

describe("parseEnrichReply", () => {
	it("reads a fenced or prefixed array and refuses the wrong shape", () => {
		expect(
			parseEnrichReply('```json\n[{"id":"a","title":"Open x","summary":"Does y."}]\n```'),
		).toEqual([{ id: "a", title: "Open x", summary: "Does y." }]);
		expect(
			parseEnrichReply('Sure! [{"id":"a","title":"Open x","summary":"Does y."}] Done.'),
		).toHaveLength(1);
		expect(parseEnrichReply('[{"id":"a","title":""}]')).toBeNull();
		expect(parseEnrichReply("nope")).toBeNull();
	});
});

describe("enrichStoryboard", () => {
	it("adds llm titles and summaries beside the heuristics and records the model", async () => {
		const result = await enrichStoryboard({
			...config,
			storyboard: storyboard(),
			invoke: async (prompt) => {
				expect(prompt.user).toContain("scene_1");
				return {
					text: JSON.stringify([
						{ id: "scene_1", title: "Open the settings", summary: "The settings page opens." },
						{ id: "scene_2", title: "Wait for the page", summary: "A pause with no narration." },
						{ id: "scene_404", title: "Invented", summary: "Not ours." },
					]),
					usage: { inputTokens: 120, outputTokens: 40 },
				};
			},
		});
		expect(result.success).toBe(true);
		expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
		const [first, second] = result.storyboard.scenes;
		expect(first.title).toBe("Open the settings");
		expect(first.inferred.map((i) => [i.kind, i.source])).toEqual([
			["title", "heuristic"],
			["title", "llm"],
			["summary", "llm"],
		]);
		expect(first.inferred[1].model).toBe("gpt-test");
		expect(second.title).toBe("Wait for the page");
		expect(result.storyboard.scenes).toHaveLength(2);
		// Facts are untouched.
		expect(first.observed).toEqual(storyboard().scenes[0].observed);
		expect(first.narration).toBe(storyboard().scenes[0].narration);
		expect(result.storyboard.enrichment).toEqual({
			provider: "openai",
			model: "gpt-test",
			at: "2026-10-16T01:00:00.000Z",
		});
	});

	it("replaces an earlier llm pass instead of stacking it", async () => {
		const once = await enrichStoryboard({
			...config,
			storyboard: storyboard(),
			invoke: async () => ({
				text: JSON.stringify([{ id: "scene_1", title: "First", summary: "One." }]),
				usage: null,
			}),
		});
		const twice = await enrichStoryboard({
			...config,
			storyboard: once.storyboard,
			invoke: async () => ({
				text: JSON.stringify([{ id: "scene_1", title: "Second", summary: "Two." }]),
				usage: null,
			}),
		});
		const llm = twice.storyboard.scenes[0].inferred.filter((i) => i.source === "llm");
		expect(llm.map((i) => i.text)).toEqual(["Second", "Two."]);
	});

	it("fails without changing the storyboard when the reply cannot be read or names no scene", async () => {
		const input = storyboard();
		const garbage = await enrichStoryboard({
			...config,
			storyboard: input,
			invoke: async () => ({ text: "I cannot do that.", usage: null }),
		});
		expect(garbage.success).toBe(false);
		expect(garbage.storyboard).toBe(input);
		const strangers = await enrichStoryboard({
			...config,
			storyboard: input,
			invoke: async () => ({
				text: JSON.stringify([{ id: "nope", title: "x", summary: "y" }]),
				usage: null,
			}),
		});
		expect(strangers.success).toBe(false);
		expect(strangers.error).toMatch(/none of the scenes/);
	});

	it("gives up after the timeout and reports it", async () => {
		const result = await enrichStoryboard({
			...config,
			storyboard: storyboard(),
			timeoutMs: 20,
			invoke: (_prompt, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/did not answer within/);
	});

	it("honours the caller's abort signal", async () => {
		const controller = new AbortController();
		const pending = enrichStoryboard({
			...config,
			storyboard: storyboard(),
			signal: controller.signal,
			invoke: (_prompt, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		controller.abort();
		const result = await pending;
		expect(result.success).toBe(false);
		expect(result.error).toBe("Cancelled.");
	});

	it("passes an empty storyboard through without a call", async () => {
		let calls = 0;
		const result = await enrichStoryboard({
			...config,
			storyboard: { ...storyboard(), scenes: [] },
			invoke: async () => {
				calls += 1;
				return { text: "[]", usage: null };
			},
		});
		expect(result.success).toBe(true);
		expect(calls).toBe(0);
	});
});
