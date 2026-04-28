# Codex Companion

Codex Companion is an Obsidian desktop plugin that embeds the local Codex CLI in a vault chat view.

It is designed for people who want to use Codex as a coding and writing collaborator directly inside a vault. Codex Companion runs Codex from the current vault folder, streams Codex output into a side view, and can attach notes or selected text as context.

## Features

- Run `codex exec --json` from inside the current vault
- Stream Codex responses, reasoning summaries, and tool events into an Obsidian chat view
- Keep multiple conversations with independent Codex threads
- Attach the active note, selected text, and chosen vault files as context
- Use `@` mention suggestions to attach notes and files from the composer
- Select Codex model and reasoning effort from the plugin toolbar
- Switch between normal agent mode and Plan mode
- Run inline edits on selected text from the Obsidian command palette
- Use slash commands such as `/plan`, `/summarize`, `/rewrite`, `/find`, and `/review`

## Requirements

- Obsidian desktop
- Codex CLI installed and authenticated
- A Codex CLI configuration that can run from your terminal

Codex Companion is desktop-only because it uses local Node.js APIs and spawns the Codex CLI process.

Check your Codex CLI before using the plugin:

```bash
codex --help
codex exec --json "summarize this folder" --skip-git-repo-check
```

## Usage

1. Enable Codex Companion in Obsidian's community plugin settings.
2. Open it from the ribbon icon or command palette.
3. Check plugin settings if the plugin cannot find your Codex CLI path automatically.
4. Type a prompt and press Enter on macOS, or Ctrl/Mod+Enter on other platforms.
5. Attach note context with the paperclip button or by typing `@` in the composer.

## Settings

- **Codex CLI path**: Optional explicit path to the `codex` executable.
- **Model**: Optional model override passed to Codex.
- **Reasoning effort**: Optional reasoning effort override.
- **Sandbox mode**: Codex sandbox mode, such as `read-only` or `workspace-write`.
- **Approval policy**: Codex approval policy.
- **Environment variables**: Extra environment variables for the Codex process.
- **Context options**: Toggle active note and selected text context.
- **Conversation limit**: Maximum number of saved conversations.

## Safety

Codex Companion runs Codex CLI locally from your vault folder. Depending on your Codex CLI configuration and selected sandbox mode, prompts, attached notes, selected text, file paths, and tool output may be sent to Codex.

The default sandbox mode is `workspace-write`, which allows Codex to modify files in the vault under Codex sandboxing. Use `read-only` if you only want analysis and answers. Use backups or version control for important vaults before allowing automated edits.

## Build

```bash
npm install
npm run build
```

This produces `main.js` next to `manifest.json` and `styles.css`.

## Manual installation

Create this folder in your vault:

```text
.obsidian/plugins/codian
```

Copy these files into it:

```text
manifest.json
main.js
styles.css
```

Then restart Obsidian or reload plugins and enable **Codex Companion**.

## Release assets

For an Obsidian community plugin release, attach these files to the GitHub release:

```text
manifest.json
main.js
styles.css
```

The icon is bundled into `main.js` during build, so `icon.svg` is kept in the repository for source maintenance but is not required as a release asset.
