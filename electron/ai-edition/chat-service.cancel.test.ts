// Stopping a chat turn: the Stop button (`cancelChat`) and the stall watchdog both abort
// the signal `runChat` hands the agent, and the turn then resolves as `cancelled` rather
// than as a failure or a reply.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./deep-agent/service", () => ({
	invokeOpenScreenAgent: vi.fn(),
}));

import { cancelChat, createSession, runChat } from "./chat-service";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import type { LlmConfigStore } from "./llm-config-store";

const invokeMock = vi.mocked(invokeOpenScreenAgent);

function stubConfig(): LlmConfigStore {
	return {
		getConfig: () => ({ provider: "openai", model: "gpt-4o" }),
		getCredential: () => ({ kind: "api-key", value: "sk-test", source: "stored" }),
	} as unknown as LlmConfigStore;
}

/** An agent that answers only when its signal is aborted, as a real stream would. */
function hangingAgent() {
	invokeMock.mockImplementation(
		(args) =>
			new Promise((resolve) => {
				args.signal?.addEventListener(
					"abort",
					() =>
						resolve({
							text: "",
							document: args.document,
							mutated: false,
							reason: "Cancelled.",
							cancelled: true,
						}),
					{ once: true },
				);
			}),
	);
}

const PROJECT = "proj_cancel";

beforeEach(() => {
	invokeMock.mockReset();
});

describe("cancelChat", () => {
	it("stops the running turn, which resolves as cancelled", async () => {
		hangingAgent();
		const session = createSession(PROJECT, "s");
		const pending = runChat(PROJECT, session.id, "do the thing", stubConfig());
		// The turn registers itself synchronously up to its first await; give it one tick.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cancelChat(PROJECT, session.id)).toBe(true);
		const result = await pending;
		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(true);
		expect(result.error).toBe("Stopped.");
		expect(invokeMock).toHaveBeenCalledTimes(1);
		expect(invokeMock.mock.calls[0][0].signal?.aborted).toBe(true);
	});

	it("answers false when nothing is running for the session", () => {
		expect(cancelChat(PROJECT, "nope")).toBe(false);
	});

	it("is forgotten once the turn ended", async () => {
		invokeMock.mockResolvedValue({ text: "done", document: {} as never, mutated: false });
		const session = createSession(PROJECT, "s2");
		const result = await runChat(PROJECT, session.id, "hi", stubConfig());
		expect(result.success).toBe(true);
		expect(cancelChat(PROJECT, session.id)).toBe(false);
	});
});

describe("the stall watchdog", () => {
	it("stops a turn that sends nothing for the timeout and says so", async () => {
		hangingAgent();
		const session = createSession(PROJECT, "s3");
		const result = await runChat(
			PROJECT,
			session.id,
			"hi",
			stubConfig(),
			undefined,
			{},
			{
				stallTimeoutMs: 30,
			},
		);
		expect(result.success).toBe(false);
		expect(result.cancelled).toBe(true);
		expect(result.error).toMatch(/sent nothing/);
	});

	it("is reset by every delta, so a slow but live turn is not stopped", async () => {
		invokeMock.mockImplementation(async (args) => {
			for (let i = 0; i < 4; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (args.signal?.aborted) {
					return { text: "", document: args.document, mutated: false, cancelled: true };
				}
				args.sink.text("word ");
			}
			return { text: "word word word word", document: args.document, mutated: false };
		});
		const session = createSession(PROJECT, "s4");
		const result = await runChat(
			PROJECT,
			session.id,
			"hi",
			stubConfig(),
			undefined,
			{},
			{
				stallTimeoutMs: 50,
			},
		);
		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("word word word word");
	});
});
