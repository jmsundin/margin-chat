# Jev assistance

Margin Chat uses TypeSafe's Jev model for three optional features:

- Rank permitted notes and chats for manually selected models before the reply's context budget is applied.
- Categorize workspace chats and notes, and organize ungrouped items into existing
  groups or category groups.
- Suggest related notes and chats for the current context.

## Enable it

Set `TYPESAFE_AI_JEV_API_KEY` in the server environment (`.env` for local development)
and restart the server. The key stays on the server; never put it in a `VITE_`
variable. **Jev assistance** in **App settings** is enabled by default when an
account has no saved preference on that device. An explicit saved `false` remains
off. The preference is separate for each account on each device and separate from
the reply-provider allowlist. Turning it off stops new Jev analysis and cancels
workspace analysis in progress; groups already saved remain in place.

No dependency installation is required. The server uses the documented HTTP API:
`POST https://api.typesafe.ai/v1/systemone` with a bearer key and `{model, state,
questions}`. Independent typed questions are batched together. The default model
is pinned to `jev-1.13.0` so a moving alias does not silently change judgments.

| Server setting | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_AI_JEV_API_KEY` | unset | Server credential; `TYPESAFE_API_KEY` is a fallback alias |
| `TYPESAFE_ENABLED` | true | Set false to disable assistance globally |
| `TYPESAFE_MODEL` | jev-1.13.0 | Model version |
| `TYPESAFE_TIMEOUT_MS` | 2500 | Deadline for each evaluation, including queue time; 100–10000 ms |
| `TYPESAFE_REQUESTS_PER_MINUTE` | 20 | Per-account request limit per server instance |
| `TYPESAFE_INSTANCE_REQUESTS_PER_MINUTE` | 120 | Combined request limit per server instance |
| `TYPESAFE_INPUT_USD_PER_MILLION` | 0.042 | Rate used for estimated cost logs |

## Chat context and routing

Jev reranks permitted workspace excerpts for replies with a manually selected model when assistance is enabled. It does not change that model. Source scope, personal margin-note exclusions, and context budgets remain enforced.

Auto replies use GPT-6 Astra with low reasoning, independently of Jev assistance. That single pass classifies the task, chooses an eligible model, and orders permitted workspace excerpts. See [the model catalog](model-catalog.md) for routing credentials, billing, and fallback behavior.

Each reply retains its model and expandable **Why this model?** details. New Auto receipts use `astra` or `astra-task`; standard fallback uses `rules`, and exact manual choices use `manual`. `astra-task` means Astra classified the task and application rules selected the model. Historical `jev` and `jev-task` receipts retain their original labels and explanations. Streaming, persistence, and exports preserve these records.

## Workspace organization and related material

With the switch enabled, the client sends bounded excerpts of standalone note
bodies and user/assistant chat messages, plus existing group names and sample
member titles. This permission covers organization and discovery across the
local workspace, including unsynced content; it does not widen the separate
context scope of a generated reply. Private margin and side notes, attachments,
system messages, and saved execution receipts are excluded.

Each snapshot includes the current item and up to 39 others, prioritizing
ungrouped items with content before recently updated items. Chat excerpts use
the last eight nonempty user/assistant messages. Item titles are capped at 200
characters and item excerpts at 1,600 characters, with a shared 16,000-character
allowance. The current-context excerpt is separately capped at 1,600 characters
by the client. Up to 20 existing groups are considered, sorted by ID, with names
capped at 80 characters and at most two member titles of 80 characters each.
Groups outside that bound cannot receive a semantic match in that snapshot.
The server packs only missing judgments into size-aware batches, checking state,
state plus the longest question, and total request size separately. Conservative
UTF-8 limits are 28,000, 30,000, and 60,000 bytes respectively, with at most 128
questions. These are safety budgets, not token estimates. At most two workspace
batches are submitted concurrently to the shared bounded scheduler; waiting chat
work takes priority. Oversized or failed judgments retain safe fallback behavior.
As items are organized, later snapshots prioritize the remaining ungrouped content.

Independent Choice questions classify each item using the existing category IDs
and match it to an existing group, with an explicit no-match option. An existing
group match requires confidence of at least 0.75 and takes priority over the
category fallback. When no existing group qualifies, a category judgment with
confidence of at least 0.55 creates or reuses a group with that category's label.
Names are matched without case differences; new category groups use deterministic
IDs without overwriting an unrelated group. Empty items and items with only
private annotations are never automatically grouped. Related suggestions use a
separate relevance Score and exclude the current item; at most five are shown.

Automatic grouping only applies to currently ungrouped items without a manual
placement marker. It never changes an existing assignment. Choosing a group,
creating and assigning a group, or explicitly choosing **Ungrouped** records a
manual choice for that conversation and its existing descendant branches, so
Jev respects the decision after reload and synchronization. The group picker
shows a **Suggested by Jev** choice for an existing match or category label,
alongside search, group creation, and Ungrouped. Accepting a suggestion in the
picker is a manual choice.

Group membership is saved in workspace metadata. Each conversation's optional
`grouping: "manual" | "automatic"` marker survives workspace normalization,
Markdown metadata, and cloud round trips. SQL storage uses `grouping_mode` on
`marginchat_conversations`; apply `0004_conversation_grouping.sql` through the
normal migration process before running this version against an existing SQL
database. Older records without a marker remain eligible only when ungrouped.

The client debounces changes for 1.2 seconds, pauses analysis during active
streams, and rejects stale results after navigation, analyzed-content edits,
group-context changes, account changes, or opting out. Automatic assignments
wait for a ready result for the current snapshot and recheck current assignments
and manual choices before saving. Item category judgments can be reused while
their analyzed content remains unchanged. Category freshness is tracked per item,
including a valid uncertain judgment, so one changed item does not reclassify all
others. Group judgments additionally depend on group definitions; relatedness
depends on the active item's content. Server cache keys include the account,
model, prompt version, and these inputs. Client requests identify missing category
IDs explicitly. Partial failures remain retryable while successful judgments are
reused. Growing a workspace can shorten its analyzed excerpts under the shared
allowance; those genuinely changed inputs correctly invalidate their judgments.
Local category heuristics remain the
display fallback when Jev has no trusted judgment; they do not trigger automatic
grouping. Suggestions do not automatically move graph nodes, change branch
parents, or modify authored content. The user can open a related item or
explicitly arrange the graph by topic.

## Failures, cost, and evaluation

Missing keys, timeouts, vendor errors, rate limits, invalid answers, and low
confidence preserve standard app behavior. User cancellation is propagated.
Workspace assistance is available to authenticated accounts and requires an
explicit enabled flag, same-origin JSON requests, and account consistency.

**Jev is an operator-funded expense in this integration.** It is not charged to
users' prepaid reply balances or personal provider keys. Successful vendor calls
emit one `jev_usage` event per dispatched response, with operation, model,
reported input/output tokens, estimated USD cost when input usage is known, and
elapsed milliseconds. Cache hits and subscribers sharing an in-flight request do
not emit another billed usage event. Missing usage fields are omitted and
`missingUsageCount` identifies incomplete accounting; they do not mean zero cost.
The configured estimate is $0.042 per million input tokens, with free output
tokens, matching [TypeSafe's published model price](https://docs.typesafe.ai/models)
on 2026-09-19. Update the rate when commercial terms change. These estimates are
not an invoice or a hard spend cap.

The same sanitized diagnostic sink emits `jev_evaluation` events with
`stage: "dispatch"` or `stage: "judgment"`. Statuses distinguish queued work,
cache hits, shared requests, successful or partial results, timeouts,
cancellation, invalid responses, upstream errors, rate limits, and oversized
inputs. Numeric fields record question counts, accepted/rejected judgments,
payload sizes, queue wait, and elapsed time. Cache reuse is identified by
`cache_hit`/`shared` statuses. `jev_workspace` records batch, question, cached,
requested, accepted, and rejected judgment counts. Workspace acceptance means
a valid, cacheable answer, including uncertainty or no match; chat judgment
acceptance applies its confidence thresholds. Neither count measures accuracy.
These events
serve different purposes: do not add every event together as a request or a
charge. Diagnostic events contain no prompt text, note content, account IDs,
group names, credentials, or raw provider errors.

Account-scoped content-digest caches retain only judgments for five minutes, with
at most 128 completed server request results and 2,048 individual workspace
judgments. Whole-request caching excludes incomplete or invalid responses;
individually valid workspace judgments can still be reused. A judgment key
includes the evidence it actually depends on: changed group context invalidates
group matches, and changed current material invalidates relatedness judgments.
No prompt text is retained in completed cache entries. Pending requests retain
their bounded input only until completion or cancellation.

Identical in-flight requests for the same account share one dispatch. Each
subscriber can cancel independently; the vendor request is cancelled when no
subscribers remain. The server permits two active dispatches per account and
twelve per instance, with a bounded queue of eight per account and 128 per
instance. The request deadline includes time spent waiting in that queue;
subscribers joining an existing request share its original deadline.
Browser caches remain account-scoped and bounded to 32 workspace results with
their category snapshots, plus 1,000 current item category judgments. Restoring
a snapshot preserves its original judgment timestamps; expired or missing
category coverage is refreshed. Rate limits, queues, and server caches are
in-process, so limits multiply across serverless instances and reset on restart.
Use provider/account spend limits or a shared rate limiter for a global budget.

Confidence thresholds are initial heuristics, not accuracy guarantees: 0.75 for
existing-group matches, 0.55 for categories/task/model choices, 0.35 for relevance
scores, and a relatedness score of at least 1.5/3 before showing a related item.
Validate on representative workspace questions and adjust based on
relevant-source inclusion, group and category corrections, useful related links,
reply quality, latency, and total cost.

The automated tests mock the vendor boundary; they verify permissions, model
eligibility, snapshots, cancellation, caching, fallback, group matching, manual
placement preservation, persistence, and integration. Run the measurement
harness without arguments to inspect a plan without any network request or key:

```bash
bun --no-env-file scripts/evaluate-jev.mjs
```

Only an explicit `--live` enables billable TypeSafe requests using the configured
server credential:

```bash
bun --no-env-file scripts/evaluate-jev.mjs --live --repeats 5 --concurrency 3
```

The versioned synthetic suite pins `jev-1.13.0` and captures the real application
question builders with a mock transport. It includes all six chat intents, an
additional time-sensitive research request, relevant and unrelated context,
workspace categories and relatedness, and existing-group matches with explicit
no-match examples. A checked-in suite fingerprint pins the captured model, state,
and questions. Dry runs show drift; live runs refuse changed prompts until the
fixtures are reviewed and their version and fingerprint are updated. Each
measurement replays the same captured state and question
definitions; it never reads user workspace content or invokes a reply model.

For each scenario and repeat, the harness compares application-shaped batches,
sequential single-question requests, and bounded-concurrent single-question
requests. Strategy order rotates between repeats. It bypasses application
caches, dispatches fresh requests for every repeat, and does not retry failures;
vendor-side caching is outside its control. The dry plan reports the exact
number of billable requests the selected repeat count would send.

JSON results include per-strategy and per-scenario end-to-end p50/p95 latency,
successful-workflow latency separately, known input/output tokens, estimated cost,
missing-usage counts, and distinct failure statuses. Latency covers the synthetic
workflow's scheduling, network, and response parsing, not the full UI or reply
pipeline. Choice labels, full probability distributions, Score values, Noul
probabilities, and confidence are compared across strategies and repetitions.
Missing or invalid answers never count as agreement. Expected-outcome checks
report passed, failed, confidence-abstained, and unavailable results separately,
along with trusted coverage and the match rate among trusted answers. A route
check accepts the app's task-associated candidates or `keep_default`; it does
not assert which reply model is intrinsically best. Reports omit scenario text,
keys, and raw vendor error bodies.

`--timeout-ms` sets the measurement deadline for each dispatch (default 10,000
ms), independently of the app's production timeout; `--price-per-million`
updates the cost estimate without changing model selection. The command exits
nonzero when service failures or unsuccessful expected-outcome checks occur.
Five repeats and a small synthetic corpus cannot establish production accuracy
or reliable tail latency. No batching speed or cost advantage is assumed: use
the measured results, inspect failures, and evaluate a representative corpus
before tuning thresholds. Typed output guarantees structure, not truth.

References: [HTTP API](https://docs.typesafe.ai/api),
[models and pricing](https://docs.typesafe.ai/models),
[Score](https://docs.typesafe.ai/primitives/score),
[Choice](https://docs.typesafe.ai/primitives/choice),
[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[parallel-question measurement cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions).
