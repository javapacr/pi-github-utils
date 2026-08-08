# pi-github-utils

GitHub PR review utilities for the [pi coding agent](https://github.com/earendil-works/pi) — fetch and resolve pull-request review comments, and monitor CI check statuses.

## Tools

| Tool | Description |
|------|-------------|
| `gh_get_pr_comments` | Fetch PR review comments from GitHub and write them to a JSONL file. Each line is one review thread with an empty `notes` field ready to be filled in. |
| `gh_resolve_pr_comments` | Read a JSONL file (from `gh_get_pr_comments`), post replies for rows with non-empty `notes`, and resolve those threads on GitHub. |
| `gh_pr_checks` | Run `gh pr checks` for a PR. Optionally poll (`watch=true`) until all checks complete or timeout. Returns pass/fail/pending counts and writes a JSON log. |

## Install

### As a pi extension (local path)

Add to your pi profile's `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./path/to/pi-github-utils"
    ]
  }
}
```

### As an npm package (when published)

```json
{
  "pi": {
    "extensions": [
      "npm:pi-github-utils"
    ]
  }
}
```

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated
- The repository must be a GitHub repo (uses `gh repo view` for discovery)

## Workflow

The two PR-comment tools are designed to work together:

1. **Export** — `gh_get_pr_comments` writes unresolved threads to a JSONL file
2. **Review** — Agent or user reads the JSONL, fills in `notes` for threads to resolve
3. **Resolve** — `gh_resolve_pr_comments` posts replies and resolves marked threads

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│ gh_get_pr_      │────▶│ Edit JSONL:      │────▶│ gh_resolve_pr_comments  │
│ comments        │     │ fill in "notes"  │     │ (reply + resolve)       │
└─────────────────┘     └──────────────────┘     └─────────────────────────┘
```

## License

MIT
