# Write and ask AI in one document

Choose **New document** to start writing. Existing chats and notes open in the same editable document view. Click formatted text to edit it directly; changes save automatically.

LaTeX equations render directly in the editor. New equations default to inline layout, keeping them within the surrounding text. Use `$E = mc^2$` for inline math or explicitly choose `$$...$$` for a display equation on a separate line; `\(...\)` and `\[...\]` are also supported. The block formatting menu's **Math** button opens an equation editor with inline/display layout and a live preview. Click a rendered equation (or focus it and press Enter) to edit its LaTeX; existing equations retain their chosen layout. Save with the button or Cmd/Ctrl+Enter; Escape, Cancel, or clicking outside discards the draft. Equation changes support document undo and redo. Currency and code stay literal, and equations remain LaTeX in saved Markdown.

Press **Command+B** on Mac or **Ctrl+B** on Windows/Linux to open or close the left chat sidebar, including while editing a document. Use the block toolbar's **Bold** button to format text.

Switch between **Document**, **Tiles**, and **Map** from the mode menu to the right of **Margin Chat**. Its icon and label show the current mode, and the menu marks your selection. Narrow sidebars keep the mode icon visible; open the menu to see the selected mode's name.

Views open on first use and stay available during the session, so switching back reuses your editors and map instead of rebuilding them. Document scroll positions and the map's current zoom are preserved; reopened views show the latest workspace content.

The sidebar’s **Documents** view lists all documents by creation time, newest first, including pinned and grouped documents. Editing a document does not change that order. Choose **Groups** for the grouped list, pinned section, and drag-and-drop organization. Each list remembers its scroll position.

Choose **Outline** in the sidebar, or use a document row's **Expand outline** button, to give the current document's outline the sidebar's available reading area. The outline follows the focused document and scrolls independently. **Documents** returns to your document list at its previous scroll position. Navigation, New document, Search, More, and the bottom utilities remain accessible in either view.

## Work across side documents

Documents with children show a count and chevron in their fixed header, whether pinned or unpinned. Click it, pause over it, or press Down Arrow while it has keyboard focus to open a vertical list labeled **Children**. This includes both direct branches and documents referenced by document-link records, including links to individual blocks. Multiple links to the same document count once; a document linked to itself is not its own child. Each entry includes a title, short content preview, and Open, Minimized, or Not open status. Direct branches follow saved document order, with additional linked children following in link order, and selecting a child restores and focuses its existing pane while keeping the parent open. Child headers include a **← Parent title** link, even when there is no quoted source passage. A pinned parent's children remain accessible when another document family is open. Up/Down arrows navigate the list; Escape and outside clicks dismiss it. Scrolling stays inside the dropdown, including at its edges. Documents without children hide this control. These controls describe parent–child relationships independently of the documents' side-by-side positions.

Choose the **+** button (**New side document**) beside the active document tab, to create a side document from the currently focused document. Clicking or editing a visible document focuses it, so a side document can have its own side documents. The breadcrumb treats side documents as peers of the document they came from, while branch chats and margin notes are its children. The Map view retains the parent/child nodes and edges.

Every document has its own sidebar entry. Opening a side document centers its pane and restores its ancestor documents for navigation. The tabs show the current document family; unrelated main documents have separate tab strips. Click a tab to focus its pane while the other documents stay open; a minimized tab restores only its own document, not ancestors you closed. Scroll horizontally with a trackpad, the scrollbar, or **Shift + mouse wheel**. Drag either edge of a document in the scrolling strip to change only its width; adjacent documents keep their widths. Each document remembers its width when you switch documents or reopen the workspace, and fits within the available screen space on smaller screens. Focus an edge and use **Left/Right**, **Home**, or **End** to resize with the keyboard. Double-click either edge to reset only that document's saved width. Press **Escape** to cancel a resize in progress.

Drag tabs to change the horizontal pane order, including moving a side document before its main document. **Alt + Left/Right** reorders a focused tab; **Left/Right**, **Home**, and **End** navigate tabs, and **Enter** selects one. Moving tabs preserves all parent relationships and Map positions. Use the **−** button at the far left of a document header, or choose **Minimize document** from its **⋮** menu, to hide its pane while keeping its tab. Restore it by selecting its tab, choosing **Restore document** from its menu, or clicking the small document icons stacked along its parent document’s upper-right edge; hover an icon to see the document title. Use the sidebar document actions to delete a document. Use the **×** button at the far right of the header or **Close document** in the tab menu to hide both pane and tab. Closing preserves the document, its children, links, and content; reopen it from the sidebar, search, or Children list. Tab order, closed documents, and minimized panes are saved with the document family. Ordinary tabs shrink as more documents open; a slim scrollbar appears when the strip still overflows.

Document titles appear in tabs and pinned pane headers, without a repeated title section in the body. The **⋮** menu, **Children**, and **Notes** controls sit in the fixed document header, including for margin notes. Pinned documents use their existing pane header, with a compact child count and chevron alongside the other controls. The dropdown identifies the list as Children. Choose **Rename document** from the **⋮** menu to change the title. The menu is also available on each tab. Pinned tabs use compact document icons; hover or focus one to preview its full title, current content, and pin scope. Right-click a pinned icon or press **Shift + F10** for document actions. Open the **⋮ Document views** menu at the right of the tab bar to browse related notes and chats or show the branch navigation map. This menu also offers **Minimize all documents** (keep tabs) and **Close all documents** (hide tabs and panes) for the current workspace, including its pinned documents and margin notes. Documents remain saved and can be reopened.

### Move between documents with the breadcrumb

The bar under the tabs shows where the focused document sits in its family and follows your focus: click a tab or anywhere in a document and it switches to that document's path. The first level lists the main document and its side documents; each further level lists the branch chats, margin notes, and side documents under the level before it. The dashed crumb at the end counts the focused document's children. Pause over a crumb or click it to list that level's documents; hover a title for its kind, source passage, preview, number of children, and last edit. **Here** marks the focused document, **Open** documents already on screen, and **Minimized** documents that keep a minimized tab; a pulsing dot means AI is writing.

Click a title or **Expand here** to put that document in the focused document's place, like opening a page in a browser tab: the replaced document closes, and **Back** at the left of the bar brings it back to the same place. A document that is already on screen, or a margin note, just receives focus. **Open beside** opens the document right after the focused one and keeps focus where it is, so you can keep reading while it opens. Back history belongs to each tab and lasts until you reload. Press **Down Arrow** on a crumb to move into its list, **Up/Down** between documents, **Left/Right** between a row's actions, and **Escape** to close it.

## Keep documents pinned beside your work

Open the vertical **⋮** menu at the right of a document tab and choose **Pin document**. Pinned documents stay in a fixed area while the remaining documents scroll horizontally. The pinned area starts on the left. You can pin multiple documents and edit any of them. On narrow screens left and right placements stack above or below the scrolling documents.

Pinned tabs offer **Keep visible across documents**. Leave it on for a reference pane that stays visible when opening an unrelated document. Turn it off to show that pane only with its main document and side documents. Each pane remembers its own setting. This is independent of pinning documents in the sidebar.

When one pinned pane is visible, drag its header or grip toward the left, right, top, or bottom of the workspace to move it there. When multiple pinned panes are visible, drag a pane onto an edge of another pane to split the grid there. A highlighted region previews the placement. Click the grip for placement controls you can use with the keyboard. Drag vertical dividers through neighboring content to expand a pinned document: the other documents collapse to stacked headers, including across nested splits. Headers remain visible and their editors keep their content and reading positions. Drag back to reveal the content again. Drag dividers to resize panes or the whole pinned area; focused dividers also accept arrow keys, **Home**, and **End**. Press **Escape** to cancel a drag. Use **Unpin** in the pane header or tab menu to return a document to the scrolling area. The workspace position, grid, sizes, and visibility settings are saved and restored when you reopen the workspace.

## Write and arrange

Pause over a block to reveal its grip, then open its formatting controls or drag it to a new position. Keyboard focus reveals the grip immediately; touch screens keep it visible. Sidebar document rows use the same brief hover. Formatting controls include headings, lists, checklists, quotes, code, tables, links, and inline formatting. **Move block up/down** provides the same ordering controls without dragging.

Drag a block's grip into another open document, including a pinned document. The insertion line shows where it will land; drop in the blank writing area to append it. Press **Escape** to cancel a drag. You can also click the grip and choose a destination from **Move to document…**, including documents that are not currently open. The destination opens after the move. Moving removes the block from its source and saves it in the destination with its Markdown and AI prompt details intact. A block that is still being generated cannot be moved.

Existing margin notes and side-document links remain with their original document and retain their quoted source in history. Moving a block does not change document relationships. To reverse a move to another document, use its grip or destination picker again.

Start typing directly in the blank writing area, including at the end of an existing document. Empty areas show a writing/AI placeholder and create a saved block only when edited or explicitly used for AI. Press **Enter** in a paragraph or heading to continue writing. Lists, code, and tables retain their own editing behavior. Choose **Group** from the document menu to assign a group; the map reader's close button sits in its upper-right corner without a separate title bar.

Press **Shift+Enter** to start another paragraph within the same block. Each paragraph supports Markdown shortcuts such as `## ` for a heading or `- ` for a list. Plain Enter keeps the existing block-splitting behavior. Press **Command+D** on Mac or **Ctrl+D** on Windows/Linux to insert the current local date, time, UTC offset, and timezone at the cursor, including in Markdown source view.

In a live table, **Enter** or **Shift+Enter** adds a line within the current cell without leaving formatted editing. Hover or focus the table to reveal **+** controls below the last row and beside the last column; they append a row or column. Tab continues to navigate cells.

Choose **Drawing** in a block's formatting controls to create an Excalidraw drawing. Draw or import an existing scene, then choose **Save drawing** to embed it. **Edit drawing** reopens the scene; **Cancel** discards unsaved changes. Drawings and their image attachments stay in the document's Markdown as an `excalidraw` code fence and survive vault export and import.

Document margins shrink as the pane narrows. Resizing remains available while AI writes, and incoming text preserves the unchanged editor content instead of rebuilding the entire block. Two-finger scrolling over a scrollable code block or table stays within that surface, including at its edges.

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

Choose **In this document** to insert the response where you invoked AI, or **Side document** to open it beside the source. Prompts opened from selected text default to **Side document**. With selected text, **Replace selection** is an explicit option; otherwise the passage stays in place. The prompt uses the current document and any selected passage. Choose the model, adjust context settings, or attach files from the prompt controls.

You can keep editing other blocks while a response arrives. **Stop** keeps the text received so far.

## Prompts and versions

Submitted prompts stay collapsed behind the small prompt icon beside their response. Open it to read or edit the saved prompt and choose **Try another version**. The current writing stays visible while the alternative is generated.

Choose **Use this version** to replace the visible response, or **Keep current** to leave it unchanged. **Undo insertion** removes that response's inserted blocks; undoing an accepted alternative restores the previous version. Other document blocks remain in place. Original prompts and generated replies remain in history.

Margin notes are regular child documents with `document.marginNote.display` set to `compact`. They use the complete document editor, including formatting, tables, drawings, attachments, AI prompts, history, and child documents. Choose **New margin note** in a document's menu for a general note, or create one from a selected passage. Notes appear beside their parent and participate in search, the sidebar, and the graph. Margin notes show their content without a repeated title or passage section. Use the arrow in the top-right toolbar to expand a note to a full-size document or return it to the margin. Drag the bottom-right corner to resize a compact note, or focus it and use the arrow keys. Its width and height are saved independently of the full-size view. Documents with no children omit the Children menu. Closing a notes column hides it without deleting documents; selecting a note restores its ancestor columns.

Opening a legacy workspace converts comment and side-chat notes into child documents. Migration retains exact text, creation/update times, and original passage metadata; valid passages also become ordinary document anchors. Standalone note documents are unchanged. Converted notes use ordinary document context controls for AI, and are no longer a separate annotation type excluded from document context.

## Advanced Markdown

Diagrams, wiki links, callouts, hidden comments, images, reference links, and embedded markup retain their existing rendering and Markdown source. When a construct needs source editing, its block offers **Edit … source**. Ordinary blocks also offer **Edit Markdown** in their controls. Choose **Done** to return to the formatted view. This preserves syntax that the rich editor cannot safely rewrite.

## Storage and migration — engineering note

`Conversation.document` stores stable Markdown blocks plus prompt and generation records. Original messages remain intact as history. A legacy conversation is projected into document blocks when opened; the first edit persists that document representation. Splitting and reordering blocks retain their IDs/provenance where applicable. Moving between documents creates fresh block and copied-history IDs in one workspace update; outgoing document links move with the text, and incoming block links follow the destination. Selection anchors use a block ID and raw Markdown character offsets, not rendered-text positions.

The Markdown vault stores all generated documents directly in the vault root, named after their titles with a short stable suffix. AI output and your writing share the same file. Application metadata and original prompt/message history live in the YAML header. The current body uses `<ai id="…">` and `<user id="…">` wrappers; `<ai id="…" edited-by="user">` records AI-origin text that you have edited. Click a block’s move handle to see **AI**, **You**, or **AI · edited by you** in the block popup’s authorship footer. These labels describe block origin, not exact word-level authorship. Preserve wrapper IDs when using another Markdown editor. Earlier formats remain readable. Local saving, automatic merging, hidden background history, and exports follow the [Markdown vault](markdown-vault.md) workflow.

PostgreSQL deployments must apply migrations through `0009_document_dock.sql` with `bun run db:migrate` before starting the updated server. Migration 0007 adds document storage and block references; 0008 adds optional `document_layout` preferences; 0009 adds workspace-wide `document_dock` preferences with per-pane visibility scope. The root document stores the family's display order, minimized document IDs, and individual widths, separately from `parentId` and `childIds`. Widths use the existing layout storage without an additional migration. Existing content and workspaces without display preferences remain compatible.
