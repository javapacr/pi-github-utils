/**
 * gh_get_pr_comments — export pull-request review comments to JSONL
 *
 * Uses the GitHub GraphQL API to list review threads (inline, diff comments)
 * and PR-level comments (issue comments on the Conversation tab), filters
 * inline threads by resolution status, and writes one JSON object per
 * matching thread root / PR comment. The JSONL file is intended to be edited
 * (notes added) and then passed to gh_resolve_pr_comments.
 *
 * Rows are tagged with a `kind` field: "inline" (review thread root) or "pr"
 * (PR-level comment). The `status` filter applies to inline threads only —
 * PR-level comments have no resolution state and are included regardless of
 * `status` whenever the export includes "pr" rows.
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

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const CANCELLED_ERROR = "cancelled";
const CANCELLED_NOTICE =
	"Export cancelled before completion (Esc/abort) — no file written.";

export type CommentKind = "inline" | "pr";
export type CommentKindParam = CommentKind | "all";

const REVIEW_THREAD_FIELDS = `
      reviewThreads(first: ${PAGE_SIZE}, after: $threadCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          comments(first: 1) {
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
              url
            }
          }
        }
      }`;

const PR_COMMENTS_FIELDS = `
      comments(first: ${PAGE_SIZE}, after: $commentCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
          author {
            login
          }
          body
          createdAt
          url
        }
      }`;

/**
 * Assemble the query for the connections still being fetched. A connection
 * that has finished paginating is omitted entirely (segment + its cursor
 * variable) so it is never re-fetched and duplicated.
 */
function buildQuery(
	includeThreads: boolean,
	includePrComments: boolean,
): string {
	const headerVars: string[] = [
		"$owner: String!",
		"$repo: String!",
		"$pr: Int!",
	];
	const segments: string[] = [];
	if (includeThreads) {
		headerVars.push("$threadCursor: String");
		segments.push(REVIEW_THREAD_FIELDS);
	}
	if (includePrComments) {
		headerVars.push("$commentCursor: String");
		segments.push(PR_COMMENTS_FIELDS);
	}
	return `
query(${headerVars.join(", ")}) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      ${includePrComments ? "id" : ""}
      ${segments.join("\n")}
    }
  }
}
`;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

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
			url: string | null;
		}>;
	};
}

interface PrCommentNode {
	id: string;
	databaseId: number;
	author: { login: string } | null;
	body: string;
	createdAt: string;
	url: string | null;
}

interface PullRequestResponse {
	data: {
		repository: {
			pullRequest: {
				id?: string | null;
				reviewThreads?: {
					pageInfo: PageInfo;
					nodes: ReviewThreadNode[];
				};
				comments?: {
					pageInfo: PageInfo;
					nodes: PrCommentNode[];
				};
			};
		};
	};
}

export interface CommentEntry {
	/** "inline" for review-thread rows, "pr" for PR-level comment rows. Missing in older files (treated as "inline" by the resolver). */
	kind?: CommentKind;
	/** Review thread node id (inline rows only). */
	thread_id: string | null;
	/** PR node id — addComment subject for pr rows (inline rows: null). */
	subject_id: string | null;
	/** GitHub databaseId of the comment. */
	comment_id: number | null;
	/** GraphQL node id of the comment. */
	comment_node_id: string | null;
	/** Author login of the comment (null author → "ghost"). */
	commenter: string;
	/** Author login, null for ghost/unknown authors. */
	commenter_id: string | null;
	body: string;
	path: string | null;
	line: number | null;
	original_line: number | null;
	created_at: string;
	url: string | null;
	/** Filled in by the user before passing the file to gh_resolve_pr_comments. */
	notes: string;
}

export interface GetPrCommentsDetails {
	pr_id: number;
	status: string;
	kind: string;
	repo?: string;
	file_path?: string;
	count?: number;
	inline_count?: number;
	pr_count?: number;
	cancelled?: boolean;
	error?: string;
}

async function fetchComments(
	owner: string,
	repo: string,
	pr: number,
	kind: CommentKindParam,
	cwd: string,
	signal?: AbortSignal,
): Promise<
	GhResult<{
		prId: string | null;
		threads: ReviewThreadNode[];
		prComments: PrCommentNode[];
	}>
> {
	const threads: ReviewThreadNode[] = [];
	const prComments: PrCommentNode[] = [];
	let prId: string | null = null;
	let threadCursor: string | null = null;
	let commentCursor: string | null = null;
	let threadPages = 0;
	let commentPages = 0;
	let threadsDone = kind === "pr";
	let commentsDone = kind === "inline";

	for (;;) {
		if (signal?.aborted) return { ok: false, error: CANCELLED_ERROR };
		const variables: Record<string, string | number> = { owner, repo, pr };
		if (!threadsDone && threadCursor) variables.threadCursor = threadCursor;
		if (!commentsDone && commentCursor) variables.commentCursor = commentCursor;

		const result = await ghGraphQL<PullRequestResponse>(
			buildQuery(!threadsDone, !commentsDone),
			variables,
			cwd,
			["pr"],
			undefined,
			signal,
		);
		if (!result.ok) {
			return signal?.aborted ? { ok: false, error: CANCELLED_ERROR } : result;
		}

		const pullRequest = result.data.data.repository.pullRequest;
		if (prId === null && pullRequest.id) prId = pullRequest.id;

		if (pullRequest.reviewThreads) {
			threadPages += 1;
			threads.push(...pullRequest.reviewThreads.nodes);
			if (pullRequest.reviewThreads.pageInfo.hasNextPage) {
				if (threadPages >= MAX_PAGES) {
					return {
						ok: false,
						error: `Review threads exceed the pagination safety cap of ${MAX_PAGES} pages (${PAGE_SIZE} per page) — refusing to silently truncate.`,
					};
				}
				threadCursor = pullRequest.reviewThreads.pageInfo.endCursor;
			} else {
				threadCursor = null;
				threadsDone = true;
			}
		}

		if (pullRequest.comments) {
			commentPages += 1;
			prComments.push(...pullRequest.comments.nodes);
			if (pullRequest.comments.pageInfo.hasNextPage) {
				if (commentPages >= MAX_PAGES) {
					return {
						ok: false,
						error: `PR-level comments exceed the pagination safety cap of ${MAX_PAGES} pages (${PAGE_SIZE} per page) — refusing to silently truncate.`,
					};
				}
				commentCursor = pullRequest.comments.pageInfo.endCursor;
			} else {
				commentCursor = null;
				commentsDone = true;
			}
		}

		if (threadsDone && commentsDone) break;
	}

	if (prId === null && prComments.length > 0) {
		return {
			ok: false,
			error:
				"PR node id missing from response despite PR-level comments requested.",
		};
	}

	return { ok: true, data: { prId, threads, prComments } };
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

function toInlineEntry(thread: ReviewThreadNode): CommentEntry | null {
	const root = thread.comments.nodes[0];
	if (!root) return null;
	return {
		kind: "inline",
		thread_id: thread.id,
		subject_id: null,
		comment_id: root.databaseId,
		comment_node_id: root.id,
		commenter: root.author?.login ?? "ghost",
		commenter_id: root.author?.login ?? null,
		body: root.body,
		path: root.path,
		line: root.line,
		original_line: root.originalLine,
		created_at: root.createdAt,
		url: root.url ?? null,
		notes: "",
	};
}

function toPrEntry(
	comment: PrCommentNode,
	subjectId: string | null,
): CommentEntry {
	return {
		kind: "pr",
		thread_id: null,
		subject_id: subjectId,
		comment_id: comment.databaseId,
		comment_node_id: comment.id,
		commenter: comment.author?.login ?? "ghost",
		commenter_id: comment.author?.login ?? null,
		body: comment.body,
		path: null,
		line: null,
		original_line: null,
		created_at: comment.createdAt,
		url: comment.url ?? null,
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

function isValidKind(kind: string): kind is CommentKindParam {
	return ["inline", "pr", "all"].includes(kind);
}

export function registerGhGetPrCommentsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "gh_get_pr_comments",
		label: "GitHub PR Comments",
		description:
			"Fetch pull-request review comments from GitHub and write them to a JSONL file. " +
			"Each line is one entry with an empty 'notes' field: review threads (kind \"inline\", " +
			'diff comments) and PR-level comments (kind "pr", Conversation tab). The status filter ' +
			"(unresolved/resolved/all) applies to inline threads only; PR-level comments have no " +
			'resolution state and are included regardless of status whenever kind is "pr" or "all". ' +
			"Fill in 'notes' and pass the file to gh_resolve_pr_comments (inline rows are replied to " +
			"and resolved; pr rows are replied to as a new PR-level comment and never resolved).",
		promptSnippet:
			"Export PR review comments (inline + PR-level) to a JSONL file for batch resolution",
		promptGuidelines: [
			'Use gh_get_pr_comments to list PR comments; use kind to scope to inline threads, PR-level comments, or both (default "all")',
			'The status filter (unresolved/resolved/all) applies to inline threads only; PR-level comments are always included when kind includes "pr"',
			'Each row is tagged with kind ("inline" | "pr") and carries an empty \'notes\' field',
			"Fill in the 'notes' field for entries you want to reply to, then pass the same file to gh_resolve_pr_comments",
		],
		parameters: Type.Object({
			status: Type.String({
				description:
					"Filter status for inline threads: unresolved, resolved, or all",
			}),
			kind: Type.Optional(
				Type.String({
					description:
						'Scope of comments to export: "inline" (review threads), "pr" (PR-level comments), or "all" (default)',
				}),
			),
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

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = (params.cwd as string | undefined) ?? ctx?.cwd ?? process.cwd();
			const status = params.status as string;
			const prId = params.pr_id as number;
			const kind = (params.kind as string | undefined) ?? "all";

			const details: GetPrCommentsDetails = {
				pr_id: prId,
				status,
				kind: kind as CommentKindParam,
			};

			if (!isValidStatus(status)) {
				details.error = `Invalid status: ${status}. Use unresolved, resolved, or all.`;
				return {
					content: [{ type: "text", text: details.error }],
					isError: true,
					details,
				};
			}

			if (!isValidKind(kind)) {
				details.error = `Invalid kind: ${kind}. Use inline, pr, or all.`;
				return {
					content: [{ type: "text", text: details.error }],
					isError: true,
					details,
				};
			}

			const cancelledResult = () => {
				details.cancelled = true;
				return {
					content: [{ type: "text" as const, text: CANCELLED_NOTICE }],
					details,
				};
			};
			if (signal?.aborted) return cancelledResult();

			const repoResult = await getRepoInfo(cwd, signal);
			if (!repoResult.ok) {
				if (signal?.aborted) return cancelledResult();
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

			const fetchResult = await fetchComments(
				owner,
				repo,
				prId,
				kind,
				cwd,
				signal,
			);
			if (!fetchResult.ok) {
				if (signal?.aborted) return cancelledResult();
				details.error = fetchResult.error;
				return {
					content: [
						{
							type: "text",
							text: `Error fetching comments: ${fetchResult.error}`,
						},
					],
					isError: true,
					details,
				};
			}

			const entries: CommentEntry[] = [];
			if (kind !== "pr") {
				const filtered = filterThreads(fetchResult.data.threads, status);
				entries.push(
					...filtered
						.map(toInlineEntry)
						.filter((e): e is CommentEntry => e !== null),
				);
			}
			if (kind !== "inline") {
				entries.push(
					...fetchResult.data.prComments.map((c) =>
						toPrEntry(c, fetchResult.data.prId),
					),
				);
			}

			const timestamp = new Date()
				.toISOString()
				.replace(/[:T]/g, "-")
				.slice(0, 19);
			const slug = `pr-${prId}-${status}-${kind}-${timestamp}-comments`;
			const filePath = join(
				resolvePiAgentDir(),
				"tmp",
				"gh",
				"pr-comments",
				`${slug}.jsonl`,
			);
			await writeJsonl(filePath, entries);

			details.file_path = filePath;
			details.count = entries.length;
			details.inline_count = entries.filter((e) => e.kind === "inline").length;
			details.pr_count = entries.filter((e) => e.kind === "pr").length;

			return {
				content: [
					{
						type: "text",
						text: `Wrote ${entries.length} comment entry/entries (${details.inline_count} inline, ${details.pr_count} PR-level) to ${filePath}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("gh_get_pr_comments ")) +
					theme.fg(
						"dim",
						`PR #${args.pr_id} status=${args.status} kind=${args.kind ?? "all"}`,
					),
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
			if (details?.cancelled) {
				return new Text(
					theme.fg("warning", "⊘ ") +
						theme.fg("muted", `PR #${details.pr_id} export cancelled`),
					0,
					0,
				);
			}
			const preview = expanded
				? `Wrote ${details?.count ?? 0} entry/entries (${details?.inline_count ?? 0} inline, ${details?.pr_count ?? 0} PR-level) to ${details?.file_path ?? ""}`
				: `${details?.count ?? 0} entries → ${details?.file_path ?? ""}`;
			return new Text(theme.fg("success", "✓ ") + theme.fg("dim", preview), 0, 0);
		},
	});
}
