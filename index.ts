/**
 * GitHub Utils Extension
 *
 * Provides pi tools for working with GitHub pull-request review comments:
 * - gh_get_pr_comments: export review threads to a JSONL file
 * - gh_resolve_pr_comments: reply to and resolve threads from a JSONL file
 * - gh_pr_checks: wait for and summarize PR CI check statuses
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGhGetPrCommentsTool } from "./tools/gh-get-pr-comments";
import { registerGhPrChecksTool } from "./tools/gh-pr-checks";
import { registerGhResolvePrCommentsTool } from "./tools/gh-resolve-pr-comments";

export default function (pi: ExtensionAPI): void {
	registerGhGetPrCommentsTool(pi);
	registerGhResolvePrCommentsTool(pi);
	registerGhPrChecksTool(pi);
}
