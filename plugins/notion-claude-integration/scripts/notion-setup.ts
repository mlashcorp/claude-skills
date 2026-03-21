#!/usr/bin/env bun
/**
 * notion-setup.ts
 *
 * Interactive setup script for notion-claude-integration.
 * Run via: bun run notion-setup.ts
 *
 * What it does:
 *  1. Guides you to create a Notion integration and collect the token
 *  2. Verifies the token against the Notion API
 *  3. Finds your tasks database (search or paste URL)
 *  4. Adds the required properties to the database via Notion API:
 *       - Workflow (select: Not Started / In Progress / Review / Done)
 *       - Project Folder (rich_text)
 *       - GitHub Repo    (rich_text)
 *       - GitHub PR      (url)
 *       - Summary        (rich_text)
 *  5. Guides you to create the webhook subscription in the Notion UI
 *     and collect the signing secret
 *  6. Saves NOTION_FILTER_TOKEN and NOTION_WEBHOOK_SECRET to your shell profile
 */

import readline from 'readline'
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const NOTION_VERSION = '2022-06-28'
const BASE_URL = 'https://api.notion.com/v1'

// ─── Prompt helpers ───────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()))
  })
}

async function askSecret(question: string): Promise<string> {
  // Hide input on terminals that support it
  if (process.stdout.isTTY) {
    process.stdout.write(question)
    const { execSync } = await import('child_process')
    try {
      const result = execSync('stty -echo 2>/dev/null; read ans; stty echo 2>/dev/null; echo "$ans"', {
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: '/bin/bash',
      })
      process.stdout.write('\n')
      return result.toString().trim()
    } catch {
      // Fall back to visible input
      return ask(question)
    }
  }
  return ask(question)
}

async function confirm(question: string): Promise<boolean> {
  const ans = await ask(`${question} [y/N] `)
  return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes'
}

function print(msg = '') { console.log(msg) }
function ok(msg: string) { console.log(`  \x1b[32m✔\x1b[0m  ${msg}`) }
function warn(msg: string) { console.log(`  \x1b[33m⚠\x1b[0m  ${msg}`) }
function fail(msg: string) { console.log(`  \x1b[31m✘\x1b[0m  ${msg}`) }
function info(msg: string) { console.log(`  \x1b[36mℹ\x1b[0m  ${msg}`) }
function hr() { console.log('\n' + '─'.repeat(60) + '\n') }
function heading(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`) }

// ─── Notion API helpers ───────────────────────────────────────────────────────

async function notionGet(path: string, token: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${data.message ?? JSON.stringify(data)}`)
  return data
}

async function notionPatch(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${data.message ?? JSON.stringify(data)}`)
  return data
}

async function notionPost(path: string, token: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${data.message ?? JSON.stringify(data)}`)
  return data
}

// ─── Database ID parsing ──────────────────────────────────────────────────────

function parseDatabaseId(input: string): string | null {
  // Strip query string
  const clean = input.split('?')[0].split('#')[0]

  // Already a bare UUID (with or without dashes)
  const uuidNoDash = clean.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(uuidNoDash)) {
    return [
      uuidNoDash.slice(0, 8),
      uuidNoDash.slice(8, 12),
      uuidNoDash.slice(12, 16),
      uuidNoDash.slice(16, 20),
      uuidNoDash.slice(20),
    ].join('-')
  }

  // Notion URL: last path segment contains the ID (32 hex chars, optionally with dashes)
  const segments = clean.split('/')
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    // Segment may be "My-Database-32hexchars" or just "32hexchars"
    const match = seg.match(/([0-9a-f]{32})$/i) ?? seg.replace(/-/g, '').match(/^[0-9a-f]{32}$/i)
    if (match) {
      const hex = (match[0] ?? seg).replace(/-/g, '')
      if (hex.length === 32) {
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
      }
    }
  }
  return null
}

// ─── Shell profile helpers ────────────────────────────────────────────────────

function detectShellProfile(): string {
  const shell = process.env.SHELL ?? ''
  const home = homedir()
  if (shell.includes('zsh')) return join(home, '.zshrc')
  if (shell.includes('fish')) return join(home, '.config', 'fish', 'config.fish')
  return join(home, '.bashrc')
}

function isVarInProfile(profile: string, key: string): boolean {
  if (!existsSync(profile)) return false
  return readFileSync(profile, 'utf8').includes(`export ${key}=`)
}

function appendToProfile(profile: string, lines: string[]) {
  const block = '\n# notion-claude-integration\n' + lines.join('\n') + '\n'
  appendFileSync(profile, block)
}

function writeClaudeSettings(vars: Array<{ key: string; value: string }>) {
  // Write env vars to ~/.claude/settings.json so Claude Code sessions pick them
  // up immediately without requiring a shell restart
  const settingsPath = `${homedir()}/.claude/settings.json`
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    // File doesn't exist yet — start fresh
  }
  if (!settings.env) settings.env = {}
  for (const { key, value } of vars) {
    settings.env[key] = value
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  print()
  heading('notion-claude-integration setup')
  print('Sets up your Notion integration and database for Claude Code automation.')
  hr()

  // ── Step 1: Notion integration token ──────────────────────────────────────

  heading('Step 1 of 5 — Notion Integration')
  print()
  print('You need an internal Notion integration so this plugin can read and write')
  print('your Notion database and create/update pages and comments.')
  print()
  info('Create one at: https://www.notion.so/profile/integrations')
  print()
  print('Click "New integration", give it a name (e.g. "Claude"),')
  print('and enable these capabilities:')
  print('   • Read content')
  print('   • Update content')
  print('   • Insert content')
  print('   • Read comments')
  print('   • Create comments')
  print()
  print('After saving, copy the "Internal Integration Secret" (starts with secret_).')
  print()

  let token = process.env.NOTION_FILTER_TOKEN ?? ''
  if (token) {
    info(`NOTION_FILTER_TOKEN already set in environment — using existing token.`)
  } else {
    token = await askSecret('Paste your integration secret: ')
    if (!token) { fail('No token provided. Exiting.'); process.exit(1) }
  }

  // Verify the token
  print()
  process.stdout.write('  Verifying token... ')
  try {
    const me = await notionGet('/users/me', token)
    const botName = me.name ?? me.bot?.owner?.user?.name ?? 'unknown'
    process.stdout.write('\r')
    ok(`Token valid — integration: "${botName}"`)
  } catch (e: any) {
    process.stdout.write('\r')
    fail(`Token invalid: ${e.message}`)
    process.exit(1)
  }

  hr()

  // ── Step 2: Find the database ──────────────────────────────────────────────

  heading('Step 2 of 5 — Tasks Database')
  print()
  print('The plugin needs access to your Notion tasks database.')
  print()
  info('First, connect the integration to your database:')
  print('   1. Open your tasks database in Notion')
  print('   2. Click the "..." menu in the top-right')
  print('   3. Go to Connections → connect your integration')
  print()

  // Search for databases the integration can see
  let databaseId: string | null = null
  try {
    const results = await notionPost('/search', token, {
      filter: { value: 'database', property: 'object' },
      page_size: 20,
    }) as any
    const databases = results.results ?? []

    if (databases.length > 0) {
      print('Databases your integration can access:')
      databases.forEach((db: any, i: number) => {
        const title = db.title?.[0]?.plain_text ?? '(untitled)'
        print(`   ${i + 1}. ${title} — ${db.id}`)
      })
      print()
      const choice = await ask(`Enter a number (1-${databases.length}), or paste a database URL/ID directly: `)
      const num = parseInt(choice)
      if (num >= 1 && num <= databases.length) {
        databaseId = databases[num - 1].id
      } else {
        databaseId = parseDatabaseId(choice)
      }
    } else {
      warn('No databases found — make sure the integration is connected to your database.')
      print()
      const raw = await ask('Paste your database URL or ID: ')
      databaseId = parseDatabaseId(raw)
    }
  } catch {
    warn('Could not search databases. Falling back to manual entry.')
    const raw = await ask('Paste your database URL or ID: ')
    databaseId = parseDatabaseId(raw)
  }

  if (!databaseId) {
    fail('Could not parse a valid database ID. Exiting.')
    print()
    print('To find your database ID: open the database in Notion, click "Share",')
    print('then "Copy link". The 32-character hex string at the end of the URL is the ID.')
    process.exit(1)
  }

  ok(`Database ID: ${databaseId}`)

  // Verify we can read it
  let existingProps: Record<string, any> = {}
  try {
    const db = await notionGet(`/databases/${databaseId}`, token)
    existingProps = db.properties ?? {}
    const title = db.title?.[0]?.plain_text ?? '(untitled)'
    ok(`Database verified: "${title}"`)
  } catch (e: any) {
    fail(`Cannot read database: ${e.message}`)
    print()
    warn('Make sure the integration is connected to this database (see step above).')
    process.exit(1)
  }

  hr()

  // ── Step 3: Add required properties ───────────────────────────────────────

  heading('Step 3 of 5 — Database Properties')
  print()
  print('The plugin requires these properties on each ticket:')
  print('   • Workflow      (Select)   — automation state')
  print('   • Project Folder (Text)    — subfolder name under your projects root')
  print('   • GitHub Repo   (Text)     — owner/repo format')
  print('   • GitHub PR     (URL)      — filled by Claude after PR creation')
  print('   • Summary       (Text)     — task description and requirements')
  print()

  const required: Array<{ name: string; schema: Record<string, any>; type: string }> = [
    {
      name: 'Workflow',
      type: 'select',
      schema: {
        select: {
          options: [
            { name: 'Not Started', color: 'gray' },
            { name: 'In Progress', color: 'blue' },
            { name: 'Review',      color: 'yellow' },
            { name: 'Done',        color: 'green' },
          ],
        },
      },
    },
    { name: 'Project Folder', type: 'rich_text', schema: { rich_text: {} } },
    { name: 'GitHub Repo',    type: 'rich_text', schema: { rich_text: {} } },
    { name: 'GitHub PR',      type: 'url',       schema: { url: {} } },
    { name: 'Summary',        type: 'rich_text', schema: { rich_text: {} } },
  ]

  const toAdd: Record<string, any> = {}
  const alreadyExist: string[] = []

  for (const prop of required) {
    if (existingProps[prop.name]) {
      alreadyExist.push(prop.name)
    } else {
      toAdd[prop.name] = prop.schema
    }
  }

  if (alreadyExist.length > 0) {
    for (const name of alreadyExist) ok(`"${name}" already exists — skipping`)
  }

  if (Object.keys(toAdd).length === 0) {
    ok('All required properties already exist!')
  } else {
    print()
    print(`Adding ${Object.keys(toAdd).length} missing propert${Object.keys(toAdd).length === 1 ? 'y' : 'ies'}...`)
    try {
      await notionPatch(`/databases/${databaseId}`, token, { properties: toAdd })
      for (const name of Object.keys(toAdd)) ok(`Added "${name}"`)
    } catch (e: any) {
      fail(`Failed to add properties: ${e.message}`)
      print()
      warn('Some property types (especially Select) may need to be added manually:')
      print('   1. Open your database in Notion')
      print('   2. Click "+" to add a column')
      print('   3. For "Workflow": choose Select and add options:')
      print('      Not Started, In Progress, Review, Done')
      print('   4. For the rest: choose Text or URL as appropriate')
      print()
      if (!await confirm('Continue with setup anyway?')) process.exit(1)
    }
  }

  hr()

  // ── Step 4: Webhook ────────────────────────────────────────────────────────

  heading('Step 4 of 5 — Webhook Subscription')
  print()
  print('Notion needs to send events to this plugin when tickets change.')
  print('This requires a public HTTPS URL (your Cloudflare tunnel) and a')
  print('webhook subscription configured in the Notion integration settings.')
  print()
  info('Start your Cloudflare tunnel first (in a separate terminal):')
  print('   cloudflared tunnel --url http://localhost:8788')
  print()
  print('Copy the URL it prints (e.g. https://some-words.trycloudflare.com).')
  print()

  const tunnelUrl = await ask('Paste your tunnel URL (or press Enter to skip): ')

  let webhookSecret = ''

  if (tunnelUrl) {
    print()
    info('Create the webhook subscription:')
    print(`   1. Go to: https://www.notion.so/profile/integrations`)
    print('   2. Open your integration ("Claude")')
    print('   3. Click the "Webhooks" tab → "Add new endpoint"')
    print(`   4. URL: ${tunnelUrl}`)
    print('   5. Event types: check both:')
    print('        ✓ page.properties_updated')
    print('        ✓ comment.created')
    print('   6. Save — Notion will send a verification handshake to your server')
    print('      (your Claude session / start-webhook.sh handles this automatically)')
    print()
    print('After saving, Notion shows a "Webhook Signing Secret" on the webhook page.')
    print()
    webhookSecret = await askSecret('Paste the Webhook Signing Secret: ')
    if (webhookSecret) {
      ok('Webhook signing secret captured')
    } else {
      warn('No signing secret provided — HMAC verification will be disabled.')
      warn('You can add NOTION_WEBHOOK_SECRET to your shell profile later.')
    }
  } else {
    warn('Skipped webhook setup. You can complete it later.')
    info('See docs/SETUP.md for full webhook instructions.')
  }

  hr()

  // ── Step 5: Save env vars ──────────────────────────────────────────────────

  heading('Step 5 of 5 — Environment Variables')
  print()

  const profile = detectShellProfile()
  print(`Shell profile: ${profile}`)
  print()

  const vars: Array<{ key: string; value: string }> = []
  if (token && !isVarInProfile(profile, 'NOTION_FILTER_TOKEN')) {
    vars.push({ key: 'NOTION_FILTER_TOKEN', value: token })
  } else if (token) {
    ok('NOTION_FILTER_TOKEN already in profile — skipping')
  }
  if (webhookSecret && !isVarInProfile(profile, 'NOTION_WEBHOOK_SECRET')) {
    vars.push({ key: 'NOTION_WEBHOOK_SECRET', value: webhookSecret })
  } else if (webhookSecret) {
    ok('NOTION_WEBHOOK_SECRET already in profile — skipping')
  }

  if (!process.env.CLAUDE_PROJECTS_ROOT && !isVarInProfile(profile, 'CLAUDE_PROJECTS_ROOT')) {
    print()
    info('CLAUDE_PROJECTS_ROOT tells Claude where your projects live.')
    print('   This should be the folder that contains all your project subfolders.')
    print('   Example: if your projects are at /home/alice/code/my-app, set it to /home/alice/code')
    print()
    const projectsRoot = await ask('Path to your projects folder (default: ~/projects): ')
    vars.push({ key: 'CLAUDE_PROJECTS_ROOT', value: projectsRoot || `${homedir()}/projects` })
  } else if (process.env.CLAUDE_PROJECTS_ROOT) {
    ok(`CLAUDE_PROJECTS_ROOT already set to: ${process.env.CLAUDE_PROJECTS_ROOT}`)
  }

  if (vars.length > 0) {
    print()
    print('The following will be added to your shell profile:')
    for (const v of vars) print(`   export ${v.key}="${v.value}"`)
    print()

    if (await confirm(`Add to ${profile}?`)) {
      appendToProfile(profile, vars.map(v => `export ${v.key}="${v.value}"`))
      ok(`Saved to ${profile}`)
      warn(`Run: source ${profile}   (or open a new terminal)`)
      writeClaudeSettings(vars.filter(v => v.key === 'CLAUDE_PROJECTS_ROOT'))
      ok('Also saved CLAUDE_PROJECTS_ROOT to ~/.claude/settings.json (takes effect in new Claude Code sessions)')
    } else {
      warn('Skipped — add these to your shell profile manually:')
      for (const v of vars) print(`   export ${v.key}="${v.value}"`)
    }
  } else {
    ok('All environment variables are already configured')
  }

  hr()

  // ── Summary ────────────────────────────────────────────────────────────────

  heading('Setup complete!')
  print()
  print('Next steps:')
  print('  1. Run:  source ' + profile)
  print('  2. Start your Cloudflare tunnel:')
  print('        cloudflared tunnel --url http://localhost:8788')
  print('  3. Launch Claude with channels enabled:')
  print('        claude --channels')
  print('  4. In Notion, add a task, fill in Project Folder + GitHub Repo + Summary,')
  print('     then set Workflow → "In Progress"')
  print('  5. Watch Claude implement it automatically')
  print()
  info('Full guide: docs/SETUP.md')
  print()

  rl.close()
}

main().catch(e => {
  console.error('\nFatal error:', e.message)
  process.exit(1)
})
