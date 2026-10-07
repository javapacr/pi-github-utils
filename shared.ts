/**
 * GitHub Utils — shared helpers
 *
 * Common utilities for the GitHub utility tools:
 * - gh CLI runner
 * - repository discovery
 * - JSONL helpers
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoInfo {
	owner: string;
	repo: string;
}

export interface GhError {
	ok: false;
	error: string;
}

export interface GhSuccess<T> {
	ok: true;
	data: T;
}

export type GhResult<T> = GhSuccess<T> | GhError;

/**
 * Run a `gh` CLI command and return parsed JSON or an error.
 *
 * When `signal` is provided, aborting it kills the child `gh` process.
 */
export async function ghJson<T>(
	args: string[],
	cwd: string,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<GhResult<T>> {
	try {
		const { stdout, stderr } = await execFileAsync("gh", args, {
			cwd,
			timeout: timeoutMs,
			env: { ...process.env },
			signal,
		});
		if (stderr?.trim() && !stdout.trim()) {
			return { ok: false, error: stderr.trim() };
		}
		try {
			return { ok: true, data: JSON.parse(stdout) as T };
		} catch {
			return {
				ok: false,
				error: `Invalid JSON from gh: ${stdout.slice(0, 200)}`,
			};
		}
	} catch (err: any) {
		const message = err.stderr?.trim() ?? err.message ?? "unknown error";
		return { ok: false, error: message };
	}
}

/**
 * Run a `gh api graphql` query/mutation.
 *
 * Variables are passed as flat fields; the caller's query must declare
 * matching GraphQL variables. By default variables use `-f` (raw string).
 * Variable names listed in `typedVariables` use `-F` so gh performs JSON
 * type conversion (e.g. "214" -> 214 for Int variables).
 *
 * When `signal` is provided, aborting it kills the child `gh` process. Pass
 * it for read-only queries only — killing a mutation in flight leaves its
 * outcome unknown.
 */
export async function ghGraphQL<T>(
	query: string,
	variables: Record<string, string | number | boolean>,
	cwd: string,
	typedVariables: string[] = [],
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<GhResult<T>> {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [key, value] of Object.entries(variables)) {
		const flag = typedVariables.includes(key) ? "-F" : "-f";
		args.push(flag, `${key}=${String(value)}`);
	}
	return ghJson<T>(args, cwd, timeoutMs, signal);
}

/**
 * Discover the current repository owner/name from the working directory.
 */
export async function getRepoInfo(
	cwd: string,
	signal?: AbortSignal,
): Promise<GhResult<RepoInfo>> {
	const result = await ghJson<{ owner: { login: string }; name: string }>(
		["repo", "view", "--json", "owner,name"],
		cwd,
		undefined,
		signal,
	);
	if (!result.ok) return result;
	return {
		ok: true,
		data: { owner: result.data.owner.login, repo: result.data.name },
	};
}

/**
 * Ensure the parent directory for a file path exists.
 */
export async function ensureParentDir(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Validate that a status filter is supported.
 */
export function isValidStatus(
	status: string,
): status is "unresolved" | "resolved" | "all" {
	return ["unresolved", "resolved", "all"].includes(status);
}

function expandHomeDirectory(
	configuredDir: string,
	homeDirectory: string,
): string {
	if (configuredDir === "~") return homeDirectory;
	if (configuredDir.startsWith("~/") || configuredDir.startsWith("~\\")) {
		return join(homeDirectory, configuredDir.slice(2));
	}
	return configuredDir;
}

/**
 * Resolve the pi agent data directory.
 *
 * Uses the PI_CODING_AGENT_DIR environment variable if set, otherwise falls
 * back to ~/.pi/agent.
 */
export function resolvePiAgentDir(): string {
	const configuredDir = process.env.PI_CODING_AGENT_DIR;
	if (!configuredDir) {
		return join(homedir(), ".pi", "agent");
	}
	return expandHomeDirectory(configuredDir, homedir());
}

/**
 * Log levels for the logging utility.
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Simple leveled logger that writes timestamped messages to stderr.
 *
 * @param level   - Severity: "info", "warn", or "error"
 * @param message - The message to log
 * @param context - Optional structured context (object, Error, or string)
 *
 * @example
 * log("info", "Fetching PR data", { prNumber: 42 });
 * log("error", "Request failed", new Error("timeout"));
 */
export function log(level: LogLevel, message: string, context?: unknown): void {
	const timestamp = new Date().toISOString();
	const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
	const lines = [`${prefix} ${message}`];
	if (context !== undefined) {
		const serialized =
			typeof context === "string"
				? context
				: context instanceof Error
					? (context.stack ?? context.message)
					: JSON.stringify(context);
		lines.push(`${prefix}   └─ ${serialized}`);
	}
	if (level === "error") {
		console.error(lines.join("\n"));
	} else if (level === "warn") {
		console.warn(lines.join("\n"));
	} else {
		console.log(lines.join("\n"));
	}
}
