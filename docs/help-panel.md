# Help panel

Help is a panel of guides beside the workspace. It opens from **Help and guides** in the sidebar's ⋯ menu and with **F1**, which also closes it.

It is not a modal: the workspace stays usable so a reader can follow a guide's steps while it is open. On a phone it fills the screen.

## What it shows

- **Front page:** popular guides, then topics with a count of guides in each.
- **Topic:** the guides in one category.
- **Guide:** a summary, an optional button, Before you start, numbered Steps, Good to know, and Related guides.
- **Search:** filters all guides as you type. A word matches the start of a word in the guide; every word must match. Title matches rank above summary and keyword matches, which rank above matches in the steps.

Back and Forward move through the pages visited in the panel. Escape clears a search, then closes the panel, but only while focus is inside it and no dialog is open on top.

## Where things live

| File | Holds |
| --- | --- |
| `client/src/lib/helpGuides.ts` | Categories, guides, the popular list and `searchHelpGuides`. Plain data, no React. |
| `client/src/components/HelpPanel.tsx` | The panel. Loaded lazily from `WorkspaceApp.tsx` the first time Help opens. |
| `tests/help-guides.test.tsx` | Checks ids, links between guides, feature names against `FEATURES`, search ranking and the rendered panel. |

## Writing a guide

Add an entry to `HELP_GUIDES`. One guide covers one task.

- Use the words the interface uses, and mark button and menu names with `**bold**`. When a label changes in the app, change it in the guide in the same commit.
- `before` lists what must be true first. A feature that must be switched on is written as `**Name** is turned on in Features.`, with the name exactly as in `client/src/lib/features.ts`; the test enforces this.
- `keywords` holds words people search with that the title and summary lack.
- `action` adds a button that does the first step for the reader: open a settings section, start the tour, open search, or open the chat-history import. The workspace hides a button it can't run, such as the tour inside the extension or billing for a guest.

## Not built yet

- Asking AI a question about the guides.
- Screenshots inside steps.
- Links from other parts of the app straight to a guide. `HelpPanel` already accepts `initialGuideId` for this.
