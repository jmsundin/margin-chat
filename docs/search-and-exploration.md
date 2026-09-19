# Search and exploration

Search opens a single **Search & explore** session. Query, temporary filters,
selected passage, pagination and navigation history survive closing it to read a
source. The Passages and Connections views share that state.

## Local retrieval

The search corpus includes titles and bounded passages from user/assistant
messages, primary standalone notes, private margin notes and side notes. System
messages and synthetic standalone-note context messages are omitted. Results keep
the canonical conversation, message or note ID plus the original Markdown quote
and character offsets. Multiple passages in one conversation can appear.

All matching passages contribute to filter counts before pagination. Filters use
OR within one dimension and AND across dimensions. A filter's count omits active
filters in its own dimension, so alternatives remain discoverable. These filters
never change saved group assignments.

- Topics include existing categories, local keyword matches, and section headings
  found in the content. Code-fence headings are excluded.
- Group and source-type filters use workspace metadata.
- Purpose filters use local text rules for decisions, evidence, alternatives and
  open questions; these are suggestions, not verified statements about a source.
- Use current chat adds a bounded vocabulary overlap boost while keeping the
  whole workspace searchable. Query terms still determine membership.

Exploration directions, with or without a query, are backed by nonempty result sets, with overlap
checks to avoid offering the same material three times. Connections follows
shared topics into those same passages. These associations do not establish that
sources agree or that one is a branch of another.

Markdown parsing is cached against conversation objects and source content;
changing a query or a filter does not reparse unchanged messages. The visible
result page contains 12 passages, with no 40-result corpus limit.

## Optional Jev assistance

Search reuses the account's existing Jev assistance setting and service status.
Immediate local results remain available while assistance runs or if unavailable.
Up to 20 eligible retrieved passages can be reranked, with up to 12 supported
filters judged as possible exploration directions. This is a shortlist for
judgment, not the workspace corpus. Counts and result membership stay local.

The client rebuilds excerpts from canonical primary sources and rejects stale
references. Private margin/side notes, system messages and synthetic note-context
messages never enter this assistance request. Every suggested filter must refer
to supplied eligible passages. Queries and optional current primary context are
included under the existing assistance preference.

Requests debounce, cancel when stale/closed, time out, and cache within the account.
Unknown or malformed model IDs and judgments are discarded. Unreviewed and private
results retain their positions. Jev reranks what retrieval found; this does not
provide embedding-based semantic retrieval or infer an unspoken user intent.

## Opening a source

Open source returns to the chat/note, opens an annotation editor when appropriate,
and reveals the matching passage. The reference is checked against current
content before applying any range. Edited quotes are recovered only when unique;
stale offsets never select unrelated text. Returning to search preserves the
exploration session.

Saved highlights also show a delayed hover preview of the linked side chat/note.
Keyboard focus opens the same preview. Text selection suppresses it, Escape
dismisses it, and overlapping annotations appear together. Content comes from the
latest local note or reply; hovering does not call an AI service.
