// Rolling backups of a project file, taken before each save overwrites it.
//
// The document service writes atomically, so a crash never leaves a torn file. What it did
// not protect against is a save that is whole and wrong: an agent turn that cut the wrong
// minute, a hand edit, a bug. Undo covers that for the session; these cover it afterwards.
//
// Before a save renames its temp file over `<id>.openscreen`, the previous file is copied to
// `backups/<id>/<ISO timestamp>.openscreen`. At most one copy per `minIntervalMs` (a typing
// session saves on every keystroke) and at most `keep` copies per project; older ones go.
// Pure except for the injected filesystem, so the policy is tested without a disk.

import fs from "node:fs/promises";
import path from "node:path";

export const BACKUP_KEEP = 10;
export const BACKUP_MIN_INTERVAL_MS = 60_000;
export const BACKUPS_DIR_NAME = "backups";

export interface BackupFs {
	copyFile(from: string, to: string): Promise<void>;
	mkdir(dir: string): Promise<void>;
	readdir(dir: string): Promise<string[]>;
	rm(filePath: string): Promise<void>;
	stat(filePath: string): Promise<{ mtimeMs: number } | null>;
}

const nodeFs: BackupFs = {
	copyFile: (from, to) => fs.copyFile(from, to),
	mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
	readdir: (dir) => fs.readdir(dir).catch(() => []),
	rm: (filePath) => fs.rm(filePath, { force: true }),
	stat: (filePath) =>
		fs
			.stat(filePath)
			.then((s) => ({ mtimeMs: s.mtimeMs }))
			.catch(() => null),
};

export interface BackupOptions {
	keep?: number;
	minIntervalMs?: number;
	now?: () => number;
	io?: BackupFs;
}

/** Where a project's backups live, beside the projects. */
export function backupsDirFor(projectsDir: string, projectId: string): string {
	return path.join(projectsDir, BACKUPS_DIR_NAME, projectId);
}

/** ISO timestamp as a file name: colons are not allowed on Windows. */
export function backupFileName(atMs: number, extension: string): string {
	return `${new Date(atMs).toISOString().replace(/[:.]/g, "-")}${extension}`;
}

export function parseBackupTime(fileName: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(fileName);
	if (!match) return null;
	const [, y, mo, d, h, mi, s, ms] = match;
	return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
}

export interface BackupResult {
	/** The copy written, or null when none was due or the source did not exist yet. */
	written: string | null;
	/** Older copies removed to stay within `keep`. */
	pruned: string[];
}

/**
 * Takes a backup of `filePath` into `backupsDir` if the newest one there is older than the
 * interval, then prunes to `keep`. Never throws: a backup that fails must not fail the save.
 */
export async function rotateBackup(
	filePath: string,
	backupsDir: string,
	options: BackupOptions = {},
): Promise<BackupResult> {
	const io = options.io ?? nodeFs;
	const keep = options.keep ?? BACKUP_KEEP;
	const minIntervalMs = options.minIntervalMs ?? BACKUP_MIN_INTERVAL_MS;
	const now = (options.now ?? Date.now)();
	const result: BackupResult = { written: null, pruned: [] };
	try {
		if (!(await io.stat(filePath))) return result; // first save of a new project
		const extension = path.extname(filePath);
		const existing = (await io.readdir(backupsDir))
			.filter((name) => name.endsWith(extension) && parseBackupTime(name) !== null)
			.sort();
		const newest = existing.length ? parseBackupTime(existing[existing.length - 1]) : null;
		if (newest !== null && now - newest < minIntervalMs) return result;
		await io.mkdir(backupsDir);
		const target = path.join(backupsDir, backupFileName(now, extension));
		await io.copyFile(filePath, target);
		result.written = target;
		const all = [...existing, path.basename(target)].sort();
		for (const stale of all.slice(0, Math.max(0, all.length - keep))) {
			await io.rm(path.join(backupsDir, stale));
			result.pruned.push(stale);
		}
	} catch (error) {
		console.warn("[project-backups] backup skipped:", error);
	}
	return result;
}

/** The backups of a project, newest first. */
export async function listBackups(
	backupsDir: string,
	extension: string,
	io: BackupFs = nodeFs,
): Promise<Array<{ path: string; atMs: number }>> {
	const names = await io.readdir(backupsDir);
	return names
		.filter((name) => name.endsWith(extension))
		.map((name) => ({ path: path.join(backupsDir, name), atMs: parseBackupTime(name) ?? 0 }))
		.filter((entry) => entry.atMs > 0)
		.sort((a, b) => b.atMs - a.atMs);
}
