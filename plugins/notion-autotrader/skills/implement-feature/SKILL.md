---
name: implement-feature
description: Use when invoked via a Notion webhook channel event with Workflow="In Progress". Runs the full automated development cycle: navigate to project, branch, implement, test, commit, push, create PR, update Notion ticket to Review. Always invoke this skill when receiving a Notion channel event with page_id, project_folder, github_repo, title, and description context.
---

# Implement Feature

Fully automated development cycle triggered by a Notion ticket reaching "In Progress" status.

You will be given this context when the skill is invoked:
- `page_id` — Notion page UUID
- `project_folder` — subfolder name under the projects root
- `github_repo` — `owner/repo` string
- `title` — ticket title (used as branch name and commit message)
- `description` — full task requirements and acceptance criteria

The projects root is `${CLAUDE_PROJECTS_ROOT:-$HOME/projects}`. Users set the `CLAUDE_PROJECTS_ROOT` environment variable to point at the folder that contains all their projects.

---

## Step 1: Navigate and Branch

```bash
cd ${CLAUDE_PROJECTS_ROOT:-$HOME/projects}/{project_folder}
git checkout main
git pull
git checkout -b feat/notion-{first 8 chars of page_id}
```

If `git pull` fails (e.g. merge conflict), stop and add a Notion comment explaining the blocker. Do not proceed.

---

## Step 2: Understand the Codebase

Before touching any code:

1. Read `CLAUDE.md` if it exists — it contains build commands, architecture notes, and test instructions specific to this project
2. Scan the top-level structure to understand the stack and patterns
3. Identify files most likely to be affected by the ticket

This context prevents you from implementing something that conflicts with the project's conventions.

---

## Step 3: Implement

Implement the feature described in `description`. Follow the project's existing patterns and conventions as observed in Step 2.

Keep changes focused — do not refactor unrelated code or add features beyond what the ticket asks for.

---

## Step 4: Run Tests

Check `CLAUDE.md` for the test command. If not found, detect from the project:

| Signal | Test command |
|--------|-------------|
| `pytest.ini` / `pyproject.toml` with `[tool.pytest]` | `python -m pytest` |
| `package.json` with `"test"` script | `npm test` |
| `Cargo.toml` | `cargo test` |
| `Makefile` with `test` target | `make test` |
| `requirements.txt` / `.py` files only | `python -m pytest` (try) |

Run the tests. If they fail:
1. Read the failure output and fix the issue
2. Re-run once
3. If still failing after one fix attempt: proceed to Step 5 but **flag the failure** in both the PR body and the Notion comment

---

## Step 5: Commit and Push

```bash
git add -A
git commit -m "feat: {title}"
git push -u origin feat/notion-{first 8 chars of page_id}
```

---

## Step 6: Create Pull Request

Use the GitHub MCP `create_pull_request` tool:

- **owner/repo**: from `github_repo`
- **head**: `feat/notion-{first 8 chars of page_id}`
- **base**: `main`
- **title**: `{title}`
- **body**:
  ```
  Notion ticket: https://notion.so/{page_id}

  ## What was done
  {brief summary of what was implemented}

  ## Tests
  {passed / failed with details if failed}
  ```

Save the PR URL from the response.

---

## Step 7: Update Notion

Use `notion-update-page` with `command="update_properties"`:
```
properties: {
  "Workflow": "Review",
  "GitHub PR": {PR URL}
}
```

Note: Use the `Workflow` Select property (not `Status`) — the built-in Notion Tasks `Status` property does not accept custom values via API.

Then use `notion-create-comment` to add a page comment:
```
Claude: PR ready for review: {PR URL}

What was implemented: {1-2 sentence summary}
{If tests failed: "⚠️ Tests failing: {brief reason}. Please review before merging."}
```

---

## Error Handling

If anything blocks progress (git conflict, missing credentials, ambiguous requirements):
1. Do not guess or proceed with incomplete information
2. Add a Notion comment (prefixed with "Claude: ") describing exactly what's blocking and what information is needed
3. Stop — the user can reply to the comment with clarification and Claude will pick it up via the comment.created webhook
