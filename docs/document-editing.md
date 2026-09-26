# Write and ask AI in one document

Choose **New document** to start writing. Existing chats and notes open in the same editable document view. Click formatted text to edit it directly; changes save automatically.

LaTeX equations render directly in the editor. New equations default to inline layout, keeping them within the surrounding text. Use `$E = mc^2$` for inline math or explicitly choose `$$...$$` for a display equation on a separate line; `\(...\)` and `\[...\]` are also supported. The block formatting menu's **Math** button opens an equation editor with inline/display layout and a live preview. Click a rendered equation (or focus it and press Enter) to edit its LaTeX; existing equations retain their chosen layout. Save with the button or Cmd/Ctrl+Enter; Escape, Cancel, or clicking outside discards the draft. Equation changes support document undo and redo. Currency and code stay literal, and equations remain LaTeX in saved Markdown.

Press **Command+B** on Mac or **Ctrl+B** on Windows/Linux to open or close the left chat sidebar, including while editing a document. Use the block toolbar's **Bold** button to format text.

Switch between **Document**, **Tiles**, and **Map** from the mode menu to the right of **Margin Chat**. Its icon and label show the current mode, and the menu marks your selection. Narrow sidebars keep the mode icon visible; open the menu to see the selected mode's name.

Views open on first use and stay available during the session, so switching back reuses your editors and map instead of rebuilding them. Document scroll positions and the map's current zoom are preserved; reopened views show the latest workspace content.

Choose **Outline** in the sidebar, or use a document row's **Expand outline** button, to give the current document's outline the sidebar's available reading area. The outline follows the focused document and scrolls independently. **Documents** returns to your document list at its previous scroll position. Navigation, New document, Search, More, and the bottom utilities remain accessible in either view.

## Work across side documents

When a parent document is pinned, pause over the subtle handle along a child document's top edge to reveal tabs for that parent's direct children. Passing over the edge quickly does not open them. The tabs include minimized children and follow the saved document order; selecting one restores and focuses it while the parent stays pinned. Click the handle or focus it with the keyboard to open immediately. Arrow keys navigate the strip; Escape, clicking outside, or moving away dismisses it. The strip overlays the document without shifting its content.

Choose the **+** button (**New side document**) beside the active document tab, to create a child of the currently focused document. Clicking or editing a visible document focuses it, so a side document can have its own side documents. The Map view retains those parent/child nodes and edges.

Every document has its own sidebar entry. Opening a side document centers its pane and restores its ancestor documents for navigation. The tabs show the current document family; unrelated main documents have separate tab strips. Click a tab to focus its pane while the other documents stay open, and scroll horizontally with a trackpad, the scrollbar, or **Shift + mouse wheel**. Drag either edge of a document in the scrolling strip to change only its width; adjacent documents keep their widths. Each document remembers its width when you switch documents or reopen the workspace, and fits within the available screen space on smaller screens. Focus an edge and use **Left/Right**, **Home**, or **End** to resize with the keyboard. Double-click either edge to reset only that document's saved width. Press **Escape** to cancel a resize in progress.

Drag tabs to change the horizontal pane order, including moving a side document before its main document. **Alt + Left/Right** reorders a focused tab; **Left/Right**, **Home**, and **End** navigate tabs, and **Enter** selects one. Moving tabs preserves all parent relationships and Map positions. Choose **Minimize document** from a side document's **⋮** menu to hide its pane. Restore it by selecting its tab, choosing **Restore document** from its menu, or clicking the small document icons stacked along its parent document’s upper-right edge; hover an icon to see the document title. Use the sidebar document actions to delete a document. Tab order and minimized panes are saved with the document family.

The same **⋮** document menu is available on each tab and at the top-right of its document. The document title and menu remain visible while you scroll vertically. Open the **⋮ Document views** menu at the right of the tab bar to browse related notes and chats or show the branch navigation map.

## Keep documents pinned beside your work

Open the vertical **⋮** menu at the right of a document tab and choose **Pin document**. Pinned documents stay in a fixed area while the remaining documents scroll horizontally. The pinned area starts on the left. You can pin multiple documents and edit any of them. On narrow screens left and right placements stack above or below the scrolling documents.

Pinned tabs offer **Keep visible across documents**. Leave it on for a reference pane that stays visible when opening an unrelated document. Turn it off to show that pane only with its main document and side documents. Each pane remembers its own setting. This is independent of pinning documents in the sidebar.

When one pinned pane is visible, drag its header or grip toward the left, right, top, or bottom of the workspace to move it there. When multiple pinned panes are visible, drag a pane onto an edge of another pane to split the grid there. A highlighted region previews the placement. Click the grip for placement controls you can use with the keyboard. Drag dividers to resize panes or the whole pinned area; focused dividers also accept arrow keys, **Home**, and **End**. Press **Escape** to cancel a drag. Use **Unpin** in the pane header or tab menu to return a document to the scrolling area. The workspace position, grid, sizes, and visibility settings are saved and restored when you reopen the workspace.

## Write and arrange

Pause over a block to reveal its grip, then open its formatting controls or drag it to a new position. Keyboard focus reveals the grip immediately; touch screens keep it visible. Sidebar document rows use the same brief hover. Formatting controls include headings, lists, checklists, quotes, code, tables, links, and inline formatting. **Move block up/down** provides the same ordering controls without dragging.

Drag a block's grip into another open document, including a pinned document. The insertion line shows where it will land; drop in the blank writing area to append it. Press **Escape** to cancel a drag. You can also click the grip and choose a destination from **Move to document…**, including documents that are not currently open. The destination opens after the move. Moving removes the block from its source and saves it in the destination with its Markdown and AI prompt details intact. A block that is still being generated cannot be moved.

Existing margin notes and side-document links remain with their original document and retain their quoted source in history. Moving a block does not change document relationships. To reverse a move to another document, use its grip or destination picker again.

Start typing directly in the blank writing area, including at the end of an existing document. Empty areas show a writing/AI placeholder and create a saved block only when edited or explicitly used for AI. Press **Enter** in a paragraph or heading to continue writing. Lists, code, and tables retain their own editing behavior. Choose **Group** from the document menu to assign a group; the map reader's close button sits in its upper-right corner without a separate title bar.

Press **Command+Z** on Mac or **Ctrl+Z** on Windows/Linux to undo. Add **Shift** to redo. Each open document has its own editing history for text, Markdown source, formatting, splitting/deleting blocks, and reordering blocks within that document. Consecutive typing is grouped into one step; undo and redo restore the editing position. A new edit after undo clears redo. Title and AI prompt fields keep their normal text undo behavior. External content changes, such as AI output or a block moved between documents, start a new history so undo cannot overwrite that newer content.

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

`Conversation.document` stores stable Markdown blocks plus prompt and generation records. Original messages remain intact as history. A legacy conversation is projected into document blocks when opened; the first edit persists that document representation. Splitting and reordering blocks retain their IDs/provenance where applicable. Moving between documents creates fresh block and copied-history IDs in one workspace update; outgoing document links move with the text, and incoming block links follow the destination. Selection anchors use a block ID and raw Markdown character offsets, not rendered-text positions.

The Markdown vault names generated files after their titles, with a short stable suffix to distinguish documents with the same title. Application metadata, prompts, and generation history live in the YAML header's `margin-chat` registry. Current block and message text stays in the readable Markdown body, separated by short identity comments. Preserve the header and paired `margin-chat-block` / `margin-chat-msg` comments when editing exported files in another app. Existing files using the earlier marker format remain readable. Local saving, automatic merging, recovery copies, and exports follow the [Markdown vault](markdown-vault.md) workflow.

PostgreSQL deployments must apply migrations through `0009_document_dock.sql` with `bun run db:migrate` before starting the updated server. Migration 0007 adds document storage and block references; 0008 adds optional `document_layout` preferences; 0009 adds workspace-wide `document_dock` preferences with per-pane visibility scope. The root document stores the family's display order, minimized document IDs, and individual widths, separately from `parentId` and `childIds`. Widths use the existing layout storage without an additional migration. Existing content and workspaces without display preferences remain compatible.
