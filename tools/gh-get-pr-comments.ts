/**
 * gh_get_pr_comments — export pull-request review comments to JSONL
 *
 * Uses the GitHub GraphQL API to list review threads, filters by resolution
 * status, and writes one JSON object per matching thread. The JSONL file is
 * intended to be edited (notes added) and then passed to
 * gh_resolve_pr_comments.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ensureParentDir,
	ghGraphQL,
	getRepoInfo,
	isValidStatus,
	resolvePiAgentDir,
	type GhResult,
} from "../shared";

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              id
              databaseId
              author {
                login
              }
              body
              path
              line
              originalLine
              createdAt
            }
          }
        }
      }
    }
  }
}
`;

interface ReviewThreadNode {
	id: string;
	isResolved: boolean;
	comments: {
		nodes: Array<{
			id: string;
			databaseId: number;
			author: { login: string } | null;
			body: string;
			path: string;
			line: number | null;
			originalLine: number | null;
			createdAt: string;
		}>;
	};
}

interface ReviewThreadsResponse {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: ReviewThreadNode[];
				};
			};
		};
	};
}

export interface CommentEntry {
	thread_id: string;
	comment_id: number;
	comment_node_id: string;
	commenter: string;
	commenter_id: string | null;
	body: string;
	path: string;
	line: number | null;
	original_line: number | null;
	created_at: string;
	notes: string;
}

export interface GetPrCommentsDetails {
	pr_id: number;
	status: string;
	repo?: string;
	file_path?: string;
	count?: number;
	error?: string;
}

async function fetchReviewThreads(
	owner: string,
	repo: string,
	pr: number,
	cwd: string,
): Promise<GhResult<ReviewThreadsResponse>> {
	return ghGraphQL<ReviewThreadsResponse>(
		REVIEW_THREADS_QUERY,
		{ owner, repo, pr },
		cwd,
		["pr"],
	);
}

function filterThreads(
	threads: ReviewThreadNode[],
	status: "unresolved" | "resolved" | "all",
): ReviewThreadNode[] {
	if (status === "all") return threads;
	return threads.filter((t) =>
		status === "resolved" ? t.isResolved : !t.isResolved,
	);
}

function toCommentEntry(thread: ReviewThreadNode): CommentEntry | null {
	const root = thread.comments.nodes[0];
	if (!root) return null;
	return {
		thread_id: thread.id,
		comment_id: root.databaseId,
		comment_node_id: root.id,
		commenter: root.author?.login ?? "ghost",
		commenter_id: root.author ? root.author.login : null,
		body: root.body,
		path: root.path,
		line: root.line,
		original_line: root.originalLine,
		created_at: root.createdAt,
		notes: "",
	};
}

async function writeJsonl(
	filePath: string,
	entries: CommentEntry[],
): Promise<void> {
	await ensureParentDir(filePath);
	const lines = entries.map((e) => JSON.stringify(e)).join("\n");
	await writeFile(filePath, lines ? `${lines}\n` : "", "utf8");
}

export function registerGhGetPrCommentsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "gh_get_pr_comments",
		label: "GitHub PR Comments",
		description:
			"Fetch pull-request review comments from GitHub and write them to a JSONL file. " +
			"Each line represents one review thread (root comment) with an empty 'notes' field " +
			"that can be filled in and passed to gh_resolve_pr_comments.",
		promptSnippet:
			"Export PR review comments to a JSONL file for batch resolution",
		promptGuidelines: [
			"Use gh_get_pr_comments to list unresolved PR review comments",
			"The tool returns the path to a JSONL file containing one row per thread",
			"Fill in the 'notes' field for threads you want to resolve with a reply",
			"Pass the same file path to gh_resolve_pr_comments to apply resolutions",
		],
		parameters: Type.Object({
			status: Type.String({
				description: "Filter status: unresolved, resolved, or all",
			}),
			pr_id: Type.Number({
				description: "Pull request number",
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
			const status = params.status as string;
			const prId = params.pr_id as number;

			const details: GetPrCommentsDetails = {
				pr_id: prId,
				status,
			};

			if (!isValidStatus(status)) {
				details.error = `Invalid status: ${status}. Use unresolved, resolved, or all.`;
				return {
					content: [{ type: "text", text: details.error }],
					isError: true,
					details,
				};
			}

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

			const { owner, repo } = repoResult.data;
			details.repo = `${owner}/${repo}`;

			const threadsResult = await fetchReviewThreads(owner, repo, prId, cwd);
			if (!threadsResult.ok) {
				details.error = threadsResult.error;
				return {
					content: [
						{
							type: "text",
							text: `Error fetching review threads: ${threadsResult.error}`,
						},
					],
					isError: true,
					details,
				};
			}

			const threads =
				threadsResult.data.data.repository.pullRequest.reviewThreads.nodes;
			const filtered = filterThreads(threads, status);
			const entries = filtered
				.map(toCommentEntry)
				.filter((e): e is CommentEntry => e !== null);

			const timestamp = new Date()
				.toISOString()
				.replace(/[:T]/g, "-")
				.slice(0, 19);
			const slug = `pr-${prId}-${status}-${timestamp}-comments`;
			const filePath = join(
				resolvePiAgentDir(),
				"tmp",
				"gh",
				"pr-comments",
				`${slug}.json`,
			);
			await writeJsonl(filePath, entries);

			details.file_path = filePath;
			details.count = entries.length;

			return {
				content: [
					{
						type: "text",
						text: `Wrote ${entries.length} ${status} comment thread(s) to ${filePath}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("gh_get_pr_comments ")) +
					theme.fg("dim", `PR #${args.pr_id} status=${args.status}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as GetPrCommentsDetails | undefined;
			if (details?.error) {
				return new Text(
					theme.fg("error", "✗ ") + theme.fg("muted", details.error),
					0,
					0,
				);
			}
			const preview = expanded
				? `Wrote ${details?.count ?? 0} thread(s) to ${details?.file_path ?? ""}`
				: `${details?.count ?? 0} thread(s) → ${details?.file_path ?? ""}`;
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("dim", preview),
				0,
				0,
			);
		},
	});
}
