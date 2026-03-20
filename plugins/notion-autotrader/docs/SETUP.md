# Notion → Claude Code: Automated Development Pipeline

Connect Notion to Claude Code so that moving a ticket to "In Progress" automatically triggers Claude to implement it — create a branch, write the code, run tests, open a PR, and update the ticket. Comments on the Notion page go directly to Claude for feedback and revisions.

---

## How It Works

```
You move a Notion ticket to "In Progress"
        │
        ▼
Notion fires a webhook (page.properties_updated)
        │
        ▼
Cloudflare Tunnel (public HTTPS → localhost:8788)
        │
        ▼
webhook.ts — MCP channel server
  • Verifies the HMAC signature
  • Drops integration-authored events (prevents feedback loops)
  • Calls Notion API to confirm Workflow = "In Progress" and no open PR
  • Forwards the event to Claude via notifications/claude/channel
        │
        ▼
Claude Code session receives the event
  • Reads the ticket via Notion MCP (title, description, project folder, repo)
  • Creates a feature branch
  • Implements the task
  • Runs tests
  • Opens a GitHub PR
  • Sets Workflow → "Review" and posts the PR link as a Notion comment
        │
        ▼
You review the PR, leave feedback as Notion comments
        │
        ▼
comment.created webhook fires → Claude reads and acts on feedback
```

---

## Prerequisites

- **Claude Code** v2.1.80 or later — `claude --version`
- **Logged in with a claude.ai account** (not an API key — channels require claude.ai login)
- **Bun** runtime — [bun.sh](https://bun.sh)
- **Cloudflare Tunnel** (`cloudflared`) — [developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- **Notion paid plan** (webhooks are not available on the free tier)
- **GitHub account** with a repository for the project

---

## Part 1 — Notion Setup

### 1.1 Create a Notion Integration

You need an internal integration so your webhook server can call the Notion API to read page properties before deciding whether to forward events to Claude.

1. Go to [notion.so/profile/integrations](https://notion.so/profile/integrations)
2. Click **New integration**
3. Give it a clear name like **"Claude Autotrader"** and choose your workspace
4. Under **Capabilities**, enable:
   - Read content
   - Update content
   - Insert content
   - Read comments
   - Create comments
5. Click **Save**
6. Copy the **Internal Integration Secret** — this is your `NOTION_FILTER_TOKEN`

> The integration also controls how Claude's replies appear in Notion. Comments it creates will show under this integration's name, so give it a distinctive name and avatar.

### 1.2 Set Up the Notion MCP in Claude Code

Claude uses the Notion MCP to read and write page content. This is separate from the integration above.

```bash
claude mcp add --transport http notion https://mcp.notion.com/mcp
```

Follow the prompts to connect it to your Notion workspace. This gives Claude tools to fetch pages, update properties, and create comments.

### 1.3 Create the Tasks Database

Create or open a Notion database for your tasks. Add these properties:

| Property name | Type | Purpose |
|---------------|------|---------|
| `Task name` | Title | Built-in — the ticket title |
| `Summary` | Text | Task description and requirements for Claude |
| `Workflow` | Select | Automation state — options: `Not Started`, `In Progress`, `Review`, `Done` |
| `Project Folder` | Text | Subfolder name under your projects root (e.g. `my-app`) |
| `GitHub Repo` | Text | `owner/repo` format (e.g. `alice/my-app`) |
| `GitHub PR` | URL | Left blank — Claude fills this in after opening the PR |

> **Why a `Workflow` Select property instead of the built-in `Status`?**
> Notion's built-in Tasks database `Status` property only accepts "Not Started", "Done", and "Archived" via the API — custom options like "Review" can't be written back programmatically. A custom Select property has no such limitation.

### 1.4 Connect the Integration to Your Database

1. Open the database in Notion
2. Click `...` in the top-right → **Connections**
3. Find your integration ("Claude Autotrader") and click **Connect**

> This step is required. Without it, the integration can't read or write any pages in the database — and comment webhooks won't be delivered either.

### 1.5 Configure the Webhook

1. Go to [notion.so/profile/integrations](https://notion.so/profile/integrations) → open your integration
2. Click the **Webhooks** tab → **Add new endpoint**
3. Set the URL to your Cloudflare Tunnel URL (set this up in Part 3 first, then come back)
4. Under **Event types**, check:
   - `page.properties_updated`
   - `comment.created`
5. Save — Notion will send a verification request to your server to confirm the endpoint is live

Copy the **Webhook Signing Secret** — this is your `NOTION_WEBHOOK_SECRET`.

---

## Part 2 — Webhook Channel Server

### 2.1 Create the Project

```bash
mkdir ~/notion-channel && cd ~/notion-channel
bun add @modelcontextprotocol/sdk
```

### 2.2 Create `webhook.ts`

This server has two jobs: listen for Notion webhook POSTs over HTTP, and act as an MCP channel server so Claude Code receives the events.

```typescript
#!/usr/bin/env bun
import { createHmac, timingSafeEqual } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const NOTION_TOKEN = process.env.NOTION_FILTER_TOKEN
const NOTION_VERSION = '2022-06-28'

async function fetchPageProperties(pageId: string): Promise<Record<string, any> | null> {
  if (!NOTION_TOKEN) return null
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
    },
  })
  if (!res.ok) {
    console.error(`[notion-webhook] Failed to fetch page ${pageId}: ${res.status}`)
    return null
  }
  const data = await res.json() as any
  return data.properties ?? null
}

function getPropertyValue(props: Record<string, any>, name: string): string | null {
  const prop = props[name]
  if (!prop) return null
  if (prop.type === 'status') return prop.status?.name ?? null
  if (prop.type === 'select') return prop.select?.name ?? null
  if (prop.type === 'url') return prop.url ?? null
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text ?? null
  if (prop.type === 'title') return prop.title?.[0]?.plain_text ?? null
  return null
}

const mcp = new Server(
  { name: 'notion-webhook', version: '1.0.0' },
  {
    capabilities: {
      // Registers this server as a Claude Code channel
      experimental: { 'claude/channel': {} },
    },
    instructions: `
When a Notion event arrives as <channel source="notion-webhook" ...>, route it as follows:

1. Parse the JSON body
2. Dispatch by event type:

--- page.properties_updated ---
Page ID is at body.entity.id.
The server has already pre-filtered this event: Workflow is either "In Progress" (no GitHub PR) or "Done".
Fetch the page via Notion MCP to get current properties, then route by Workflow:
- "In Progress" + no GitHub PR: invoke the implement-feature skill passing:
  - page_id: entity.id
  - project_folder: from "Project Folder" rich_text property
  - github_repo: from "GitHub Repo" rich_text property
  - title: from "Task name" title property
  - description: from "Summary" rich_text property
- "Done": merge and deploy flow
- Anything else: ignore silently (should not happen after pre-filtering)

--- comment.created ---
Page ID is at body.data.page_id. Comment ID is at body.entity.id.
This is a direct message from the user — treat it like a chat message and respond.

Steps:
1. Fetch the comment text via notion-get-comments(page_id)
   Find the comment matching body.entity.id — that is the user's message
2. Fetch the page properties to get context (project_folder, github_repo, GitHub PR, Workflow)
3. Read the comment and interpret the user's intent:
   - Instructions to change code → checkout the feature branch, make the change, push, reply confirming what was done
   - Questions about the code or PR → answer directly in a reply comment
   - Requests for status updates → summarise current state and reply
   - Any other instruction → execute it and reply with what was done
4. Always reply via notion-create-comment(page_id) so the user sees your response on the ticket
   Start your reply with your name so it's clear who responded, e.g. "Claude: ..."
5. If the instruction is ambiguous, ask a clarifying question in the reply instead of guessing

--- anything else ---
Ignore silently.
    `.trim(),
  },
)

// Connect to Claude Code over stdio — Claude Code spawns this process
await mcp.connect(new StdioServerTransport())

// HTTP listener for Notion webhook POSTs
Bun.serve({
  port: 8788,
  hostname: '127.0.0.1', // localhost only — the tunnel handles the public side
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    let body: string
    try {
      body = await req.text()
    } catch (err) {
      console.error('[notion-webhook] Failed to read request body:', err)
      return new Response('Bad Request', { status: 400 })
    }

    // Notion HMAC-SHA256 signature verification
    const verificationToken = process.env.NOTION_WEBHOOK_SECRET
    if (verificationToken) {
      const signature = req.headers.get('x-notion-signature')
      if (!signature) {
        console.error('[notion-webhook] Rejected: missing x-notion-signature header')
        return new Response('Unauthorized', { status: 401 })
      }
      const expected = `sha256=${createHmac('sha256', verificationToken).update(body).digest('hex')}`
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
        console.error('[notion-webhook] Rejected: invalid signature')
        return new Response('Unauthorized', { status: 401 })
      }
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body)
    } catch {
      console.error('[notion-webhook] Rejected non-JSON body')
      return new Response('Bad Request', { status: 400 })
    }

    // Notion endpoint verification handshake
    if (typeof parsed.verification_token === 'string') {
      console.error('[notion-webhook] Responding to Notion verification challenge')
      return new Response(JSON.stringify({ verification_token: parsed.verification_token }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const type = parsed.type as string | undefined

    if (type === 'page.properties_updated') {
      const pageId = (parsed as any)?.entity?.id as string | undefined
      // Drop events authored by an integration (Claude's own writes) to prevent feedback loops
      const authors = (parsed as any)?.authors as Array<{ type: string }> | undefined
      if (authors && authors.length > 0 && authors.every(a => a.type !== 'person')) {
        console.error(`[notion-webhook] Ignored: authored by integration, not a person`)
        return new Response('Ignored', { status: 200 })
      }
      if (pageId && NOTION_TOKEN) {
        const props = await fetchPageProperties(pageId)
        if (props) {
          const workflow = getPropertyValue(props, 'Workflow')
          const githubPR = getPropertyValue(props, 'GitHub PR')
          console.error(`[notion-webhook] Page ${pageId} — Workflow: ${workflow}, GitHub PR: ${githubPR}`)
          if (workflow === 'In Progress' && !githubPR) {
            // forward — implement-feature
          } else if (workflow === 'Done') {
            // forward — merge-deploy
          } else {
            console.error(`[notion-webhook] Ignored: Workflow="${workflow}" GitHub PR="${githubPR}"`)
            return new Response('Ignored', { status: 200 })
          }
        }
      }
    } else if (type === 'comment.created') {
      // Drop comments authored by an integration (Claude's own replies)
      const authors = (parsed as any)?.authors as Array<{ type: string }> | undefined
      if (authors && authors.length > 0 && authors.every(a => a.type !== 'person')) {
        console.error(`[notion-webhook] Ignored: comment authored by integration`)
        return new Response('Ignored', { status: 200 })
      }
    } else {
      console.error(`[notion-webhook] Ignored (unhandled type "${type}")`)
      return new Response('Ignored', { status: 200 })
    }

    console.error(`[notion-webhook] Forwarding to Claude: type=${type} page=${(parsed as any)?.entity?.id}`)

    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: body,
          meta: {
            source: 'notion',
            path: new URL(req.url).pathname,
          },
        },
      })
    } catch (err) {
      console.error('[notion-webhook] Failed to forward notification to MCP:', err)
      return new Response('Internal Server Error', { status: 500 })
    }

    return new Response('Webhook received', { status: 200 })
  },
})

console.error('[notion-webhook] Channel server started on http://127.0.0.1:8788')
```

### 2.3 Register in `.mcp.json`

In your projects root directory (the parent of all your project folders), create `.mcp.json`:

```json
{
  "mcpServers": {
    "notion-webhook": {
      "command": "bun",
      "args": ["/absolute/path/to/notion-channel/webhook.ts"]
    }
  }
}
```

Use the absolute path to `webhook.ts`. Claude Code reads this file at startup and spawns the server as a subprocess — you do not run it manually.

### 2.4 Set Environment Variables

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
export NOTION_WEBHOOK_SECRET="your-webhook-signing-secret"
export NOTION_FILTER_TOKEN="your-notion-integration-secret"
```

Then reload: `source ~/.bashrc`

---

## Part 3 — Cloudflare Tunnel

Notion needs a public HTTPS URL to deliver webhooks to. Cloudflare Tunnel creates a secure connection from the internet to your local port 8788 without opening firewall ports.

### 3.1 Install `cloudflared`

**Linux (Debian/Ubuntu):**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

**macOS:**
```bash
brew install cloudflare/cloudflare/cloudflared
```

Other platforms: [developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### 3.2 Start the Tunnel

```bash
cloudflared tunnel --url http://localhost:8788
```

You'll see output like:
```
Your quick Tunnel has been created! Visit it at:
https://some-random-words.trycloudflare.com
```

Copy this URL — paste it into the Notion webhook endpoint URL (step 1.5 above).

> **Note:** Quick tunnels generate a new URL each restart. For a stable permanent URL, set up a named tunnel via the Cloudflare dashboard. Update the Notion webhook URL whenever the tunnel URL changes.

---

## Part 4 — Enable Claude Code Channels

Claude Code channels require explicit opt-in at the system level.

### 4.1 Add to Managed Settings

Create or edit `/etc/claude-code/managed-settings.json` (requires sudo):

```json
{
  "channelsEnabled": true
}
```

If the file already has other settings, merge `channelsEnabled` into the existing object.

### 4.2 Launch Claude Code

```bash
cd /your/projects/root
claude --channels
```

The `--channels` flag enables channel event processing. Claude will spawn `webhook.ts` automatically from `.mcp.json`.

---

## Part 5 — The implement-feature Skill

Create a skill file at `~/.claude/skills/implement-feature/SKILL.md`:

```markdown
---
name: implement-feature
description: Use when invoked via a Notion webhook channel event with Workflow="In Progress". Runs the full automated development cycle: navigate to project, branch, implement, test, commit, push, create PR, update Notion ticket to Review. Always invoke this skill when receiving a Notion channel event with page_id, project_folder, github_repo, title, and description context.
---

# Implement Feature

Fully automated development cycle triggered by a Notion ticket reaching "In Progress" status.

You will be given this context when the skill is invoked:
- `page_id` — Notion page UUID
- `project_folder` — subfolder name under your projects root
- `github_repo` — `owner/repo` string
- `title` — ticket title (used as branch name and commit message)
- `description` — full task requirements and acceptance criteria

---

## Step 1: Navigate and Branch

```bash
cd /your/projects/root/{project_folder}
git checkout main
git pull
git checkout -b feat/notion-{first 8 chars of page_id}
```

If `git pull` fails (e.g. merge conflict), stop and add a Notion comment explaining the blocker. Do not proceed.

---

## Step 2: Understand the Codebase

Before touching any code:

1. Read `CLAUDE.md` if it exists — it contains build commands, architecture notes, and test instructions
2. Scan the top-level structure to understand the stack and patterns
3. Identify files most likely to be affected by the ticket

---

## Step 3: Implement

Implement the feature described in `description`. Follow the project's existing patterns and conventions.

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

If tests fail: fix once, re-run. If still failing: proceed but flag the failure in the PR body and Notion comment.

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

Note: Use the `Workflow` Select property — the built-in Notion Tasks `Status` property does not accept custom values via API.

Then use `notion-create-comment` to add a page comment:
```
PR ready for review: {PR URL}

What was implemented: {1-2 sentence summary}
```

---

## Error Handling

If anything blocks progress (git conflict, missing credentials, ambiguous requirements):
1. Do not guess or proceed with incomplete information
2. Add a Notion comment (prefixed with "Claude: ") describing exactly what's blocking
3. Stop — the user can reply to the comment and Claude will pick it up via the comment.created webhook
```

---

## Part 6 — GitHub MCP

Claude needs the GitHub MCP to create branches, open PRs, and check CI status.

```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/
```

Follow the prompts to authenticate with your GitHub account.

---

## Part 7 — Test It End-to-End

1. Start the Cloudflare tunnel: `cloudflared tunnel --url http://localhost:8788`
2. Start Claude: `cd /your/projects/root && claude --channels`
3. In Notion, create a task and fill in `Project Folder`, `GitHub Repo`, and `Summary`
4. Set `Workflow` to `In Progress`
5. Watch Claude receive the event and start working

To verify the webhook is reaching your server before Claude is involved, run the debug listener instead:

```bash
python3 listen.py
```

This is a Python script (included in this repo) that binds to port 8788, prints every incoming webhook payload with full detail, and shows the filter decision — useful for debugging Notion subscription and signature issues without consuming Claude tokens.

---

## Keep It Running

Use tmux for a persistent session:

```bash
# Create a named session
tmux new-session -d -s claude

# Window 0: Cloudflare tunnel
tmux send-keys -t claude "cloudflared tunnel --url http://localhost:8788" Enter

# Window 1: Claude Code
tmux new-window -t claude
tmux send-keys -t claude "cd /your/projects/root && claude --channels" Enter

# Attach to monitor
tmux attach-session -t claude
```

---

## Gotchas and Lessons Learned

These are things that are not obvious from the documentation and cost real debugging time:

**Channels require managed settings, not just a flag**
`channelsEnabled: true` must be set in `/etc/claude-code/managed-settings.json`. Without it, events are silently dropped even if the `--channels` flag is passed.

**The Notion webhook payload is sparse**
`page.properties_updated` does not include property values in the payload. The field `data.updated_properties` is always an empty array — do not try to filter on it. You must call the Notion API separately to fetch current property values.

**Do not use the built-in Status property for automation state**
The Notion Tasks database `Status` property only accepts "Not Started", "Done", and "Archived" via API. Options like "Review" exist in the UI but can't be written back programmatically. Use a custom `Workflow` Select property instead.

**`Workflow` changes do fire `page.properties_updated` webhooks**
Custom Select properties fire the same webhook as built-in properties. This is what you want — use `Workflow` as the automation trigger.

**No race condition**
Notion webhooks take several seconds to arrive after a property change. By the time the webhook reaches your server, the page is already updated. No delay is needed before fetching page properties.

**Feedback loop prevention**
When Claude writes a Notion comment using the integration token, Notion sets `authors[0].type = "integration"` on that `comment.created` event. The server checks this and drops it. Without this check, Claude's own comments would trigger it to process itself in a loop.

**`comment.created` requires two things**
1. The integration must have **"Read comments"** capability enabled in its settings
2. The integration must be explicitly **connected to the page** (via `...` → Connections on the page itself, or connected at the database level which propagates to all pages)

**Comments appear under the integration's name**
When Claude creates a comment via the API, it shows under the integration bot's name in Notion — not yours. Give the integration a clear name ("Claude") and a distinctive avatar so it's obvious who posted it.

**Empty `authors` array edge case**
In JavaScript, `[].every(fn)` returns `true` (vacuous truth). If you filter with `authors?.every(a => a.type !== 'person')`, an empty `authors` array will match and the event will be incorrectly dropped. Always check `authors && authors.length > 0` first.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Events silently dropped, no Claude reaction | Add `channelsEnabled: true` to `/etc/claude-code/managed-settings.json` and restart Claude |
| Webhook not reaching server | Is the Cloudflare tunnel running? Is the URL in the Notion webhook endpoint current? |
| Notion verification handshake failing | The server must be running before you save the Notion webhook endpoint |
| `comment.created` events not arriving | Check integration has "Read comments" capability; check integration is connected to the page |
| Claude can't read the page | Verify Notion MCP is registered: `claude mcp list` — `notion` should appear |
| Claude can't open a PR | Verify GitHub MCP is registered: `claude mcp list` — `github` should appear |
| `Workflow` update fails | Confirm the `Workflow` property is type **Select** (not Status) in the Notion database |
| Filter not working (all events forwarded) | Check `NOTION_FILTER_TOKEN` is set and the integration has access to the page |
| Integration secret rejected | The `NOTION_WEBHOOK_SECRET` must match the Webhook Signing Secret from the Notion webhook settings (not the integration secret) |

---

## References

- [Claude Code Channels docs](https://docs.anthropic.com/en/docs/claude-code/channels)
- [Notion Webhooks API reference](https://developers.notion.com/reference/webhooks)
- [Notion Webhook Actions help](https://www.notion.com/help/webhook-actions)
- [MCP SDK (TypeScript)](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cloudflare Tunnel quickstart](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Bun runtime](https://bun.sh)
