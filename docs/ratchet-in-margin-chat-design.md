# Ratchet in Margin Chat — Agent Design

**Status:** Design spec for implementation. Decisions by Jon, 2026-11-11.
**Scope:** The Margin Chat agent (in-app Agent mode and the MCP surface) gains the
Ratchet claim-verification system, and the agent's tools are reorganised into
tool sets: a default set that needs no configuration, plus tool sets the user
can add when they need them.

---

## 0. Principles (binding on every slice below)

1. **Retain, then extend.** Everything the agent can do today keeps working —
   same tool names, same semantics. Capabilities are added, never traded away.
   A refactor that breaks an existing tool is a failed refactor, even if the
   new structure is cleaner.
2. **Defaults do the choosing.** The user does not have to choose many things,
   but has the ability to choose many things. A new user configures nothing
   and gets the full default experience. Every choice in this design is
   organised so that ignoring all of them is a valid, complete way to use the
   product — and every choice is reachable when wanted.
3. **Cost-first.** BYOK where possible; every capability that costs money is
   incremental, capped, and receipted (extending the existing usage metering
   and execution receipts). Free tiers are the default path; paid paths are
   escalations.
4. **The user's lines are sacred.** Line authorship is an invariant, not a
   feature: no tool — existing, new, default, or user-added — may modify lines
   the user wrote. Agent writes go through the existing authorship-safe write
   path with its hash preconditions.
5. **Verdicts carry receipts.** A claim verdict must cite passages that
   resolve to real text (in the vault or in a fetched source). No citation,
   no verdict — the agent says "not enough evidence" instead.

## 1. What the agent can do today (the retained baseline)

Inventoried from the codebase at the time of writing (`server/chat/agent`,
`server/mcp`, `docs/mcp-server.md`, `docs/ai-orchestration.md`). This list is
the regression contract for §4's reorganisation.

**In-app Agent mode**
- Vault tools: search and read across documents, notes, chats, uploads and
  vault PDFs, with authorship filters (`mine`, `not-mine`, `ai`, `agent`,
  `import`) and per-line authorship/blame.
- Web: web search (provider built-in, capped) and web import into the vault.
- Proposals: the agent can propose edits/actions for the user to accept.
- Ask tool: the agent can ask the user a question mid-run.
- Adapters for X articles / tweet threads.
- Auto routing: Balanced / Fast / Thorough preferences, context scopes
  (conversation / selected / workspace), a model/provider picker, and a
  per-response execution receipt (model, sources, omissions, fallbacks).

**MCP server for outside agents** (`https://www.marginchat.com/api/mcp`,
tokens created in Profile → Agents, read or read+write scope chosen at
creation)
- Read: `search_vault`, `read_document`, `get_document_blame`,
  `list_related`, plus `search` / `fetch` in ChatGPT-connector shapes.
- Write (write-scope tokens): `create_document`, `append_to_document`,
  `update_document` (line-level patch operations with revision + SHA-256
  preconditions; refuses to touch the member's own lines; no delete, rename,
  or title/frontmatter changes).

**Substrate**
- Postgres + pgvector passage index for semantic vault search.
- Chrome extension capture, desktop vault sync, Markdown vault storage with
  typed relations and `[[wikilinks]]`.

## 2. Capability aspects — what the agent does for the user

The design organises the agent's abilities into aspects. Aspects are how the
product talks about the agent; tool sets (§4) are how it is built.

| Aspect | What it means for the user | Today | Added by this design |
| --- | --- | --- | --- |
| **Remember** | The vault is the user's second brain; the agent reads it with authorship and relations intact | Vault tools, passage index, MCP read | Claim index: checkable claims extracted from documents become first-class, searchable objects |
| **Verify** (Ratchet) | Claims in what the user saves and writes get checked, with receipts | — | The Ratchet loop (§3): extract → verify → verdict in the margin |
| **Research** | The agent can look beyond the vault | Web search, web import | Tiered scholarly research (§3.2) with cache-back into the vault |
| **Relate** | Connections and open loops surface without being asked | `list_related`, typed relations | Verdicts and contradictions join the relation graph (a claim can *contradict* a document) |
| **Write** | The agent drafts and appends, never over the user's lines | create / append / update (MCP), proposals (in-app) | Verify reports are written as margin annotations and linked verdict documents through the same safe write path |
| **Capture** | Everything the user feeds in lands in the vault | Extension, direct input, MCP creates | External papers fetched during verification are cached as vault documents automatically |
| **Connect** | The agent can use the user's other tools | MCP *server* (others connect to Margin Chat) | Margin Chat as MCP *client*: user-added tool sets (§4.3) |

## 3. The Ratchet verification loop

### 3.1 The loop

1. **Extract.** Checkable claims are extracted from a document (starting with
   science/research documents the user saves or generates) and stored as
   claim objects: the claim text, its passage anchor (block + line range +
   SHA, reusing the authorship machinery), and the document's own cited
   source if one exists.
2. **Verify, cheapest first** (§3.2). A claim is settled by the first tier
   that can settle it.
3. **Verdict.** One of: `supported`, `unsupported`, `contradicted`,
   `stale` (was supported; newer evidence supersedes), or
   `insufficient-evidence`. Every non-`insufficient` verdict carries at
   least one citation resolving to a real passage.
4. **Report in the margin.** Verdicts appear as annotations beside the
   original passage — not in a chat scroll — with the evidence one tap away.
   A per-document claims view lists all claims and verdicts.
5. **Cache back.** Every external source fetched becomes a vault document,
   linked to the claim and the checked document. The same claim never costs
   a second search.

### 3.2 Tiered external research (cheapest first)

There is no official Google Scholar API and no Google Cloud Scholar credit
program; automated Scholar access is blocked by Google. The tiers below
cover the same literature through free official APIs, with Scholar as a
capped, opt-in escalation (delivered as a tool set, §4.2).

| Tier | Source | Cost | Role |
| --- | --- | --- | --- |
| 0 | The vault | $0 | Settles claims the user's own corpus covers |
| 1 | Semantic Scholar API | Free (free key, ~1 req/s; batch endpoints) | Backbone: 200M+ papers, citation graph, abstracts, TLDRs |
| 1 | Europe PMC + PubMed | Free | Biomedical full-text search — the tier matched to regenerative-medicine claims |
| 1 | OpenAlex | Free, no key | Cross-disciplinary fallback sweep |
| 2 | Google Scholar via SerpApi | Paid per search; user-supplied key; hard monthly cap | Escalation only, when tiers 0–1 cannot settle a claim |

### 3.3 Evaluation gate

No slice of §3 ships on vibes. The MCR golden set (MCR-001…030) plus the
MC-EVAL cases are the acceptance tests: verdict accuracy and citation
grounding are measured per slice, and a slice that regresses the set does
not merge. Verdict thresholds (e.g. minimum citation-grounding rate) are
set in the slice PR, before the run, not after seeing results.

## 4. Tool sets — defaults that choose, choices that wait

### 4.1 The unit: a tool set

A **tool set** is a named bundle containing: its tools, the permissions
they run with, a cost class (`free`, `byok`, `metered`), and a monthly cap
where money is involved. Tool sets — not individual tools — are the unit
the user sees, adds, and removes. Individual tools are one level down, for
users who want them.

One rule decides what may enter the default set:

> A tool joins the default set automatically only if it is **free** (or
> covered by keys the user already supplied) **and** its effects stay
> inside the vault. Anything that **costs money per use** or **writes to a
> system outside Margin Chat** is opt-in, always — no defaults change
> that, ever.

### 4.2 The default tool set: "Core" (on, no setup)

Ships enabled for every account; zero configuration:

- Vault read (search, read, blame, relations) — as today.
- Vault write through the authorship-safe path (create, append, line
  patch, proposals in-app) — as today.
- Web search and web import — as today.
- Ratchet: claim extraction, vault-tier verification, margin verdicts.
- Scholarly research pack: Semantic Scholar, Europe PMC / PubMed,
  OpenAlex (all free tiers), with cache-back.
- Ask tool and execution receipts — as today.

### 4.3 Addable tool sets (examples; the catalog is data, not code)

Added by the user from a catalog, one toggle per set, sensible defaults
inside each set:

- **Scholar+ (SerpApi)** — the tier-2 Scholar escalation. BYOK, monthly
  search cap set by the user (default suggestion: the free tier's 250).
- **Code (GitHub)** — repo search, issues, PR review from inside Margin
  Chat.
- **User's other MCP servers** — any MCP server the user registers (URL +
  token) becomes a tool set. This is the general door: calendars, mail,
  other apps the user has connected elsewhere.
- Future sets (media generation, finance, …) follow the same shape.

### 4.4 The user's experience of choice

- **Settings shows tool sets, not tools.** One page: Core (on), installed
  sets, and the catalog. Most users never open it.
- **Tools are one level down.** Opening a set shows its tools with
  per-tool toggles — available, never required.
- **Adding a set is one decision.** The set's card states, in plain words:
  what it lets the agent do, what it costs, and where its writes land.
  Confirming is the whole setup; keys are pasted once, stored as token
  records like today's MCP tokens (hash stored, shown once).
- **Outside agents inherit the same model.** An MCP token's scope becomes
  a list of tool sets it may use, replacing the single read/write choice
  over time (existing tokens keep working with their current scope —
  principle 1).

### 4.5 Budgets and receipts

Every tool set with a cost class above `free` reports into the existing
usage metering: per-set monthly spend/search counters, the cap enforced
before the call (not after), and the execution receipt on each agent run
names the sets used. A set that hits its cap degrades to
`insufficient-evidence` behaviour — it says so, rather than silently
spending or silently skipping.

## 5. Build order

Slices are independently shippable; each
...[truncated 1223 chars]