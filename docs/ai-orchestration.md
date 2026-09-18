# AI routing, context, and execution details

Open the AI controls below the message box to choose Auto's Balanced, Fast, or
Thorough preference. Choose whether AI can use only this conversation and its
branch, selected notes/conversations, or relevant material from the workspace.
Provider checkboxes apply to generation, title suggestions, and attachment
indexing/search. Excluding OpenAI still saves uploaded originals and explains
that attachment search is paused.

Each assistant response has expandable model details: the resolved model and
provider, selection reason and tradeoffs, task, time, supplied sources and short
excerpts, context omissions, fallback attempts, and completion status. Source
links reopen workspace notes and conversations. Details appear with the first
response text and update when the provider reports completion. They are retained
with the answer in local storage, cloud projection, Markdown, and ZIP exports;
conversation preferences travel with the conversation too.

Every reply has one execution plan. Manual selection keeps the selected provider
and model. Auto classifies the latest user message, selects an eligible route,
prepares the same permitted context for each provider, and records the result in
`metadata.execution`. The browser persists that receipt on the assistant message.

## Settings and provider eligibility

The request accepts `ai.mode` (`balanced`, `fast`, or `thorough`),
`ai.contextScope` (`conversation`, `selected`, or `workspace`),
`ai.selectedConversationIds`, and optional `ai.allowedProviders` (`openai`,
`gemini`, `huggingface`, `xai`). Old requests default to balanced mode and current
conversation scope. An omitted provider list permits all configured providers;
an explicit empty list permits none.

The server checks provider permissions before retrieval or generation. They also
apply to manual requests and automatic title generation. A manually selected,
excluded provider is rejected. Auto considers only permitted providers with
credentials. If any eligible personal keys exist, all attempts use that personal
key pool. Otherwise Auto can use configured hosted providers when the account
has hosted access. This keeps billing planning consistent with execution and
prevents an unreserved hosted fallback after a personal-key request.

Document search currently uses OpenAI embeddings. Excluding OpenAI therefore
skips document indexing and search, with a visible warning, even when the final
reply uses another provider. Conversation and permitted note context still work.

## Routing policy and its evidence

`server/chat/modelProfiles.mjs` contains versioned application preferences and
their documentation sources. `server/chat/routing.mjs` classifies prompts into
general, coding, reasoning, research, writing, or summary tasks using explicit
text rules. This is a deterministic heuristic, not an additional model call.

General requests use the configured provider priority. Coding and reasoning
prefer OpenAI, then Hugging Face; summaries and research prefer Gemini, then
OpenAI; writing prefers OpenAI, then Gemini. The remaining providers are fallback
candidates in the order recorded in the profiles. These are application policy
choices, not benchmark results or claims that one vendor is universally better.

Fast uses a configured fast variant from the existing supported catalog.
Balanced normally uses runtime defaults, with task variants for summaries and
Hugging Face coding/reasoning. Thorough uses the configured defaults or relevant
task variants, a larger context budget, and instructions to examine reasoning
and tradeoffs. These modes do not set a provider-specific reasoning-effort API
parameter. Exact model choices remain restricted to the application's supported
catalog; an unsupported runtime default falls back to the catalog default.

The receipt names the provider/model, task and mode, explains the matching policy
and mode tradeoff, and identifies the profile version. Auto also discloses that
there are no application benchmark scores. When the provider reports a resolved
model or snapshot name, that name becomes the receipt's model; otherwise the
requested model name is retained. A research classification does not enable live
web search: these routes use supplied context and document retrieval. OpenAI
Agent's tools inspect only permitted local workspace content.

To extend this policy, first add the exact supported model to the application
catalog and adapter support, then add a profile with a source and verification
date. Record hard capability constraints independently of comparative quality.
Future measured rankings should use representative, held-out application tasks,
human-calibrated scoring, completion/error rates, total execution cost, and
latency distributions. Key results by exact model/version, settings, adapter,
prompt and dataset versions. Compare routing policies against a single-model
baseline and rerun evaluations before changing a default or moving alias.
There is no automatic documentation refresh or benchmark runner in this change.

Reference guidance:

- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection)
- [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [Gemini model lifecycle](https://ai.google.dev/gemini-api/docs/models)
- [xAI model documentation](https://docs.x.ai/developers/models)

## Context and privacy boundaries

The client supplies its current local state, including unsaved content, in a
bounded `workspaceContext` snapshot. The server whitelists IDs, titles, update
timestamps, message role/content, and optional standalone note body. Private
margin comments, other annotations, and stored execution receipts are not
searchable context. A standalone note's primary body is eligible when selected.

Current conversation context always includes the current messages and supplied
ancestors. The client cuts anchored ancestors at the branching point; unanchored
child chats inherit ancestor history too. Conversation scope does not add other
workspace items. Selected scope adds only IDs explicitly selected. Workspace
scope adds eligible items from the bounded snapshot supplied by the client; it
does not imply that the entire vault was read or sent.

Every provider receives the same prepared context. OpenAI Agent can additionally
search, list, and read that prepared snapshot through local tools. Those tools
never load a larger database snapshot as a fallback. Missing or clipped context
is unavailable to the model. Tool lookup failures cannot widen permission scope.
Supplied workspace excerpts are identified as untrusted source data.

## Budgets and omissions

The server's application character budgets are 24,000 for fast, 48,000 for
balanced, and 96,000 for thorough. These are conservative application limits,
not advertised provider token-window sizes. Hosted requests additionally obey
`HOSTED_MAX_INPUT_CHARACTERS` (60,000 by default), taking the smaller limit. The
prepared instructions and message content are checked before a provider call.

Chat billing no longer rejects the unprepared local snapshot solely because it
exceeds the hosted context allowance. It passes the configured limit into context
preparation; ordinary title/billing callers retain their existing validation.
Hosted output still obeys `HOSTED_MAX_OUTPUT_TOKENS` (2,000 by default).

Preparation reserves room for framing, preserves the complete latest user
message, prioritizes recent current history and nearest ancestors, and allocates
remaining space to document excerpts and permitted workspace entries. An
individual additional workspace item is capped at 6,000 characters in fast or
balanced mode and 12,000 in thorough mode. JSON overhead is accounted for and a
final size check prevents sending an oversized prepared request. A latest user
message that cannot fit is rejected explicitly rather than silently shortened.

The client's `workspaceContextTruncated` flag, server omissions, and bounded tool
outputs set the receipt's truncation flag and warnings. Source excerpts are
capped at 240 characters. Tools have aggregate result budgets of 6,000/12,000/
24,000 characters for fast/balanced/thorough, with at most six agent rounds.
Each agent round also checks the accumulated input against the effective context
limit; excessive tool history stops with an explicit error.

## Fallbacks, cancellation, and receipts

Auto may try another eligible provider after a failure only before any response
text is exposed to the client. Manual selection never switches providers. Once
the client stream starts, or cancellation occurs, no fallback runs. Provider
transport, document retrieval, and embeddings receive the cancellation signal.

Receipts record schema version, resolved model/provider, mode, task, rationale,
profile version, context sources, omissions, failed attempts, warnings, status,
completion timestamp, and duration. Failed-attempt reasons identify the provider
and HTTP status when available without copying raw provider response bodies.
Receipts contain no credentials or hidden model reasoning. A listed source means
it was supplied as context; it does not prove that a generated claim is correct.
Transport EOF without an explicit completion event is treated as interruption.
Stopping or losing a stream preserves delivered text and marks its receipt as
partial. A page that closes before recording completion reopens with a partial
response label, rather than claiming a request is still running.

The targeted tests in `tests/ai-routing-context.test.ts` cover task/mode choice,
manual overrides, provider and embedding exclusions, personal-key billing
consistency, receipts, stream/cancellation fallbacks, shared context across
providers, ancestor inheritance, scoped Agent tools, private annotations, and
hosted context limits. Network responses are mocked; the tests do not establish
live model availability, comparative quality, cost or latency.
