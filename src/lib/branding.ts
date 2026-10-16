// Product identity, read from branding.json at the repository root.
//
// Both processes import this module (relative import, no `@/` alias, like the schema), so it
// stays free of DOM and Electron. The JSON is validated once at load: a build with a broken
// branding file fails at startup rather than shipping a half-renamed product.
//
// What is deliberately NOT configurable here: the project file extension, the style preset
// extension and the MCP server name are kept as they were in OpenScreen so existing user
// projects, presets and agent set-ups keep working. They are exposed as constants so the
// rest of the code reads one source, but changing them is a migration, not a setting.

import { z } from "zod";
import brandingJson from "../../branding.json";

const httpsUrl = z.string().url().startsWith("https://");

const repositorySchema = z
	.object({
		/** GitHub owner, e.g. `qbexel`. */
		owner: z.string().min(1),
		/** GitHub repository name. */
		repo: z.string().min(1),
	})
	.nullable();

const brandingSchema = z.object({
	$comment: z.string().optional(),
	/** The full product name, as shown in the title bar, the About box and the installer. */
	productName: z.string().min(1).max(60),
	/** A shorter form for tight surfaces (tray tooltip, toasts). */
	shortName: z.string().min(1).max(30),
	vendor: z.string().min(1).max(60),
	/** Reverse-DNS application id, electron-builder's `appId`. */
	appId: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/i),
	/** The executable's base name: no spaces, so the CLI is easy to invoke from a shell. */
	executableName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
	/** The name the CLI usage text and docs refer to the executable by. */
	cliName: z.string().regex(/^[a-z][a-z0-9-]*$/),
	website: httpsUrl,
	/** Stamped into the binaries and shown in About. Must keep the upstream MIT notice. */
	copyright: z.string().min(1).includes("OpenScreen contributors"),
	/** Where the source lives, for the star prompt and the Help menu. `null` hides both. */
	repository: repositorySchema,
	/** The GitHub repository releases are published to and updates are checked against.
	 *  `null` turns every update check off (the menu entries disappear). */
	updates: repositorySchema,
	telemetry: z.object({
		/** A PostHog project token, or `null` for no usage ping at all. */
		posthogToken: z.string().min(1).nullable(),
	}),
	assets: z.object({
		/** Where the CTC word-aligner models are downloaded from on first use. */
		ctcAlignerBaseUrl: httpsUrl,
	}),
	projectFileExtension: z.literal(".openscreen"),
	stylePresetExtension: z.literal(".openscreenpreset"),
	mcpServerName: z.literal("openscreen"),
	upstream: z.object({
		name: z.literal("OpenScreen"),
		repository: httpsUrl,
		website: httpsUrl,
	}),
});

export type Branding = z.infer<typeof brandingSchema>;

/** Parses a branding document; exported so the test and a build script can check one. */
export function parseBranding(raw: unknown): Branding {
	return brandingSchema.parse(raw);
}

export const BRAND: Branding = parseBranding(brandingJson);

/** `https://github.com/<owner>/<repo>` for a repository entry, or `null`. */
export function repositoryUrl(repository: Branding["repository"]): string | null {
	return repository ? `https://github.com/${repository.owner}/${repository.repo}` : null;
}

/** The interpolation variables every locale string may use, e.g. `{{product}}`. */
export const BRAND_I18N_VARIABLES = {
	product: BRAND.productName,
	productShort: BRAND.shortName,
	vendor: BRAND.vendor,
} as const;
