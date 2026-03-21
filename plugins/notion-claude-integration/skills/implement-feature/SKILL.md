---
name: implement-feature
description: Use when invoked via a Notion webhook channel event with Workflow="In Progress". Runs the full automated development cycle: navigate to project, branch, plan, implement with TDD, verify, commit, push, create PR, update Notion ticket to Review. Always invoke this skill when receiving a Notion channel event with page_id, project_folder, github_repo, title, and description context.
---

# Implement Feature

Fully automated development cycle triggered by a Notion ticket reaching "In Progress" status.

**This skill runs without any human interaction.** Every decision must be made autonomously. When blocked, post a Notion comment and stop — do not wait for input.

You will be given this context when the skill is invoked:
- `page_id` — Notion page UUID
- `project_folder` — subfolder name under `${CLAUDE_PROJECTS_ROOT:-$HOME/projects}`
- `github_repo` — `owner/repo` string
- `title` — ticket title
- `description` — full task requirements and acceptance criteria

---

## Before You Start: Validate Inputs

Check that `project_folder`, `github_repo`, `title`, and `description` are all present and non-empty.

If any are missing or the description is too vague to act on safely:
1. Post a Notion comment: `"Claude: Cannot start — missing required fields: {list}. Please fill in and set Workflow back to In Progress."`
2. Set `Workflow` back to `"In Progress"` via `notion-update-page`
3. Stop immediately

---

## Step 1: Navigate and Branch

Generate a branch slug from the title: lowercase, replace spaces and special characters with hyphens, strip leading/trailing hyphens, max 40 chars.
Example: "Add pagination to trade history" → `add-pagination-to-trade-history`

```bash
cd ${CLAUDE_PROJECTS_ROOT:-$HOME/projects}/{project_folder}
git checkout main
git pull
git checkout -b feat/{slug}
```

If the branch already exists, check it out and continue from where it left off rather than failing.

If `git pull` fails (merge conflict or dirty state): post a Notion comment explaining the exact error, set Workflow back to `"In Progress"`, and stop.

---

## Step 2: Understand the Codebase

Before planning or touching any code:

1. Read `CLAUDE.md` if it exists — it contains build commands, architecture notes, test instructions, and conventions specific to this project
2. Scan the top-level structure to understand the stack, patterns, and test setup
3. Identify which files are most likely to be affected by this ticket

This is what makes the plan accurate. Skipping it leads to plans that conflict with existing conventions.

---

## Step 3: Write an Implementation Plan

Use **superpowers:writing-plans** with the Notion ticket as the spec.

**Autonomous adaptations** (no user interaction available):
- Skip the brainstorming prerequisite — the Notion ticket description IS the spec
- Skip the user spec review gate — proceed to execution automatically after writing the plan
- Skip the plan document reviewer subagent — proceed directly to execution
- Save the plan to `docs/superpowers/plans/YYYY-MM-DD-{title}.md` in the project folder

The plan must include:
- File map (which files to create or modify)
- Bite-sized tasks with exact commands, test steps, and commit points
- TDD steps baked into every task (write failing test → verify red → implement → verify green → refactor)

---

## Step 4: Execute the Plan with Fresh Subagents

Use **superpowers:subagent-driven-development** to execute the plan.

**Why subagents:** Each implementation task runs in a fresh subagent with isolated context. This keeps the main Claude session clean so it can receive and route future Notion webhook events without context pollution.

**Autonomous adaptations:**
- Skip the user review between tasks — proceed automatically after each spec compliance and code quality review
- "Ask your human partner" situations → use best judgment; if genuinely blocked post a Notion comment and stop
- Each implementer subagent must use **superpowers:test-driven-development**

**Each subagent task follows TDD strictly:**
1. Write the failing test first
2. Run it — confirm it fails for the right reason
3. Write minimal code to pass
4. Run again — confirm it passes
5. Refactor if needed, keeping tests green
6. Commit

No production code without a failing test first. No exceptions in autonomous mode.

---

## Step 5: Verify Before Completion

Use **superpowers:verification-before-completion** before making any completion claims.

Run the full test suite and confirm:
- All tests pass (zero failures)
- Output is clean (no errors or warnings)
- Every requirement in the Notion ticket description is met

Do not proceed to commit/push/PR if verification fails. If tests fail after implementation:
1. Use **superpowers:systematic-debugging** to diagnose
2. Fix and re-verify once
3. If still failing: proceed to PR but flag clearly in both the PR body and the Notion comment

---

## Step 6: Commit and Push

```bash
git add -A
git commit -m "feat: {title}"
git push -u origin feat/{slug}
```

---

## Step 7: Create Pull Request

Use the GitHub MCP `create_pull_request` tool:

- **owner/repo**: from `github_repo`
- **head**: `feat/{slug}`
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

## Step 8: Update Notion

Use `notion-update-page` with `command="update_properties"`:
```
properties: {
  "Workflow": "Review",
  "GitHub PR": {PR URL}
}
```

Note: Use the `Workflow` Select property (not `Status`) — the built-in Notion Tasks `Status` does not accept custom values via API.

Then use `notion-create-comment` to post:
```
Claude: PR ready for review: {PR URL}

What was implemented: {1-2 sentence summary}
{If tests failed: "⚠️ Tests failing: {brief reason}. Please review before merging."}
```

---

## Error Handling

When anything blocks progress:
1. **Do not guess** or proceed with incomplete information
2. **Post a Notion comment** prefixed with `"Claude: "` — describe exactly what's blocking and what's needed to unblock it
3. **Set Workflow back to `"In Progress"`** via `notion-update-page` so the ticket stays visible
4. **Stop** — the user can reply to the comment and Claude will pick it up via `comment.created` webhook

Treat ambiguity as a blocker, not a license to guess.
