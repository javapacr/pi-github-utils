/**
 * gh_resolve_pr_comments — reply to / resolve PR comments from a JSONL file
 *
 * Reads a JSONL file produced by gh_get_pr_comments. For every row that has a
 * non-empty `notes` field, the tool processes it by its `kind`:
 *   - "inline" (or rows without a `kind` field, i.e. older files): posts the
 *     notes as a reply to the review thread and then resolves the thread.
 *   - "pr": PR-level comments have no resolvable thread — the notes are
 *     posted as a new PR-level comment (via addComment on the PR node id),
 *     prefixed with a reply marker quoting the original commenter. No resolve
 *     mutation is attempted; these rows are reported as `replied`.
 *
 * Errors on one row never abort the batch (per-row error isolation).
 * Esc/abort is honoured between rows only: a row already in flight finishes
 * (reply + resolve) so no thread is left replied-but-unresolved by the abort,
 * and mutations are never killed mid-request (their outcome would be unknown).
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ghGraphQL, getRepoInfo, type GhResult } from "../shared";
import type { CommentEntry, CommentKind } from "./gh-get-pr-comments";

const ADD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment {
      id
      databaseId
    }
  }
}
`;

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
    }
  }
}
`;

const ADD_PR_COMMENT_MUTATION = `
mutation($subjectId: ID!, $body: String!) {
  addComment(input: {subjectId: $subjectId, body: $body}) {
    subject {
      id
    }
  }
}
`;

interface AddReplyResponse {
	data: {
		addPullRequestReviewThreadReply: {
			comment: {
				id: string;
				databaseId: number;
			};
		};
	};
}

interface ResolveThreadResponse {
	data: {
		resolveReviewThread: {
			thread: {
				id: string;
				isResolved: boolean;
			};
		};
	};
}

interface AddPrCommentResponse {
	data: {
		addComment: {
			subject: {
				id: string;
			};
		};
	};
}

interface ResolutionResult {
	kind: CommentKind;
	thread_id: string | null;
	comment_id: number | null;
	path: string | null;
	line: number | null;
	replied: boolean;
	resolved: boolean;
	error?: string;
}

export interface ResolvePrCommentsDetails {
	pr_id: number;
	file?: string;
	repo?: string;
	processed: number;
	errors: number;
	resolved_count: number;
	replied_count: number;
	skipped_malformed?: string[];
	results?: ResolutionResult[];
	/** True when Esc/abort stopped the batch before every row was processed. */
	cancelled?: boolean;
	error?: string;
}

interface JsonlReadResult {
	entries: CommentEntry[];
	/** Human-readable reasons for lines that were skipped (parse or type errors). */
	malformed: string[];
}

async function readJsonl(filePath: string): Promise<JsonlReadResult> {
	const raw = await readFile(filePath, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim());
	const entries: CommentEntry[] = [];
	const malformed: string[] = [];
	lines.forEach((line, index) => {
		const lineNo = index + 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			malformed.push(`line ${lineNo}: not valid JSON`);
			return;
		}
		if (typeof parsed !== "object" || parsed === null) {
			malformed.push(`line ${lineNo}: not a JSON object`);
			return;
		}
		const row = parsed as Record<string, unknown>;
		if (row.notes !== undefined && typeof row.notes !== "string") {
			malformed.push(`line ${lineNo}: 'notes' must be a string`);
			return;
		}
		if (row.kind !== undefined && row.kind !== "inline" && row.kind !== "pr") {
			malformed.push(`line ${lineNo}: 'kind' must be "inline" or "pr"`);
			return;
		}
		for (const field of ["thread_id", "subject_id"] as const) {
			const value = row[field];
			if (value !== undefined && value !== null && typeof value !== "string") {
				malformed.push(`line ${lineNo}: '${field}' must be a string or null`);
				return;
			}
		}
		entries.push(row as unknown as CommentEntry);
	});
	return { entries, malformed };
}

async function addReply(
	threadId: string,
	body: string,
	cwd: string,
): Promise<GhResult<AddReplyResponse>> {
	return ghGraphQL<AddReplyResponse>(
		ADD_REPLY_MUTATION,
		{ threadId, body },
		cwd,
	);
}

async function resolveThread(
	threadId: string,
	cwd: string,
): Promise<GhResult<ResolveThreadResponse>> {
	return ghGraphQL<ResolveThreadResponse>(
		RESOLVE_THREAD_MUTATION,
		{ threadId },
		cwd,
	);
}

async function addPrComment(
	subjectId: string,
	body: string,
	cwd: string,
): Promise<GhResult<AddPrCommentResponse>> {
	return ghGraphQL<AddPrCommentResponse>(
		ADD_PR_COMMENT_MUTATION,
		{ subjectId, body },
		cwd,
	);
}

/** Build the traceable reply body for a PR-level comment row. */
function buildPrReplyBody(entry: CommentEntry, notes: string): string {
	return `> replying to @${entry.commenter}'s comment (${entry.url ?? "see comment"})\n\n${notes}`;
}

async function processEntry(
	entry: CommentEntry,
	cwd: string,
): Promise<ResolutionResult> {
	const kind: CommentKind = entry.kind ?? "inline";
	const result: ResolutionResult = {
		kind,
		thread_id: entry.thread_id,
		comment_id: entry.comment_id,
		path: entry.path,
		line: entry.line,
		replied: false,
		resolved: false,
	};

	const notes = entry.notes?.trim() ?? "";
	if (!notes) return result;

	if (kind === "pr") {
		if (!entry.subject_id) {
			result.error =
				"PR row is missing subject_id (PR node id); cannot post reply";
			return result;
		}
		const body = buildPrReplyBody(entry, notes);
		const replyResult = await addPrComment(entry.subject_id, body, cwd);
		if (!replyResult.ok) {
			result.error = `Reply failed: ${replyResult.error}`;
			return result;
		}
		result.replied = true;
		return result;
	}

	if (!entry.thread_id) {
		result.error = "Inline row is missing thread_id; cannot reply/resolve";
		return result;
	}

	const replyResult = await addReply(entry.thread_id, notes, cwd);
	if (!replyResult.ok) {
		result.error = `Reply failed: ${replyResult.error}`;
		return result;
	}
	result.replied = true;

	const resolveResult = await resolveThread(entry.thread_id, cwd);
	if (!resolveResult.ok) {
		result.error = `Resolve failed: ${resolveResult.error}`;
		return result;
	}
	result.resolved = true;

	return result;
}

export function registerGhResolvePrCommentsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "gh_resolve_pr_comments",
		label: "Resolve GitHub PR Comments",
		description:
			"Process pull-request comments from a JSONL file (produced by gh_get_pr_comments). " +
			"Each row with non-empty 'notes' is handled by its 'kind': inline rows get the notes " +
			"posted as a reply to the review thread and the thread is marked resolved; pr rows " +
			"have the notes posted as a new PR-level comment prefixed with a reply marker " +
			"(never resolved — PR-level comments have no thread). Rows without a 'kind' field " +
			"(older files) are treated as inline.",
		promptSnippet:
			"Resolve PR review threads and reply to PR-level comments using a JSONL file from gh_get_pr_comments",
		promptGuidelines: [
			"Use gh_resolve_pr_comments after editing a JSONL file produced by gh_get_pr_comments",
			"Only rows with non-empty 'notes' will be processed; rows with empty notes are skipped",
			'kind="inline" rows: notes are posted as a reply and the thread is resolved',
			'kind="pr" rows: notes are posted as a new PR-level comment with a reply marker; no resolution applies',
			"Errors on one row do not abort the batch — other rows are still processed",
		],
		parameters: Type.Object({
			pr_id: Type.Number({
				description: "Pull request number",
			}),
			file: Type.String({
				description:
					"Path to the JSONL file containing comment entries and resolution notes",
			}),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for gh commands; defaults to the current project directory",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (params.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
			const prId = params.pr_id as number;
			const filePath = params.file as string;

			const details: ResolvePrCommentsDetails = {
				pr_id: prId,
				file: filePath,
				processed: 0,
				errors: 0,
				resolved_count: 0,
				replied_count: 0,
			};

			const repoResult = await getRepoInfo(cwd, signal);
			if (!repoResult.ok) {
				if (signal?.aborted) {
					details.cancelled = true;
					return {
						content: [
							{ type: "text", text: "Cancelled before any row was processed." },
						],
						details,
					};
				}
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

			let jsonl: JsonlReadResult;
			try {
				jsonl = await readJsonl(filePath);
			} catch (err: any) {
				details.error = `Failed to read JSONL file: ${err.message}`;
				return {
					content: [{ type: "text", text: details.error }],
					isError: true,
					details,
				};
			}
			const entries = jsonl.entries;
			if (jsonl.malformed.length > 0) {
				details.skipped_malformed = jsonl.malformed;
			}

			const toProcess = entries.filter((e) => (e.notes?.trim() ?? "").length > 0);
			const results: ResolutionResult[] = [];
			let aborted = false;
			for (let i = 0; i < toProcess.length; i++) {
				if (signal?.aborted) {
					aborted = true;
					break;
				}
				const result = await processEntry(toProcess[i], cwd);
				results.push(result);
				if (result.error) {
					details.errors += 1;
				} else {
					details.processed += 1;
					if (result.resolved) details.resolved_count += 1;
					if (result.replied && result.kind === "pr") details.replied_count += 1;
				}
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Processed ${i + 1}/${toProcess.length} rows`,
						},
					],
					details,
				});
			}
			details.results = results;
			if (aborted) details.cancelled = true;

			const errorLines = results
				.filter((r) => r.error)
				.map((r) => {
					const loc =
						r.kind === "pr"
							? `PR comment #${r.comment_id ?? "?"}`
							: `${r.path}:${r.line ?? "?"}`;
					const suffix = r.kind === "pr" ? "" : ` (${r.thread_id})`;
					return `  - [${r.kind}] ${loc}${suffix}: ${r.error}`;
				});

			const summary = [
				`Processed ${toProcess.length} entry/entries from ${filePath}`,
				`Resolved threads: ${details.resolved_count}`,
				`Replied PR comments: ${details.replied_count}`,
				`Errors: ${details.errors}`,
				...(details.skipped_malformed
					? [`Skipped ${details.skipped_malformed.length} malformed line(s)`]
					: []),
				...(aborted
					? [
							`Cancelled after ${results.length} of ${toProcess.length} row(s) — remaining rows unprocessed; before re-running with the same file, clear the notes of the rows already done (see results) or their replies are posted twice`,
						]
					: []),
				...(errorLines.length > 0 ? ["", "Errors:", ...errorLines] : []),
			];

			return {
				content: [{ type: "text", text: summary.join("\n") }],
				isError: details.errors > 0,
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("gh_resolve_pr_comments ")) +
					theme.fg("dim", `PR #${args.pr_id}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ResolvePrCommentsDetails | undefined;
			if (details?.error || (details?.errors ?? 0) > 0) {
				const text = details?.error
					? details.error
					: `${details?.errors ?? 0} processing error(s)`;
				return new Text(theme.fg("error", "✗ ") + theme.fg("muted", text), 0, 0);
			}
			if (details?.cancelled) {
				return new Text(
					theme.fg("warning", "⊘ ") +
						theme.fg(
							"muted",
							`cancelled — ${details.resolved_count} resolved + ${details.replied_count} replied before abort`,
						),
					0,
					0,
				);
			}
			const preview = expanded
				? `Resolved ${details?.resolved_count ?? 0} thread(s), replied ${details?.replied_count ?? 0} PR comment(s) from ${details?.file ?? ""}`
				: `${details?.resolved_count ?? 0} resolved + ${details?.replied_count ?? 0} replied`;
			return new Text(theme.fg("success", "✓ ") + theme.fg("dim", preview), 0, 0);
		},
	});
}
