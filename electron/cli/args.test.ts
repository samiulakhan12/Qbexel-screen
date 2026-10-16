import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";

const CWD = path.resolve("/work");
const inCwd = (name: string) => path.resolve(CWD, name);

function parse(args: string[]) {
	return parseCliArgs(["electron", "app-path", ...args], 2, CWD);
}

describe("parseCliArgs", () => {
	it("returns null when no subcommand is present (GUI launch)", () => {
		expect(parse([])).toBeNull();
		expect(parse(["--some-chromium-flag"])).toBeNull();
	});

	it("skips leading Chromium switches before the subcommand (AppImage --no-sandbox)", () => {
		expect(parse(["--no-sandbox", "export", "demo.openscreen"])).toMatchObject({
			kind: "export",
			projectPath: inCwd("demo.openscreen"),
		});
		expect(parse(["--no-sandbox", "--enable-unsafe-swiftshader", "record"])).toMatchObject({
			kind: "record",
		});
		expect(parse(["--no-sandbox", "--help"])).toMatchObject({ kind: "help" });
		expect(parse(["--no-sandbox"])).toBeNull();
	});

	it("parses --composition and remembers whether --fps was typed", () => {
		const cmd = parse(["export", "demo.openscreen", "--composition", "Shorts / Reels"]);
		expect(cmd).toMatchObject({
			kind: "export",
			composition: "Shorts / Reels",
			mp4FrameRate: 60,
		});
		expect((cmd as { mp4FrameRateExplicit?: boolean }).mp4FrameRateExplicit).toBeUndefined();
		const typed = parse(["export", "demo.openscreen", "--composition", "comp_1", "--fps", "30"]);
		expect(typed).toMatchObject({
			composition: "comp_1",
			mp4FrameRate: 30,
			mp4FrameRateExplicit: true,
		});
		expect(parse(["export", "demo.openscreen", "--composition", " "])).toMatchObject({
			kind: "error",
		});
	});

	it("parses the storyboard, privacy scan and validate commands", () => {
		expect(
			parse(["storyboard", "demo.openscreen", "--apply", "cut", "--outro", "Bye", "--json"]),
		).toMatchObject({
			kind: "storyboard",
			projectPath: inCwd("demo.openscreen"),
			apply: "cut",
			outroText: "Bye",
			dryRun: false,
			json: true,
		});
		expect(parse(["storyboard", "demo.openscreen", "--apply", "nope"])).toMatchObject({
			kind: "error",
		});
		expect(
			parse([
				"privacy",
				"scan",
				"demo.openscreen",
				"--sample-ms",
				"4000",
				"--no-ocr",
				"--fail-on-findings",
			]),
		).toMatchObject({
			kind: "privacy-scan",
			projectPath: inCwd("demo.openscreen"),
			sampleEveryMs: 4000,
			noOcr: true,
			failOnFindings: true,
		});
		expect(parse(["privacy", "demo.openscreen"])).toMatchObject({ kind: "error" });
		expect(parse(["privacy", "scan", "demo.openscreen", "--sample-ms", "10"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["validate", "demo.openscreen", "--json"])).toMatchObject({
			kind: "validate",
			projectPath: inCwd("demo.openscreen"),
			json: true,
		});
		expect(parse(["validate"])).toMatchObject({ kind: "error" });
	});

	it("parses a minimal export command and resolves relative paths", () => {
		const cmd = parse(["export", "demo.openscreen"]);
		expect(cmd).toMatchObject({
			kind: "export",
			projectPath: inCwd("demo.openscreen"),
			outPath: null,
			format: null,
		});
	});

	it("parses export options and infers format from --out extension", () => {
		const cmd = parse([
			"export",
			"/p/demo.openscreen",
			"-o",
			"out.gif",
			"--gif-fps",
			"20",
			"--json",
		]);
		expect(cmd).toMatchObject({
			kind: "export",
			outPath: inCwd("out.gif"),
			format: "gif",
			gifFrameRate: 20,
			json: true,
		});
	});

	it("rejects a --format that conflicts with the --out extension", () => {
		const cmd = parse(["export", "a.openscreen", "-o", "x.mp4", "--format", "gif"]);
		expect(cmd).toMatchObject({ kind: "error" });
	});

	it("rejects export without a project path", () => {
		expect(parse(["export"])).toMatchObject({ kind: "error" });
	});

	it("parses voiceover audio options", () => {
		const cmd = parse([
			"export",
			"a.openscreen",
			"--audio",
			"voice.mp3",
			"--audio-mode",
			"replace",
			"--audio-offset",
			"1.5",
		]);
		expect(cmd).toMatchObject({
			kind: "export",
			audioPath: inCwd("voice.mp3"),
			audioMode: "replace",
			audioOffsetSec: 1.5,
		});
	});

	it("defaults audio mode to mix and rejects --audio with gif", () => {
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3"])).toMatchObject({
			audioMode: "mix",
			audioOffsetSec: 0,
		});
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3", "--format", "gif"])).toMatchObject({
			kind: "error",
		});
		// gif inferred from --out, with no explicit --format
		expect(parse(["export", "a.openscreen", "--audio", "v.mp3", "-o", "out.gif"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["export", "a.openscreen", "--audio-offset", "-1"])).toMatchObject({
			kind: "error",
		});
	});

	it("parses record defaults", () => {
		expect(parse(["record"])).toMatchObject({
			kind: "record",
			displayIndex: 0,
			windowTitle: null,
			mic: false,
			systemAudio: false,
			camera: false,
			cameraDevice: null,
			cursorMode: "editable-overlay",
			durationMs: null,
		});
	});

	it("parses the camera: --camera for the default one, --camera-device for one by name", () => {
		expect(parse(["record", "--camera"])).toMatchObject({ camera: true, cameraDevice: null });
		expect(parse(["record", "--camera-device", "BRIO"])).toMatchObject({
			camera: true,
			cameraDevice: "BRIO",
		});
		expect(parse(["record", "--camera-device"])).toMatchObject({ kind: "error" });
	});

	it("parses record options", () => {
		const cmd = parse([
			"record",
			"--display",
			"1",
			"--mic-device",
			"MacBook",
			"--system-audio",
			"--duration",
			"12.5",
			"--project",
			"demo.openscreen",
		]);
		expect(cmd).toMatchObject({
			kind: "record",
			displayIndex: 1,
			mic: true,
			micDevice: "MacBook",
			systemAudio: true,
			durationMs: 12500,
			projectOut: inCwd("demo.openscreen"),
		});
	});

	it("rejects invalid record values", () => {
		expect(parse(["record", "--duration", "0"])).toMatchObject({ kind: "error" });
		expect(parse(["record", "--cursor", "off"])).toMatchObject({ kind: "error" });
		expect(parse(["record", "--project", "demo.json"])).toMatchObject({ kind: "error" });
	});

	it("parses the Export dialog's frame rates, GIF sizes and GIF loop", () => {
		expect(parse(["export", "a.openscreen"])).toMatchObject({ mp4FrameRate: 60, gifLoop: null });
		expect(parse(["export", "a.openscreen", "--fps", "24"])).toMatchObject({ mp4FrameRate: 24 });
		expect(parse(["export", "a.openscreen", "--fps", "25"])).toMatchObject({ kind: "error" });
		expect(parse(["export", "a.openscreen", "--gif-size", "small"])).toMatchObject({
			gifSizePreset: "small",
		});
		expect(parse(["export", "a.openscreen", "--gif-size", "toString"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["export", "a.openscreen", "--no-gif-loop"])).toMatchObject({ gifLoop: false });
		expect(parse(["export", "a.openscreen", "--gif-loop"])).toMatchObject({ gifLoop: true });
		expect(parse(["export", "a.openscreen", "-o", "x.gif", "--quality", "good"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["export", "a.openscreen", "--format", "gif", "--fps", "30"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["export", "a.openscreen", "-o", "a.mp4", "--no-gif-loop"])).toMatchObject({
			kind: "error",
			message: "--no-gif-loop is only supported for GIF exports",
		});
	});

	it("parses --auto-zoom", () => {
		expect(parse(["export", "a.openscreen", "--auto-zoom"])).toMatchObject({
			kind: "export",
			autoZoom: true,
		});
		expect(parse(["export", "a.openscreen"])).toMatchObject({ autoZoom: false });
	});

	it("parses sources", () => {
		expect(parse(["sources", "--json"])).toMatchObject({ kind: "sources", json: true });
		expect(parse(["sources", "--bogus"])).toMatchObject({ kind: "error" });
		expect(parse(["sources", "extra-arg"])).toMatchObject({ kind: "error" });
	});

	it("parses the sources output file, resolved against cwd", () => {
		expect(parse(["sources", "-o", "s.json"])).toMatchObject({
			kind: "sources",
			jsonOutPath: inCwd("s.json"),
		});
		expect(parse(["sources", "--json", "--out", "s.json"])).toMatchObject({
			kind: "sources",
			json: true,
			jsonOutPath: inCwd("s.json"),
		});
		// The flag is optional; absent means stdout stays the only channel.
		expect(parse(["sources"])).toMatchObject({ kind: "sources", jsonOutPath: undefined });
		expect(parse(["sources", "--out"])).toMatchObject({ kind: "error" });
	});

	it("rejects an empty flag value rather than resolving it to cwd", () => {
		// `openscreen sources -o "$OUT"` with OUT unset arrives as an empty
		// argument. resolvePath would turn it into cwd, which only fails later as
		// EISDIR from the write; the omitted-value spelling is the same mistake and
		// must get the same answer.
		expect(parse(["sources", "-o", ""])).toMatchObject({ kind: "error" });
		// takeValue is shared, so every flag that takes a value gets this.
		expect(parse(["pack", "demo.openscreen", "--out", ""])).toMatchObject({ kind: "error" });
		expect(parse(["export", "demo.openscreen", "-o", ""])).toMatchObject({ kind: "error" });
	});

	it("parses pack", () => {
		expect(parse(["pack", "demo.openscreen", "--out", "bundle"])).toMatchObject({
			kind: "pack",
			projectPath: inCwd("demo.openscreen"),
			outDir: inCwd("bundle"),
		});
		expect(parse(["pack", "demo.openscreen"])).toMatchObject({ kind: "error" });
		expect(parse(["pack", "--out", "bundle"])).toMatchObject({ kind: "error" });
		expect(parse(["pack", "demo.openscreen", "--out", "bundle", "--bogus"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["pack", "a.openscreen", "b.openscreen", "--out", "bundle"])).toMatchObject({
			kind: "error",
		});
	});

	it("parses captions", () => {
		expect(
			parse(["captions", "demo.openscreen", "--min-words", "1", "--max-words", "5"]),
		).toMatchObject({
			kind: "captions",
			projectPath: inCwd("demo.openscreen"),
			minWordsPerCaption: 1,
			maxWordsPerCaption: 5,
		});
		expect(parse(["captions", "demo.openscreen"])).toMatchObject({
			minWordsPerCaption: 2,
			maxWordsPerCaption: 7,
		});
		expect(
			parse(["captions", "a.openscreen", "--min-words", "9", "--max-words", "3"]),
		).toMatchObject({ kind: "error" });
	});

	it("bounds caption word counts to what the editor's caption settings allow", () => {
		expect(parse(["captions", "a.openscreen", "--max-words", "12"])).toMatchObject({
			maxWordsPerCaption: 12,
		});
		expect(parse(["captions", "a.openscreen", "--max-words", "13"])).toMatchObject({
			kind: "error",
			message: expect.stringContaining("from 1 to 12"),
		});
		expect(parse(["captions", "a.openscreen", "--min-words", "0"])).toMatchObject({
			kind: "error",
		});
	});

	it("parses mcp, which takes no argument", () => {
		expect(parse(["mcp"])).toEqual({ kind: "mcp" });
		expect(parse(["mcp", "--port", "1"])).toMatchObject({ kind: "error" });
	});

	it("parses info and help", () => {
		expect(parse(["info", "demo.openscreen", "--json"])).toMatchObject({
			kind: "info",
			projectPath: inCwd("demo.openscreen"),
			json: true,
		});
		expect(parse(["help"])).toMatchObject({ kind: "help" });
		expect(parse(["--help"])).toMatchObject({ kind: "help" });
	});
});

describe("subtitles", () => {
	it("defaults to SRT beside the project", () => {
		expect(parse(["subtitles", "demo.openscreen"])).toEqual({
			kind: "subtitles",
			projectPath: inCwd("demo.openscreen"),
			format: "srt",
			outPath: null,
			json: false,
		});
	});

	it("takes a format and an output path that agree", () => {
		expect(
			parse(["subtitles", "demo.openscreen", "--format", "vtt", "-o", "captions.vtt", "--json"]),
		).toEqual({
			kind: "subtitles",
			projectPath: inCwd("demo.openscreen"),
			format: "vtt",
			outPath: inCwd("captions.vtt"),
			json: true,
		});
	});

	it("refuses an unknown format, a mismatched extension and a missing project", () => {
		expect(parse(["subtitles", "demo.openscreen", "--format", "ass"])).toMatchObject({
			kind: "error",
		});
		expect(parse(["subtitles", "demo.openscreen", "--format", "vtt", "-o", "x.srt"])).toMatchObject(
			{
				kind: "error",
			},
		);
		expect(parse(["subtitles"])).toMatchObject({ kind: "error" });
	});
});
