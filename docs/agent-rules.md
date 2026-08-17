# Agent rules

Write your agent instructions once in Toolport and have them applied to every AI
client on your machine, instead of hand-editing `CLAUDE.md`, `AGENTS.md`,
`GEMINI.md` and the rest and keeping them in sync yourself.

Open the **Agent rules** tab in the sidebar. No MCP server or gateway needed.

## How it works

You write one or more named **rule sets**. Exactly one is active at a time, so you
can keep, say, a "Work" set and a "Personal" set and switch between them.

Toolport writes the active set into each client's own **global** rules file, using
one of two strategies depending on how the client stores them:

- **Toolport owns a whole file.** For clients that read a rules _directory_,
  Toolport creates its own file in it (`toolport-rules.md`). Nothing of yours is
  in that file, so it can be replaced and deleted freely.
- **Toolport owns a marked block.** For clients that read a single shared file you
  also edit, Toolport appends a block between two HTML-comment markers and only
  ever rewrites what is between them. Every other byte in the file is left exactly
  as it is.

Either way, your own instructions are never overwritten. Turning a client off, or
deleting the active set, removes what Toolport wrote and leaves the rest of the
file alone.

## Before anything is written

- **Every client starts switched off.** Nothing is written until you turn a client
  on in the Clients list.
- **Preview shows the exact bytes.** Each client has a Preview button that renders
  the file Toolport would write, without writing it.

## Supported clients

| Client            | Rules file                                                           | Strategy     |
| ----------------- | -------------------------------------------------------------------- | ------------ |
| Claude Code       | `~/.claude/rules/toolport-rules.md`                                  | Owned file   |
| VS Code (Copilot) | `~/.claude/rules/toolport-rules.md` (shared with Claude Code)        | Owned file   |
| Kiro              | `~/.kiro/steering/toolport-rules.md`                                 | Owned file   |
| Roo Code          | `~/.roo/rules/toolport-rules.md`                                     | Owned file   |
| Cline             | `~/Documents/Cline/Rules/toolport-rules.md`                          | Owned file   |
| Codex             | `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`)               | Marked block |
| Gemini CLI        | `$GEMINI_CLI_HOME/.gemini/GEMINI.md` (default `~/.gemini/GEMINI.md`) | Marked block |
| Antigravity       | `~/.gemini/GEMINI.md` (shared with Gemini CLI)                       | Marked block |
| Windsurf          | `~/.codeium/windsurf/memories/global_rules.md`                       | Marked block |
| Goose             | `.goosehints` beside `config.yaml` (honours `GOOSE_PATH_ROOT`)       | Marked block |
| Zed               | `AGENTS.md` in Zed's config directory                                | Marked block |
| Pi                | `~/.pi/agent/AGENTS.md`                                              | Marked block |
| Oh My Pi          | `~/.omp/agent/AGENTS.md`                                             | Marked block |

On Linux, Goose and Zed follow `XDG_CONFIG_HOME`. On Windows, Goose and Zed use the
roaming config directory.

Where two clients share a file, Toolport writes it once. Both are covered even if
only one is installed.

### Clients with no rules file Toolport can write

**Cursor** and **Warp** keep their global rules in their own UI or account rather
than in a file on disk. They appear in the Clients list marked "Copy manually", so
you can paste your rules in yourself. Toolport does not silently skip them.

## Per-client states

| State                       | Meaning                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applied                     | This client's rules file is up to date.                                                                                                                                                                                    |
| Not applied yet             | The current rules are not on disk for this client yet. Use Re-apply.                                                                                                                                                       |
| Blocked by a local override | The client has an override file making it ignore the file Toolport writes. Codex's `AGENTS.override.md` is the case this covers: while it exists, Codex ignores `AGENTS.md` entirely, so writing there would be invisible. |
| Too long for this client    | The client caps its global rules file and these rules would exceed it. Windsurf caps its file at 6,000 characters, counted across the whole file, including anything you have in it.                                       |
| Copy manually               | No rules file Toolport can write. See above.                                                                                                                                                                               |
| Write error                 | The file could not be read or written. It was left untouched.                                                                                                                                                              |

## Team instructions

If you are in a Toolport Teams org, your admin can push team-wide instructions as
well (see the Teams tab). Team and personal rules are independent and coexist in
the same files: they use different markers and different file names, so applying or
removing one never disturbs the other.

Where a client caps its rules file, both blocks count toward that cap.

## Project-level rules

Not supported yet. Agent rules currently covers **global** (user-level) rules only.
Per-project `CLAUDE.md` / `AGENTS.md` files are yours to manage.
