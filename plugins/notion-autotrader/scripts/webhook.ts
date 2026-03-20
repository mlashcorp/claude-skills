#!/usr/bin/env bun
import { createHmac, timingSafeEqual } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const NOTION_TOKEN = process.env.NOTION_FILTER_TOKEN
const NOTION_VERSION = '2022-06-28'

// Fetch the bot user ID for this integration so we can filter out Claude's own comments
let BOT_USER_ID: string | null = null
if (NOTION_TOKEN) {
  try {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
      },
    })
    const data = await res.json() as any
    BOT_USER_ID = data.bot?.owner?.user?.id ?? data.id ?? null
    console.error(`[notion-webhook] Bot user ID: ${BOT_USER_ID}`)
  } catch (err) {
    console.error('[notion-webhook] Failed to fetch bot user ID:', err)
  }
}

function isOwnAuthor(authors: Array<{ id: string; type: string }> | undefined): boolean {
  if (!authors || authors.length === 0) return false
  // Drop if all authors are non-person types (original check)
  if (authors.every(a => a.type !== 'person')) return true
  // Drop if all authors match our bot's user ID (internal integrations appear as person)
  if (BOT_USER_ID && authors.every(a => a.id === BOT_USER_ID)) return true
  return false
}

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
The bun server has already pre-filtered this event: Workflow is either "In Progress" (no GitHub PR) or "Done".
Fetch the page via Notion MCP to get current properties, then route by Workflow:
- "In Progress" + no GitHub PR: invoke the implement-feature skill passing:
  - page_id: entity.id
  - project_folder: from "Project Folder" rich_text property
  - github_repo: from "GitHub Repo" rich_text property
  - title: from "Task name" title property
  - description: from "Summary" rich_text property
- "Done": merge and deploy flow (skill TBD)
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
    // Set NOTION_WEBHOOK_SECRET to your webhook's verification_token from Notion
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

    // Filter: only forward events that require Claude's attention
    const type = parsed.type as string | undefined

    if (type === 'page.properties_updated') {
      const pageId = (parsed as any)?.entity?.id as string | undefined
      // Drop events authored by this integration (Claude's own writes) to prevent feedback loops
      const authors = (parsed as any)?.authors as Array<{ id: string; type: string }> | undefined
      if (isOwnAuthor(authors)) {
        console.error(`[notion-webhook] Ignored: authored by this integration`)
        return new Response('Ignored', { status: 200 })
      }
      if (pageId && NOTION_TOKEN) {
        // Brief delay to let Notion propagate the property change before we read it
        await new Promise(resolve => setTimeout(resolve, 1500))
        const props = await fetchPageProperties(pageId)
        if (props) {
          const workflow = getPropertyValue(props, 'Workflow')
          const githubPR = getPropertyValue(props, 'GitHub PR')
          console.error(`[notion-webhook] Page ${pageId} — Workflow: ${workflow}, GitHub PR: ${githubPR}`)
          if (workflow === 'In Progress' && !githubPR) {
            // fall through — forward to Claude for implement-feature
          } else if (workflow === 'Done') {
            // fall through — forward to Claude for merge-deploy
          } else {
            console.error(`[notion-webhook] Ignored: Workflow="${workflow}" GitHub PR="${githubPR}"`)
            return new Response('Ignored', { status: 200 })
          }
        }
      }
    } else if (type === 'comment.created') {
      // Drop comments authored by this integration (Claude's own replies) to prevent feedback loops
      const authors = (parsed as any)?.authors as Array<{ id: string; type: string }> | undefined
      if (isOwnAuthor(authors)) {
        console.error(`[notion-webhook] Ignored: comment authored by this integration`)
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
