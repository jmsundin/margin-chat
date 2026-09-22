# Write and ask AI in one document

Choose **New document** to start writing. Existing chats and notes open in the same editable document view. Click formatted text to edit it directly; changes save automatically.

## Write and arrange

Pause over a block to reveal its grip, then open its formatting controls or drag it to a new position. Keyboard focus reveals the grip immediately; touch screens keep it visible. Sidebar document rows use the same brief hover. Formatting controls include headings, lists, checklists, quotes, code, tables, links, and inline formatting. **Move block up/down** provides the same ordering controls without dragging.

Start typing directly in the blank writing area, including at the end of an existing document. Empty areas show a writing/AI placeholder and create a saved block only when edited or explicitly used for AI. Press **Enter** in a paragraph or heading to continue writing. Lists, code, and tables retain their own editing behavior. Text undo/redo works within the block being edited. The document header keeps a compact group picker; the map reader's close button sits in its upper-right corner without a separate title bar.

## Ask AI where you are writing

| Action | Shortcut or control |
| --- | --- |
| Open an AI prompt in an empty block | Press **Space** |
| Open an AI prompt within text | Press **Space twice** after text |
| Ask about a passage | Select text, then choose **Ask AI** |
| Send the AI prompt | **Enter** or **Generate** |
| Add a line to the AI prompt | **Shift+Enter** |
| Close the prompt and resume writing | **Escape** |

Slash (`/`) remains ordinary text. Space shortcuts leave code spacing alone. Closing a prompt restores the spaces used to open it.

Choose **In this document** to insert the response where you invoked AI, or **Side document** to open it beside the source. With selected text, **Replace selection** is an explicit option; otherwise the passage stays in place. The prompt uses the current document and any selected passage. Choose the model, adjust context settings, or attach files from the prompt controls.

You can keep editing other blocks while a response arrives. **Stop** keeps the text received so far.

## Prompts and versions

Submitted prompts stay collapsed behind the small prompt icon beside their response. Open it to read or edit the saved prompt and choose **Try another version**. The current writing stays visible while the alternative is generated.

Choose **Use this version** to replace the visible response, or **Keep current** to leave it unchanged. **Undo insertion** removes that response's inserted blocks; undoing an accepted alternative restores the previous version. Other document blocks remain in place. Original prompts and generated replies remain in history.

Private margin notes use the same formatted editor. **Insert into document** explicitly copies a private note into the document, where a later AI request can use it as context.

## Advanced Markdown

Diagrams, wiki links, callouts, hidden comments, images, reference links, and embedded markup retain their existing rendering and Markdown source. When a construct needs source editing, its block offers **Edit … source**. Ordinary blocks also offer **Edit Markdown** in their controls. Choose **Done** to return to the formatted view. This preserves syntax that the rich editor cannot safely rewrite.

## Storage and migration — engineering note

`Conversation.document` stores stable Markdown blocks plus prompt and generation records. Original messages remain intact as history. A legacy conversation is projected into document blocks when opened; the first edit persists that document representation. Splitting and moving blocks retain their IDs/provenance where applicable. Selection anchors use a block ID and raw Markdown character offsets, not rendered-text positions.

The Markdown vault stores editable block content in its marked document section and retains prompts, generations, original messages, and attachment references through the shared workspace codec. Preserve the `margin-chat` markers when editing exported files. Local saving, synchronization, conflicts, and exports follow the [Markdown vault](markdown-vault.md) workflow; this interface does not create a second content store.

PostgreSQL deployments must apply `0007_editable_documents.sql` with `bun run db:migrate` before starting the updated server. It adds document storage and block references while preserving the existing message history.
