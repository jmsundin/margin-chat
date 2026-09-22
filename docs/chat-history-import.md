# Bring your chat history

Open **More → Bring your chat history** in the workspace sidebar. A new, empty workspace also shows a welcome button.

1. In ChatGPT, use **Settings → Data controls → Export data** and download the export when it is ready. See the [official export instructions](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data).
2. Choose or drop the ZIP into Margin Chat. You can also choose `conversations.json` or several numbered conversation JSON files from the export.
3. Preview messages, search conversation titles, and select the chats to import. **Select matching chats** replaces the selection with the current search results.
4. Import, then open a chat to continue with your selected Margin Chat model. Import itself does not call an AI model or incur model charges.

Preview is processed in the browser. Selected conversations become ordinary Markdown vault chats, saved locally and synchronized according to the account's existing settings. Import preserves current workspace preferences and existing conversations. Existing vault backup and connected-folder behavior applies.

## What transfers

- Conversation titles, ordered user and assistant messages, available timestamps, Markdown, code, and Unicode text.
- Alternate reply paths as separate chats, including the preceding conversation. They are not converted into Margin Chat's anchored branches.
- Readable text parts and available audio transcriptions. Unsupported media parts receive placeholders and warnings.

Attachments, generated images, audio files, tool results, hidden/internal messages, memories, custom instructions, project settings, subscriptions, and API credentials do not transfer. Reattach any files needed for a future reply. Original ChatGPT execution/billing records are not recreated; continuing uses Margin Chat's current model and billing settings. Claude exports are not supported by this first version.

## Repeat imports and undo

Source conversation IDs receive stable, namespaced hashes. A chat already present is skipped even after editing or renaming it. Repeat imports do not merge newer ChatGPT messages into an existing imported chat. Alternate paths use independent stable IDs.

**Undo this import** is available on the completion screen until the dialog closes. It only removes unchanged chats created by that import. Edited, renamed, pinned, grouped, and referenced chats are kept, including references added from a different chat. Closing the window discards the undo receipt; ordinary workspace deletion remains available.

## Limits and compatibility

The first version accepts up to 100 MB of selected files and 20 MB of expanded conversation JSON, with at most 5,000 source conversations and resulting reply paths. Individual generated Markdown chats must fit the vault's 2 MB file limit. Traversal is bounded for deeply nested or heavily branched exports. For large archives, extract and select fewer numbered conversation JSON files. ZIP entries other than conversation JSON are ignored.

ChatGPT does not promise a stable export schema. This parser supports the conversation array with `mapping`, parent-linked messages, and `current_node`. Missing identities and broken reply paths are reported and skipped; unrecognized files are rejected without writing chats. Tests use synthetic examples; no private user export is included in the repository.

## Verification

`bun --no-env-file test tests/chat-history-import.test.ts tests/use-markdown-vault.integration.test.ts` checks parsing, archive boundaries, duplicate prevention, undo safety, concurrent writing, cloud synchronization against a temporary file-backed service, and offline reopening.

`bun --no-env-file tests/helpers/serveChatHistoryPreview.ts` serves a loopback-only visual fixture at `http://127.0.0.1:5181/`. Its sample button runs the real parser and dialog with synthetic data; save/undo callbacks are simulated and do not touch an account or vault.
