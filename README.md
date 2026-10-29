# dsh-session-cleaner

English | [中文](README.zh.md)

**Session Cleaner** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin (bundle) that adds the missing destructive session operations to the Web GUI, directly in the session list and the chat interface:

- **Delete a whole session** — in a session row's "…" menu (sidebar), or via a trash button in the chat session header. The session's entire history is permanently removed.
- **Delete from any message** — every finalized assistant message gains a "Delete from here…" action. The earlier conversation is forked into a same-titled continuation session and the original session is deleted, so the chosen message and everything after it are gone.

Both operations ask for explicit confirmation before anything is destroyed.

## How it works

The Harness session log is append-only by design, and no public Host service deletes sessions. This bundle uses the sanctioned seams only:

1. `workspaceRegistry.archiveSession(id, { stopActivity: true })` stops any running turn, subagent, background job, or reminder through the composed activity providers and hides the session.
2. The session's own log directory under the JSONL persistence root (`<dsh-home>/sessions/<project>/<session-id>/`) is removed — after a strict check that the directory really contains a session log — along with its persisted projection-cache record.
3. `workspaceRegistry.unarchiveSession(id)` drops the archive marker so no stale id remains. The workspace registry filters log-less session ids out of its tables, so the session disappears everywhere.
4. "Delete from here" first forks the prefix before the chosen message into a same-titled continuation (`ctx.sessions.fork({ atSeq })`, `increaseTitle: false`), then deletes the original.

The Client half reaches the Host half through same-origin POSTs to `/session-cleaner/api/*`, admitted only through `ctx.connection.requestRejection()` like every other trusted browser peer.

## Install

From the dsh CLI:

```bash
dsh --profile <your-profile> plugin install git+https://github.com/<owner>/dsh-session-cleaner.git
```

Or in the Web GUI: **Plugins → Install → Git**, using the repository URL. From a local checkout, pass the package directory to `plugin_manager`'s `install_bundle`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `root` | `dshHomePath('sessions')` | JSONL session-persistence root this bundle deletes from. Point it at your `dsh-session-persistence-jsonl` `root` if you changed it. |

## Safety

- Live sessions with running work are stopped (not silently killed) through the workspace activity providers before deletion.
- A directory without a recognizable `session*.jsonl*` log inside is never deleted.
- Session ids are validated as UUIDs and used only to *find* a directory under the configured root; no id content is ever used as a path prefix.
- Deletion is permanent. There is no undo beyond your own backups.

## Limitations

- The sidebar list refreshes from Host workspace state; if a deleted row lingers, reload the page once.
- Deleting a message keeps its *user prompt* when you delete from an assistant reply onward (the prompt stays as the tail of the continuation); delete from the user message's next assistant attempt to remove both.
- "Delete from here" changes the session id (it is a fork of the prefix).

## License

[MIT](LICENSE)
