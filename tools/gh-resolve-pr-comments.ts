/**
 * gh_resolve_pr_comments — resolve PR review threads from a JSONL file
 *
 * Reads a JSONL file produced by gh_get_pr_comments. For every row that has a
 * non-empty `notes` field, the tool posts the notes as a reply to the thread
 * and then resolves the thread on GitHub.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ghGraphQL, getRepoInfo, type GhResult } from "../shared";
import type { CommentEntry } from "./gh-get-pr-comments";

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

interface ResolutionResult {
	thread_id: string;
	comment_id: number;
	path: string;
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
	results?: ResolutionResult[];
	error?: string;
}

async function readJsonl(filePath: string): Promise<CommentEntry[]> {
	const raw = await readFile(filePath, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim());
	return lines.map((line) => JSON.parse(line) as CommentEntry);
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

async function processEntry(
	entry: CommentEntry,
	cwd: string,
): Promise<ResolutionResult> {
	const result: ResolutionResult = {
		thread_id: entry.thread_id,
		comment_id: entry.comment_id,
		path: entry.path,
		line: entry.line,
		replied: false,
		resolved: false,
	};

	const notes = entry.notes?.trim() ?? "";
	if (notes) {
		const replyResult = await addReply(entry.thread_id, notes, cwd);
		if (!replyResult.ok) {
			result.error = `Reply failed: ${replyResult.error}`;
			return result;
		}
		result.replied = true;
	}

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
			"Resolve pull-request review threads from a JSONL file. Each row with non-empty " +
			"'notes' gets a reply posted to GitHub and the thread is marked resolved.",
		promptSnippet:
			"Resolve PR review threads using a JSONL file from gh_get_pr_comments",
		promptGuidelines: [
			"Use gh_resolve_pr_comments after editing a JSONL file produced by gh_get_pr_comments",
			"Only rows with non-empty 'notes' will be processed",
			"The tool posts the notes as a reply and then resolves the thread",
			"Rows with empty notes are skipped",
		],
		parameters: Type.Object({
			pr_id: Type.Number({
				description: "Pull request number",
			}),
			file: Type.String({
				description:
					"Path to the JSONL file containing thread IDs and resolution notes",
			}),
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
			const filePath = params.file as string;

			const details: ResolvePrCommentsDetails = {
				pr_id: prId,
				file: filePath,
				processed: 0,
				errors: 0,
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

			let entries: CommentEntry[];
			try {
				entries = await readJsonl(filePath);
			} catch (err: any) {
				details.error = `Failed to read JSONL file: ${err.message}`;
				return {
					content: [{ type: "text", text: details.error }],
					isError: true,
					details,
				};
			}

			const toProcess = entries.filter(
				(e) => (e.notes?.trim() ?? "").length > 0,
			);
			const results: ResolutionResult[] = [];
			for (const entry of toProcess) {
				const result = await processEntry(entry, cwd);
				results.push(result);
				if (result.error) {
					details.errors += 1;
				} else {
					details.processed += 1;
				}
			}
			details.results = results;

			const errorLines = results
				.filter((r) => r.error)
				.map(
					(r) => `  - ${r.path}:${r.line ?? "?"} (${r.thread_id}): ${r.error}`,
				);

			const summary = [
				`Processed ${toProcess.length} thread(s) from ${filePath}`,
				`Resolved: ${details.processed}`,
				`Errors: ${details.errors}`,
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
					: `${details?.errors ?? 0} resolution error(s)`;
				return new Text(
					theme.fg("error", "✗ ") + theme.fg("muted", text),
					0,
					0,
				);
			}
			const preview = expanded
				? `Resolved ${details?.processed ?? 0} thread(s) from ${details?.file ?? ""}`
				: `${details?.processed ?? 0} thread(s) resolved`;
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("dim", preview),
				0,
				0,
			);
		},
	});
}
