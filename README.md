# Claude Skills Marketplace

A Claude Code plugin marketplace with skills for automating software development workflows.

## Install

```
/plugin marketplace add mlashcorp/claude-skills
```

## Plugins

### notion-claude-integration

Automates the full dev cycle from Notion tickets. Moving a ticket to **In Progress** triggers Claude to:
- Create a feature branch
- Implement the task
- Run tests
- Open a GitHub PR
- Set the ticket to **Review** and post the PR link as a comment

Comments on the Notion page go directly to Claude for feedback and revisions.

**Install:**
```
/plugin install notion-claude-integration@notion-claude-integration
```

**After installing, run the interactive setup wizard:**
```bash
bash ~/.claude/plugins/cache/notion-claude-integration/notion-claude-integration/*/scripts/setup.sh
```

The wizard installs `bun` and `cloudflared`, adds the required properties to your Notion database, guides you through webhook creation, and saves all credentials to your shell profile.

See [`plugins/notion-claude-integration/docs/SETUP.md`](plugins/notion-claude-integration/docs/SETUP.md) for the full setup guide.

---

## Requirements

- Claude Code v2.1.80+, logged in with a claude.ai account
- Notion paid plan (webhooks require a paid plan)
- GitHub account
- `bun` and `cloudflared` (the setup script installs both)

## License

MIT
