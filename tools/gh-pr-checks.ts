/**
 * gh_pr_checks — wait for and summarize GitHub PR check runs
 *
 * Runs `gh pr checks` for a pull request, optionally polling until all checks
 * complete. Writes a timestamped summary JSON file under the pi agent tmp
 * directory and returns a structured pass/fail summary.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ensureParentDir,
	ghJson,
	getRepoInfo,
	resolvePiAgentDir,
	type GhResult,
} from "../shared";

interface CheckRun {
	name: string;
	state: string;
	bucket: string;
	startedAt: string | null;
	completedAt: string | null;
	link: string | null;
	description: string | null;
	event: string | null;
	workflow: string | null;
}

interface CheckSummary {
	total: number;
	passed: number;
	failed: number;
	pending: number;
	skipped: number;
	all_complete: boolean;
	timed_out: boolean;
	failed_checks: CheckRun[];
	pending_checks: CheckRun[];
	checks: CheckRun[];
}

export interface PrChecksDetails {
	pr_id: number;
	repo?: string;
	watch: boolean;
	timeout_seconds: number;
	interval_seconds: number;
	required_only: boolean;
	fail_fast: boolean;
	log_file?: string;
	summary?: CheckSummary;
	timed_out?: boolean;
	error?: string;
}

const BUCKET_PASS = "pass";
const BUCKET_FAIL = "fail";
const BUCKET_PENDING = "pending";
const BUCKET_SKIPPING = "skipping";
const BUCKET_CANCEL = "cancel";

const FAILED_STATES = new Set([
	"FAILURE",
	"ACTION_REQUIRED",
	"TIMED_OUT",
	"CANCELLED",
	"STARTUP_FAILURE",
	"STALE",
]);

function isFailed(c: CheckRun): boolean {
	if (c.bucket === BUCKET_FAIL || c.bucket === BUCKET_CANCEL) return true;
	return FAILED_STATES.has(c.state);
}

function isPassed(c: CheckRun): boolean {
	return c.bucket === BUCKET_PASS || c.state === "SUCCESS";
}

function isSkipped(c: CheckRun): boolean {
	return (
		c.bucket === BUCKET_SKIPPING ||
		c.state === "SKIPPED" ||
		c.state === "NEUTRAL"
	);
}

function isPending(c: CheckRun): boolean {
	return (
		c.bucket === BUCKET_PENDING ||
		(!isPassed(c) && !isFailed(c) && !isSkipped(c))
	);
}

function summarizeChecks(checks: CheckRun[]): CheckSummary {
	const passed = checks.filter(isPassed).length;
	const failedChecks = checks.filter(isFailed);
	const skipped = checks.filter(isSkipped).length;
	const pendingChecks = checks.filter(isPending);

	return {
		total: checks.length,
		passed,
		failed: failedChecks.length,
		pending: pendingChecks.length,
		skipped,
		all_complete: pendingChecks.length === 0,
		timed_out: false,
		failed_checks: failedChecks,
		pending_checks: pendingChecks,
		checks,
	};
}

function buildGhArgs(prId: number, requiredOnly: boolean): string[] {
	const args = [
		"pr",
		"checks",
		String(prId),
		"--json",
		"name,state,bucket,startedAt,completedAt,link,description,event,workflow",
	];
	if (requiredOnly) args.push("--required");
	return args;
}

function fetchChecks(
	prId: number,
	cwd: string,
	requiredOnly: boolean,
): Promise<GhResult<CheckRun[]>> {
	return ghJson<CheckRun[]>(buildGhArgs(prId, requiredOnly), cwd);
}

function logFilePath(prId: number): string {
	const timestamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
	const slug = `pr-${prId}-checks-${timestamp}`;
	return join(resolvePiAgentDir(), "tmp", "gh", "pr-checks", `${slug}.json`);
}

async function writeLog(
	filePath: string,
	summary: CheckSummary,
): Promise<void> {
	await ensureParentDir(filePath);
	await writeFile(filePath, JSON.stringify(summary, null, 2), "utf8");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WatchOptions {
	prId: number;
	cwd: string;
	requiredOnly: boolean;
	failFast: boolean;
	timeoutSeconds: number;
	intervalSeconds: number;
	initialSummary: CheckSummary;
}

async function watchChecks(
	options: WatchOptions,
): Promise<{ summary: CheckSummary; timedOut: boolean; pollError?: string }> {
	const deadline = Date.now() + options.timeoutSeconds * 1000;
	let summary = options.initialSummary;
	let timedOut = false;

	while (!summary.all_complete) {
		if (Date.now() >= deadline) {
			timedOut = true;
			break;
		}

		if (options.failFast && summary.failed > 0) {
			break;
		}

		await sleep(options.intervalSeconds * 1000);

		const poll = await fetchChecks(
			options.prId,
			options.cwd,
			options.requiredOnly,
		);
		if (!poll.ok) {
			return { summary, timedOut, pollError: poll.error };
		}

		summary = summarizeChecks(poll.data);
	}

	return { summary, timedOut };
}

function buildSummaryText(
	prId: number,
	summary: CheckSummary,
	timeoutSeconds: number,
): string {
	const failedNames = summary.failed_checks
		.map((c) => `  - ${c.name}: ${c.state} (${c.link ?? "no url"})`)
		.join("\n");
	const pendingNames = summary.pending_checks
		.map((c) => `  - ${c.name}: ${c.state}`)
		.join("\n");

	const textLines = [
		`PR #${prId}: ${summary.passed} passed, ${summary.failed} failed, ${summary.pending} pending, ${summary.skipped} skipped (total ${summary.total})`,
		`All complete: ${summary.all_complete}`,
		...(summary.timed_out ? [`Timed out after ${timeoutSeconds}s`] : []),
		...(summary.failed > 0 && failedNames ? ["Failed:", failedNames] : []),
		...(summary.pending > 0 && pendingNames
			? ["Still pending:", pendingNames]
			: []),
	];

	return textLines.join("\n");
}

export function registerGhPrChecksTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "gh_pr_checks",
		label: "GitHub PR Checks",
		description:
			"Run `gh pr checks` for a pull request and summarize the status of all " +
			"CI checks. When watch=true, polls until every check completes or the timeout " +
			"elapses. Writes a timestamped JSON log of the final summary.",
		promptSnippet: "Wait for and summarize GitHub PR CI check statuses",
		promptGuidelines: [
			"Use gh_pr_checks after pushing a branch to see whether CI is green",
			"Set watch=true to poll until checks finish (default timeout 15 minutes)",
			"The tool returns a summary with passed, failed, pending, and skipped counts",
			"Check the `link` field for links to failing job logs",
		],
		parameters: Type.Object({
			pr_id: Type.Number({
				description: "Pull request number",
			}),
			watch: Type.Optional(
				Type.Boolean({
					description: "Poll until all checks complete",
					default: true,
				}),
			),
			required_only: Type.Optional(
				Type.Boolean({
					description: "Only include required checks",
					default: false,
				}),
			),
			fail_fast: Type.Optional(
				Type.Boolean({
					description: "Stop polling as soon as a check fails",
					default: false,
				}),
			),
			timeout_seconds: Type.Optional(
				Type.Number({
					description:
						"Maximum seconds to wait when watching (default 900 = 15 minutes)",
					default: 900,
				}),
			),
			interval_seconds: Type.Optional(
				Type.Number({
					description: "Polling interval in seconds when watching",
					default: 30,
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for gh commands; defaults to the current project directory",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd =
				(params.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
			const prId = params.pr_id as number;
			const watch = (params.watch as boolean | undefined) ?? true;
			const requiredOnly =
				(params.required_only as boolean | undefined) ?? false;
			const failFast = (params.fail_fast as boolean | undefined) ?? false;
			const timeoutSeconds =
				(params.timeout_seconds as number | undefined) ?? 900;
			const intervalSeconds =
				(params.interval_seconds as number | undefined) ?? 30;

			const details: PrChecksDetails = {
				pr_id: prId,
				watch,
				required_only: requiredOnly,
				fail_fast: failFast,
				timeout_seconds: timeoutSeconds,
				interval_seconds: intervalSeconds,
			};

			const repoResult = await getRepoInfo(cwd);
			if (!repoResult.ok) {
				details.error = repoResult.error;
				return {
					content: [
						{
							type: "text",
							text: `Error discovering repository: ${repoResult.error}`,
						},
					],
					isError: true,
					details,
				};
			}
			details.repo = `${repoResult.data.owner}/${repoResult.data.repo}`;

			const initial = await fetchChecks(prId, cwd, requiredOnly);
			if (!initial.ok) {
				details.error = initial.error;
				return {
					content: [
						{
							type: "text",
							text: `Error fetching PR checks: ${initial.error}`,
						},
					],
					isError: true,
					details,
				};
			}

			let summary = summarizeChecks(initial.data);

			if (watch && !summary.all_complete) {
				const watchResult = await watchChecks({
					prId,
					cwd,
					requiredOnly,
					failFast,
					timeoutSeconds,
					intervalSeconds,
					initialSummary: summary,
				});

				if (watchResult.pollError) {
					details.error = watchResult.pollError;
					return {
						content: [
							{
								type: "text",
								text: `Error polling PR checks: ${watchResult.pollError}`,
							},
						],
						isError: true,
						details,
					};
				}

				summary = watchResult.summary;
				details.timed_out = watchResult.timedOut;
			}

			summary.timed_out = details.timed_out ?? false;
			const logPath = logFilePath(prId);
			await writeLog(logPath, summary);
			details.log_file = logPath;
			details.summary = summary;
			details.timed_out = summary.timed_out;

			const summaryText = buildSummaryText(prId, summary, timeoutSeconds);
			const text = `${summaryText}\nLog: ${logPath}`;

			const hasError = summary.failed > 0 || summary.timed_out;
			return {
				content: [{ type: "text", text }],
				isError: hasError,
				details,
			};
		},

		renderCall(args, theme) {
			const flags: string[] = [];
			if (args.watch) flags.push("watch");
			if (args.required_only) flags.push("required");
			if (args.fail_fast) flags.push("fail-fast");
			return new Text(
				theme.fg("toolTitle", theme.bold("gh_pr_checks ")) +
					theme.fg(
						"dim",
						`PR #${args.pr_id}${flags.length > 0 ? ` ${flags.join(",")}` : ""}`,
					),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as PrChecksDetails | undefined;
			const summary = details?.summary;
			if (details?.error) {
				return new Text(
					theme.fg("error", "✗ ") + theme.fg("muted", details.error),
					0,
					0,
				);
			}
			if (!summary) {
				return new Text(
					theme.fg("warning", "? ") + theme.fg("muted", "No summary"),
					0,
					0,
				);
			}
			const icon =
				summary.failed > 0 || summary.timed_out
					? theme.fg("error", "✗ ")
					: theme.fg("success", "✓ ");
			const preview = expanded
				? `PR #${details?.pr_id}: ${summary.passed} passed, ${summary.failed} failed, ${summary.pending} pending`
				: `PR #${details?.pr_id}: ${summary.passed}/${summary.total}`;
			return new Text(icon + theme.fg("dim", preview), 0, 0);
		},
	});
}
