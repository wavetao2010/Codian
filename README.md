# Codian

Codian is an Obsidian desktop plugin that embeds the local Codex CLI in a vault chat view.

It follows the same broad idea as Claudian, but targets Codex:

- runs `codex exec --json` from inside the current vault
- streams JSONL events into an Obsidian view
- resumes the current Codex thread when Codex reports a `thread_id`
- supports custom Codex CLI path, model, sandbox mode, approval policy, extra CLI args, and environment variables
- supports multiple chat tabs with independent Codex threads
- can attach active note, selected text, and chosen vault files as context
- includes slash commands such as `/plan`, `/summarize`, `/rewrite`, `/find`, and `/review`
- includes inline selection editing from the Obsidian command palette
- includes a Codian Plan mode that runs Codex in read-only mode and asks for an implementation plan instead of edits

## Requirements

- Obsidian desktop
- Codex CLI installed and authenticated
- Node.js for building the plugin

Check your Codex CLI:

```bash
codex --help
codex exec --json "summarize this folder" --skip-git-repo-check
```

## Build

```bash
npm install
npm run build
```

This produces `main.js` next to `manifest.json` and `styles.css`.

## Install into a vault

Create this folder in your vault:

```text
.obsidian/plugins/codian
```

Copy or symlink these files into it:

```text
manifest.json
main.js
styles.css
```

Then restart Obsidian or reload plugins and enable **Codian**.

## Notes

The default sandbox is `workspace-write`, so Codex can edit files in the vault while still running under Codex sandboxing. Change this to `read-only` in settings if you only want analysis and answers.
