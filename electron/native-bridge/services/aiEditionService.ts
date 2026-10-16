import type { CursorTelemetryPoint } from "../../../src/components/video-editor/types";
import { analyzeStoryboard } from "../../../src/lib/ai-edition/director/analyze";
import { type AxcutDocument, documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	AiEditionAssetResult,
	AiEditionCaptionTranslateResult,
	AiEditionChatBudget,
	AiEditionChatCancelResult,
	AiEditionChatCompactResult,
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionChatRewindResult,
	AiEditionChatSession,
	AiEditionChatSessionSummary,
	AiEditionDirectorAnalyzeResult,
	AiEditionDirectorApplyResult,
	AiEditionDocumentResult,
	AiEditionLlmConfig,
	AiEditionLlmDisconnectResult,
	AiEditionLlmSnapshot,
	AiEditionMcpStatus,
	AiEditionProjectSummary,
} from "../../../src/native/contracts";
import {
	type CaptionTranslateSegment,
	translateCaptionSegments,
} from "../../ai-edition/caption-translate";
import type { ChatEventSink } from "../../ai-edition/chat-service";
import { applyStoryboardSuggestions } from "../../ai-edition/director/apply";
import { enrichStoryboard } from "../../ai-edition/director/enrich";
import type { DocumentService } from "../../ai-edition/document-service";
import type { LlmConfigStore, LlmCredential } from "../../ai-edition/llm-config-store";
import {
	listAnthropicModels,
	listGoogleModels,
	listMistralModels,
	listOpenAiCompatibleModels,
	listOpenRouterModels,
	probeMiniMaxModels,
} from "../../ai-edition/llm-provider-auth";
import { PROVIDER_DEFINITIONS } from "../../ai-edition/provider-registry";
import type { McpController } from "../../mcp/mcp-controller";

export interface AiEditionServiceOptions {
	documents: DocumentService;
	deleteChatHistory?: (projectId: string) => Promise<void>;
	/**
	 * A factory, not an instance: building `LlmConfigStore` does two sync
	 * readFileSync plus a `safeStorage` decrypt, and on macOS that decrypt is
	 * backed by a Keychain item — so resolving it while wiring the bridge made
	 * every app launch prompt for Keychain access, including for users who never
	 * open the AI layer. The caller memoises, so this still yields one instance.
	 * Nothing here may call it at construction time; every use sits behind a
	 * method the renderer has to invoke first.
	 */
	llmConfig: () => LlmConfigStore;
	runChat: (
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
		sink?: ChatEventSink,
	) => Promise<AiEditionChatResult>;
	rewindToMessage: (
		projectId: string,
		sessionId: string,
		messageId: string,
	) =>
		| {
				success: true;
				prompt: string;
				document: unknown;
				messages: AiEditionChatMessage[];
		  }
		| { success: false; error: string };
	compactNow: (projectId: string, sessionId: string) => Promise<AiEditionChatCompactResult | null>;
	getContextUsage: (
		projectId: string,
		sessionId: string,
	) => { usedTokens: number; budgetTokens: number; ratio: number; fillPercent: number } | null;
	// ponytail: legacy per-batch undo retired in favor of per-message rewind.
	// Kept on the surface for IPC compatibility; always returns success=false.
	undoLastToolBatch: (projectId: string, sessionId: string) => AiEditionChatResult;
	listSessions: (projectId: string) => AiEditionChatSessionSummary[];
	createSession: (projectId: string, title?: string) => AiEditionChatSessionSummary;
	selectSession: (projectId: string, sessionId: string) => AiEditionChatSession | null;
	renameSession: (
		projectId: string,
		sessionId: string,
		title: string,
	) => AiEditionChatSessionSummary | null;
	deleteSession: (projectId: string, sessionId: string) => boolean;
	/** Stops the turn running for a session; absent where no chat runs (tests). */
	cancelChat?: (projectId: string, sessionId: string) => boolean;
	/** The local MCP server. Absent where no server is wired (tests, headless CLI). */
	mcp?: McpController;
	/** Cursor telemetry of a recording, by its video path, for the Director's click events
	 *  and zoom suggestions. Absent → the analysis runs on the transcript alone. */
	loadCursorTelemetry?: (
		videoPath: string,
	) => Promise<{ success: boolean; samples?: CursorTelemetryPoint[] }>;
}

export class AiEditionService {
	constructor(private readonly options: AiEditionServiceOptions) {}

	private llmConfigInstance: LlmConfigStore | null = null;

	/**
	 * Resolves the store on first use, then holds it — `llmGetSnapshot` alone
	 * reads it once per provider definition. See `AiEditionServiceOptions.llmConfig`.
	 */
	private get llmConfig(): LlmConfigStore {
		if (!this.llmConfigInstance) {
			this.llmConfigInstance = this.options.llmConfig();
		}
		return this.llmConfigInstance;
	}

	async listProjects(): Promise<AiEditionProjectSummary[]> {
		return this.options.documents.listProjects();
	}

	async get(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.getProject(projectId);
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async create(title?: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.createProject(title ?? "");
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async save(document: unknown): Promise<AiEditionDocumentResult> {
		try {
			const parsed = documentSchema.parse(document);
			const saved = await this.options.documents.saveProject(parsed);
			return { success: true, document: saved };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async deleteProject(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.documents.deleteProject(projectId);
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			await this.options.deleteChatHistory?.(projectId);
		} catch (error) {
			// The project is already gone: a chat file left behind is orphaned data,
			// not a failed delete.
			console.warn(`[ai-edition] could not remove chat history for ${projectId}:`, error);
		}
		return { success: true };
	}

	async addAsset(
		projectId: string,
		path: string,
		label?: string,
		kind?: "video" | "audio",
	): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.addAsset(projectId, { path, label, kind });
		// The just-added asset is always the last one; primaryAssetId is only a
		// fallback for the video case and would point at the wrong asset for an
		// audio import (which never claims primary), so prefer the tail.
		const assetId = document.assets.at(-1)?.id ?? document.project.primaryAssetId ?? "";
		return { assetId, document };
	}

	async removeAsset(projectId: string, assetId: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.removeAsset(projectId, assetId);
		return { assetId, document };
	}

	async llmGetSnapshot(): Promise<AiEditionLlmSnapshot> {
		const config = this.llmConfig.getConfig();
		const credentialSummary: AiEditionLlmSnapshot["credentialSummary"] = [];
		const connectedProviders: string[] = [];
		for (const def of PROVIDER_DEFINITIONS) {
			const resolved = this.llmConfig.getCredential(def.id, def.envKeys);
			const connected = Boolean(resolved);
			if (connected) connectedProviders.push(def.id);
			credentialSummary.push({
				providerId: def.id,
				connected,
				authKind: def.authKind,
				credentialKind: resolved ? resolved.entry.kind : null,
			});
		}
		return {
			config,
			connectedProviders,
			availableProviders: PROVIDER_DEFINITIONS.map((d) => ({
				id: d.id,
				label: d.label,
				authKind: d.authKind,
			})),
			credentialSummary,
		};
	}

	async llmSetConfig(config: AiEditionLlmConfig): Promise<AiEditionDocumentResult> {
		try {
			await this.llmConfig.setConfig(config);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmSetApiKey(providerId: string, apiKey: string): Promise<AiEditionDocumentResult> {
		try {
			const entry: LlmCredential = { kind: "api-key", apiKey };
			await this.llmConfig.setCredential(providerId, entry);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmRemoveApiKey(providerId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.llmConfig.removeCredential(providerId);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async llmDisconnect(providerId: string): Promise<AiEditionLlmDisconnectResult> {
		await this.llmConfig.removeCredential(providerId);
		const active = this.llmConfig.getConfig();
		if (active?.provider === providerId) {
			await this.llmConfig.setConfig({
				provider: "",
				model: "",
			});
		}
		return { success: true, snapshot: await this.llmGetSnapshot() };
	}

	async llmListProviderModels(providerId: string): Promise<{ models: string[]; error?: string }> {
		try {
			const def = PROVIDER_DEFINITIONS.find((d) => d.id === providerId);
			if (!def) return { models: [], error: `Unknown provider ${providerId}` };
			const cred = this.llmConfig.getCredential(providerId, def.envKeys);
			if (!cred) return { models: [], error: "Not connected" };
			const config = this.llmConfig.getConfig();
			const baseUrl = (config?.provider === providerId ? config.baseUrl : undefined) ?? def.baseUrl;

			if (providerId === "anthropic") {
				return { models: await listAnthropicModels(cred.value) };
			}
			if (providerId === "google") {
				return { models: await listGoogleModels(cred.value) };
			}
			if (providerId === "mistral") {
				return { models: await listMistralModels(cred.value) };
			}
			if (providerId === "openrouter") {
				return { models: await listOpenRouterModels() };
			}
			if (providerId === "minimax" || providerId === "minimax-token-plan") {
				return { models: await probeMiniMaxModels(cred.value, baseUrl) };
			}
			if (providerId === "openai" || providerId === "openai-compatible") {
				if (!baseUrl) return { models: [], error: "Missing base URL" };
				return { models: await listOpenAiCompatibleModels(baseUrl, cred.value) };
			}
			return { models: [], error: `Provider ${providerId} does not expose a dynamic model list` };
		} catch (error) {
			return { models: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	private get mcp(): McpController {
		if (!this.options.mcp) throw new Error("The MCP server is not available in this build.");
		return this.options.mcp;
	}

	mcpGetStatus(): Promise<AiEditionMcpStatus> {
		return this.mcp.getStatus();
	}

	mcpSetEnabled(enabled: boolean): Promise<AiEditionMcpStatus> {
		return this.mcp.setEnabled(enabled);
	}

	mcpSetPort(port: number): Promise<AiEditionMcpStatus> {
		return this.mcp.setPort(port);
	}

	mcpSetAllowEdits(allowEdits: boolean): Promise<AiEditionMcpStatus> {
		return this.mcp.setAllowEdits(allowEdits);
	}

	mcpRegenerateToken(): Promise<AiEditionMcpStatus> {
		return this.mcp.regenerateToken();
	}

	async chatRun(
		projectId: string,
		sessionId: string,
		message: string,
		document?: unknown,
		sink?: ChatEventSink,
	): Promise<AiEditionChatResult> {
		return this.options.runChat(projectId, sessionId, message, document, sink);
	}

	chatUndoLastBatch(_projectId: string, _sessionId: string): AiEditionChatResult {
		return { success: false, error: "Per-tool-batch undo retired in favor of per-message rewind." };
	}

	chatRewindToMessage(
		projectId: string,
		sessionId: string,
		messageId: string,
	): AiEditionChatRewindResult | { success: false; error: string } {
		return this.options.rewindToMessage(projectId, sessionId, messageId);
	}

	chatContextUsage(projectId: string, sessionId: string): AiEditionChatBudget | null {
		return this.options.getContextUsage(projectId, sessionId);
	}

	chatCompactNow(projectId: string, sessionId: string): Promise<AiEditionChatCompactResult | null> {
		return this.options.compactNow(projectId, sessionId);
	}

	chatListSessions(projectId: string): AiEditionChatSessionSummary[] {
		return this.options.listSessions(projectId);
	}

	chatCreateSession(projectId: string, title?: string): AiEditionChatSessionSummary {
		return this.options.createSession(projectId, title);
	}

	chatSelectSession(projectId: string, sessionId: string): AiEditionChatSession | null {
		return this.options.selectSession(projectId, sessionId);
	}

	chatRenameSession(
		projectId: string,
		sessionId: string,
		title: string,
	): AiEditionChatSessionSummary | null {
		return this.options.renameSession(projectId, sessionId, title);
	}

	chatDeleteSession(projectId: string, sessionId: string): { success: boolean } {
		return { success: this.options.deleteSession(projectId, sessionId) };
	}

	chatMessages(projectId: string, sessionId: string): AiEditionChatMessage[] {
		const session = this.options.selectSession(projectId, sessionId);
		return session?.messages ?? [];
	}

	chatBudget(projectId: string, sessionId: string): AiEditionChatBudget | null {
		const usage = this.options.getContextUsage(projectId, sessionId);
		if (!usage) return null;
		return {
			usedTokens: usage.usedTokens,
			budgetTokens: usage.budgetTokens,
			ratio: usage.ratio,
			fillPercent: usage.fillPercent,
		};
	}

	async chatCompact(
		projectId: string,
		sessionId: string,
	): Promise<AiEditionChatCompactResult | null> {
		const result = await this.options.compactNow(projectId, sessionId);
		if (!result) return null;
		return result;
	}

	/**
	 * Translate transcript segments for the caption layer, using whichever
	 * provider/model the chat is already configured with. Returns a plain
	 * `segmentId → text` map: the caller writes it into the document's caption
	 * translation layer, so nothing here can touch the transcript SSOT.
	 */
	chatCancel(projectId: string, sessionId: string): AiEditionChatCancelResult {
		return { cancelled: this.options.cancelChat?.(projectId, sessionId) ?? false };
	}

	async captionsTranslate(input: {
		segments: CaptionTranslateSegment[];
		targetLanguage: string;
		sourceLanguage?: string;
	}): Promise<AiEditionCaptionTranslateResult> {
		const config = this.llmConfig.getConfig();
		if (!config) {
			return {
				success: false,
				segments: {},
				error: "No AI provider is configured. Connect one in the agent settings first.",
			};
		}
		const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
		const credential = def ? this.llmConfig.getCredential(def.id, def.envKeys) : null;
		const result = await translateCaptionSegments({
			segments: input.segments,
			targetLanguage: input.targetLanguage,
			sourceLanguage: input.sourceLanguage,
			provider: config.provider,
			model: config.model,
			apiKey: credential?.value ?? "",
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
		});
		return { ...result, model: config.model };
	}

	/**
	 * The Tutorial Director. Deterministic analysis first (scenes, observed events,
	 * suggestions); then, only when asked, the configured model names the scenes. A model
	 * failure does not fail the call: the storyboard is returned with a `warning`, since
	 * the facts in it do not depend on the model.
	 */
	async directorAnalyze(input: {
		document: unknown;
		enrich?: boolean;
		outroText?: string;
	}): Promise<AiEditionDirectorAnalyzeResult> {
		const parsed = documentSchema.safeParse(input.document);
		if (!parsed.success) {
			return { success: false, enriched: false, error: "The document snapshot is not valid." };
		}
		const document = parsed.data;
		const telemetryByAssetId = await this.telemetryForDocument(document);
		let storyboard = analyzeStoryboard(document, {
			telemetryByAssetId,
			previous: document.storyboard,
			outroText: input.outroText,
		});
		if (!input.enrich || storyboard.scenes.length === 0) {
			return { success: true, enriched: false, storyboard };
		}
		const config = this.llmConfig.getConfig();
		if (!config) {
			return {
				success: true,
				enriched: false,
				storyboard,
				warning: "No AI provider is configured. Connect one in the agent settings first.",
			};
		}
		const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
		const credential = def ? this.llmConfig.getCredential(def.id, def.envKeys) : null;
		const language =
			document.transcripts.find((transcript) => transcript.language !== "auto")?.language ??
			undefined;
		const enriched = await enrichStoryboard({
			storyboard,
			projectTitle: document.project.title,
			language,
			provider: config.provider,
			model: config.model,
			apiKey: credential?.value ?? "",
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
		});
		if (!enriched.success) {
			return {
				success: true,
				enriched: false,
				storyboard,
				model: config.model,
				usage: enriched.usage,
				warning: enriched.error,
			};
		}
		storyboard = enriched.storyboard;
		return {
			success: true,
			enriched: true,
			storyboard,
			model: config.model,
			usage: enriched.usage,
		};
	}

	/** Each video asset's telemetry in its own source time, read in parallel. */
	private async telemetryForDocument(
		document: AxcutDocument,
	): Promise<Map<string, CursorTelemetryPoint[]>> {
		const load = this.options.loadCursorTelemetry;
		const out = new Map<string, CursorTelemetryPoint[]>();
		if (!load) return out;
		const assets = document.assets.filter(
			(asset) =>
				asset.kind === "video" &&
				asset.originalPath &&
				document.timeline.clips.some((clip) => clip.assetId === asset.id),
		);
		await Promise.all(
			assets.map(async (asset) => {
				try {
					const result = await load(asset.originalPath);
					if (result.success && result.samples?.length) out.set(asset.id, result.samples);
				} catch {
					// No telemetry for this asset: the analysis goes on without click events.
				}
			}),
		);
		return out;
	}

	/** Applies the named suggestions through the agent tools; the renderer saves the result. */
	async directorApply(input: {
		document: unknown;
		suggestionIds: string[];
	}): Promise<AiEditionDirectorApplyResult> {
		const parsed = documentSchema.safeParse(input.document);
		if (!parsed.success) {
			return {
				success: false,
				applied: [],
				failed: [],
				skipped: [],
				error: "The document snapshot is not valid.",
			};
		}
		try {
			const result = applyStoryboardSuggestions(parsed.data, input.suggestionIds);
			return { success: true, ...result };
		} catch (error) {
			return {
				success: false,
				applied: [],
				failed: [],
				skipped: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
