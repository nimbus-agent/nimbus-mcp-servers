# Obsidian Connector

## What this is

First-party Nimbus MCP connector for local Obsidian vaults. It lets the Nimbus agent list, read and
search the notes of the vaults you configure, read the end of a daily note, and append text to a
daily note. It makes no network requests.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Obsidian has no credential: `nimbus connector auth obsidian` does not work. The
Gateway discovers vaults (directories containing `.obsidian/`) under the
`[[filesystem.roots]]` entries in your `nimbus.toml`:

```toml
[[filesystem.roots]]
path = "~/Documents/MyVault"
```

```bash
nimbus ask "Summarize my recent activity in Obsidian"
```

The gateway passes the configured paths to the connector as an environment variable at spawn time.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OBSIDIAN_VAULT_PATHS_JSON` | yes | A JSON array of strings, the directories to search for vaults. The connector fails to start when it is unset, not valid JSON, or not an array of strings. |

Each listed directory is walked recursively for folders that contain `.obsidian`; every such folder
is a vault. The walk skips symlinks and junctions, and the folders `node_modules`, `.git`, `dist`,
`build`, `target`, `.next`, `out`, `vendor` and `.cache`. A vault's id is the first 12 hex
characters of the SHA-256 of its absolute path, and its name is the folder name. Notes are the
`.md` files of a vault, found the same way (symlinks skipped, a nested vault not entered).

Every path a tool takes is confined to its vault: it is checked as a string against the vault root,
and then by its real path, so a folder or note that is, or passes through, a symlink or junction
out of the vault is refused (`Path escapes vault`). A dangling link is refused too. The check and
the later open are two separate system calls, so a link swapped in between is not seen; the
gateway's sandbox, which grants only the vaults, is the boundary.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `obsidian_list` | List notes (id, vault, path, title), optionally for one `vault` (id or path), or those whose frontmatter contains `tag`; `limit` 1-500 (default 200). |
| `obsidian_get` | Read one note, by `id` (`obsidian:<vaultId>#<path>`) or by `vault` plus `path`. Returns the title and the body without its frontmatter. |
| `obsidian_search` | Case-insensitive substring search of note titles and bodies, optionally in one `vault`: `limit` 1-200 (default 50). Each hit carries a snippet of up to 240 characters. |
| `obsidian_append_to_daily_note` (write) | Append `content` to the daily note of `vault_id` for `date_iso` (`YYYY-MM-DD`, today in UTC when omitted). |
| `obsidian_daily_note_get` | Read the end of the same daily note that the append would write: the last 16 KiB at most, starting on a character boundary. A missing note is `exists: false`. |

The daily note's location follows the vault's own `.obsidian/daily-notes.json` (`folder` and
`format`, where the format may use the tokens `YYYY`, `YY`, `MM`, `DD`, `HH` and `mm`, in UTC). An
absent or malformed file falls back to `YYYY-MM-DD.md` at the vault root.

### The writes

`obsidian_append_to_daily_note` is the only write, and it registers through
`createWriteToolRegistrar`. It only ever appends, never overwrites, and creates the note and its
folders when they are missing; when the existing file does not end in a newline it adds one first.
The registration declares it recoverable, since the note can be edited back.

Standalone, the consent prompt, the write scope, the mutation budget and the audit record apply;
inside the gateway the executor's approval is the gate. The standalone scope variable is
`NIMBUS_MCP_OBSIDIAN_WRITE_SCOPE`, with one kind, `vault`: a term is `vault:<vault_id>` and matches
exactly the `vault_id` string the call passes.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
