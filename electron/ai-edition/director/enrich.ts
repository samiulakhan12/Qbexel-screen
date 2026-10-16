// The Director's optional model pass.
//
// Given a storyboard the deterministic analyser built, ask the configured chat model for
// a title and a one-sentence summary per scene. That is ALL it may do: the reply is a
// strict list of `{id, title, summary}` validated with Zod, re-keyed to scene ids we sent,
// and written as `llm` inferences beside the heuristic ones. Times, observed events and
// suggestions are never touched, so the model cannot invent an action the recording does
// not hold — it can only name what the analyser found.
//
// What leaves the machine: the transcribed words of each scene and a count of its clicks.
// No video frame, no screenshot, no file path. The caller asks the user before calling
// this (the pane's consent checkbox), and `enrichment` records which model answered.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { AxcutStoryboard, AxcutStoryboardInference } from "../../../src/lib/ai-edition/schema";
import { createOpenScreenChatModel, messageContentToText } from "../deep-agent/chat-model";

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface EnrichStoryboardOptions {
	storyboard: AxcutStoryboard;
	projectTitle: string;
	/** The transcript's language, for the model's wording; "auto" or undefined is fine. */
	language?: string;
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	signal?: AbortSignal;
	/** The call is abandoned after this long. */
	timeoutMs?: number;
	now?: () => Date;
	/** Test seam: stands in for the LangChain model. */
	invoke?: (
		prompt: { system: string; user: string },
		signal: AbortSignal,
	) => Promise<{ text: string; usage: TokenUsage | null }>;
}

export interface EnrichStoryboardResult {
	success: boolean;
	/** The input storyboard on failure, the enriched one on success. */
	storyboard: AxcutStoryboard;
	usage: TokenUsage | null;
	error?: string;
}

export const ENRICH_TIMEOUT_MS = 60_000;
/** Narration is cut here per scene: a title needs the gist, not the transcript. */
const NARRATION_CHARS = 600;
const LLM_CONFIDENCE = 0.7;

const SYSTEM_PROMPT = [
	"You name the scenes of a software tutorial video for its editor.",
	"You receive a JSON array of scenes. Each has an `id`, its time span, the words the narrator said in it (`narration`, transcribed), and counts of what was recorded (`clicks`, `silences`).",
	"For each scene write a `title` and a `summary`.",
	"",
	"Rules:",
	"- Reply with JSON only: an array of objects with exactly the keys `id`, `title`, `summary`. No prose, no code fences.",
	"- One entry per input scene, with the SAME `id`. Never add, merge, split or drop scenes.",
	'- `title`: an imperative step of at most eight words, in the narration\'s language (for example "Open the billing settings").',
	"- `summary`: one sentence saying what the viewer sees or does in the scene.",
	'- Describe only what the narration and the counts support. Do not invent clicks, screens, buttons or outcomes that are not stated. When the narration is empty, say what little is known (for example "Clicks with no narration").',
	"- Keep names, product names, numbers and code identifiers verbatim.",
].join("\n");

const replySchema = z
	.array(
		z.object({
			id: z.string().min(1),
			title: z.string().trim().min(1).max(80),
			summary: z.string().trim().min(1).max(300),
		}),
	)
	.max(1000);

export function buildEnrichPrompt(
	storyboard: AxcutStoryboard,
	projectTitle: string,
	language?: string,
): string {
	const lang = language && language !== "auto" ? ` The narration is in ${language}.` : "";
	const scenes = storyboard.scenes.map((scene) => ({
		id: scene.id,
		startSec: Math.round(scene.startMs / 100) / 10,
		endSec: Math.round(scene.endMs / 100) / 10,
		narration: scene.narration.slice(0, NARRATION_CHARS),
		clicks: scene.observed.filter((event) => event.kind !== "silence").length,
		silences: scene.observed.filter((event) => event.kind === "silence").length,
		heuristicTitle: scene.inferred.find((inference) => inference.kind === "title")?.text ?? "",
	}));
	return [
		`The video is called "${projectTitle}".${lang} Name its ${scenes.length} scenes.`,
		"",
		JSON.stringify(scenes),
	].join("\n");
}

/** The JSON array in a reply, tolerating a code fence or a lead-in sentence. */
export function parseEnrichReply(raw: string): z.infer<typeof replySchema> | null {
	const unfenced = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	const candidates = [unfenced];
	const first = unfenced.indexOf("[");
	const last = unfenced.lastIndexOf("]");
	if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const parsed = replySchema.safeParse(JSON.parse(candidate));
			if (parsed.success) return parsed.data;
		} catch {
			// Next candidate.
		}
	}
	return null;
}

function readUsage(message: unknown): TokenUsage | null {
	const usage = (
		message as { usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown } }
	)?.usage_metadata;
	if (!usage) return null;
	const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	return { inputTokens: input, outputTokens: output };
}

async function invokeChatModel(
	options: EnrichStoryboardOptions,
	prompt: { system: string; user: string },
	signal: AbortSignal,
): Promise<{ text: string; usage: TokenUsage | null }> {
	const model = await createOpenScreenChatModel({
		provider: options.provider,
		model: options.model,
		apiKey: options.apiKey,
		baseUrl: options.baseUrl,
		reasoningEffort: options.reasoningEffort,
	});
	const result = await model.invoke(
		[new SystemMessage(prompt.system), new HumanMessage(prompt.user)],
		{ signal },
	);
	return { text: messageContentToText(result.content), usage: readUsage(result) };
}

export async function enrichStoryboard(
	options: EnrichStoryboardOptions,
): Promise<EnrichStoryboardResult> {
	const { storyboard } = options;
	if (storyboard.scenes.length === 0) {
		return { success: true, storyboard, usage: null };
	}
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? ENRICH_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const forward = () => controller.abort();
	if (options.signal?.aborted) forward();
	else options.signal?.addEventListener("abort", forward, { once: true });

	const prompt = {
		system: SYSTEM_PROMPT,
		user: buildEnrichPrompt(storyboard, options.projectTitle, options.language),
	};
	let reply: { text: string; usage: TokenUsage | null };
	try {
		if (controller.signal.aborted) throw new Error("Cancelled before the request was sent.");
		reply = await (options.invoke ?? ((p, s) => invokeChatModel(options, p, s)))(
			prompt,
			controller.signal,
		);
	} catch (error) {
		return {
			success: false,
			storyboard,
			usage: null,
			error: timedOut
				? `The model did not answer within ${Math.round(timeoutMs / 1000)} s.`
				: controller.signal.aborted
					? "Cancelled."
					: error instanceof Error
						? error.message
						: String(error),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forward);
	}

	const parsed = parseEnrichReply(reply.text);
	if (!parsed) {
		return {
			success: false,
			storyboard,
			usage: reply.usage,
			error: "Could not read the model's reply as scene titles.",
		};
	}
	const byId = new Map(parsed.map((entry) => [entry.id, entry]));
	const at = (options.now ?? (() => new Date()))().toISOString();
	let named = 0;
	const scenes = storyboard.scenes.map((scene) => {
		const entry = byId.get(scene.id);
		// Only ids we sent: a hallucinated id names no scene and is dropped.
		if (!entry) return scene;
		named += 1;
		const kept = scene.inferred.filter((inference) => inference.source !== "llm");
		const added: AxcutStoryboardInference[] = [
			{
				kind: "title",
				text: entry.title,
				confidence: LLM_CONFIDENCE,
				source: "llm",
				model: options.model,
			},
			{
				kind: "summary",
				text: entry.summary,
				confidence: LLM_CONFIDENCE,
				source: "llm",
				model: options.model,
			},
		];
		return { ...scene, title: entry.title, inferred: [...kept, ...added] };
	});
	if (named === 0) {
		return {
			success: false,
			storyboard,
			usage: reply.usage,
			error: "The model's reply named none of the scenes.",
		};
	}
	return {
		success: true,
		usage: reply.usage,
		storyboard: {
			...storyboard,
			scenes,
			enrichment: { provider: options.provider, model: options.model, at },
		},
	};
}
