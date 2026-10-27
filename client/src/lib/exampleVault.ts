import { createMarginDocument, marginNoteToSideDocument, type DocumentBlock } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation, ConversationGroup, DocumentRelation, DocumentRelationTypeId, WorkspaceSession } from "../types";
import { CONVERSATION_GROUP_COLORS } from "./conversationGroups";
import { getEditableDocument } from "./editableDocument";
import { addChildConversation } from "./workspaceCommands";
import { closeDocument, minimizeDocument } from "./documentWorkspace";
import { SESSION_COLORS } from "./workspaceSessions";
import { STARTER_NOTE_ID, STARTER_TITLE } from "./starterDocument";

/**
 * The example vault the free trial at /try opens with: a small research project on
 * the biology of aging, so a first visit looks like a vault someone has been working
 * in for a few weeks. Linked documents, groups, margin notes, side documents, typed
 * relations, a second session and AI answers, all editable and only in this browser.
 */
export const EXAMPLE_ID_PREFIX = "example-";
export const EXAMPLE_ROOT_ID = "example-why-we-age";
const SESSION_ID = "example-session-research";
const DAY = 86_400_000;

interface Section { id: string; title: string; daysAgo: number; blocks: string[]; relations?: Array<[DocumentRelationTypeId, string]> }

const ROOTS: Section[] = [
  { id: EXAMPLE_ROOT_ID, title: "Why we age", daysAgo: 12, blocks: [
    "Aging is the slow accumulation of damage that the body stops keeping up with. It is not one process but many, and they feed each other.",
    "Evolution explains why repair isn't perfect. Natural selection barely sees what happens after the age when most wild animals have already died, so genes that help early in life can be kept even if they cause harm later. George Williams called this antagonistic pleiotropy in 1957. The disposable soma idea adds that energy spent on repair is energy not spent on reproduction.",
    "## The twelve hallmarks\n\nA 2023 review in *Cell* lists twelve hallmarks of aging, grouped as primary causes, the body's responses to them, and integrative end results:\n\n1. Genomic instability\n2. Telomere attrition\n3. Epigenetic alterations\n4. Loss of proteostasis\n5. Disabled macroautophagy\n6. Deregulated nutrient sensing\n7. Mitochondrial dysfunction\n8. Cellular senescence\n9. Stem cell exhaustion\n10. Altered intercellular communication\n11. Chronic inflammation\n12. Dysbiosis",
    "Several have their own document: [[Telomeres]], [[Epigenetic clocks]], [[Cellular senescence]], [[Mitochondria and aging]] and [[Nutrient sensing]]. What people are testing against them is in [[Interventions that extend lifespan]].",
  ] },
  { id: "example-telomeres", title: "Telomeres", daysAgo: 11, relations: [["part-of", EXAMPLE_ROOT_ID]], blocks: [
    "Telomeres are repeated stretches of DNA (TTAGGG in humans) that cap the ends of chromosomes. They get a little shorter each time a cell divides.",
    "In 1961 Leonard Hayflick found that human cells in a dish stop dividing after roughly 40 to 60 divisions. Short telomeres are one reason: when they get too short, the cell stops dividing and often becomes senescent ([[Cellular senescence]]).",
    "Telomerase rebuilds telomeres. It is active in stem cells and in most cancers, which is the catch with switching it on everywhere. Blackburn, Greider and Szostak shared the 2009 Nobel Prize for this work.",
  ] },
  { id: "example-senescence", title: "Cellular senescence", daysAgo: 9, relations: [["part-of", EXAMPLE_ROOT_ID]], blocks: [
    "A senescent cell has stopped dividing for good but doesn't die. In young tissue that is protective: it stops damaged cells from turning into cancer, and the immune system clears them away.",
    "With age they pile up. They release a mix of inflammatory signals called the SASP (senescence-associated secretory phenotype), which harms the tissue around them and can push neighbouring cells into senescence too.",
    "In 2011, clearing senescent cells in mice delayed several age-related problems, and a 2016 follow-up found it extended median lifespan. That made senescent cells a drug target: see [[Senolytics]].",
  ] },
  { id: "example-epigenetic-clocks", title: "Epigenetic clocks", daysAgo: 8, relations: [["part-of", EXAMPLE_ROOT_ID]], blocks: [
    "DNA methylation changes with age in a predictable way. In 2013 Steve Horvath built a clock from 353 sites in the genome that estimates age from almost any tissue.",
    "Later clocks such as GrimAge were trained on health and mortality instead of calendar age, so they predict lifespan better. Being older on these clocks than on the calendar goes with a higher risk of disease and death.",
    "The open question is whether the clock measures a cause of aging or only keeps a record of it. If it is a cause, resetting it should make cells younger.",
  ] },
  { id: "example-mitochondria", title: "Mitochondria and aging", daysAgo: 7, relations: [["part-of", EXAMPLE_ROOT_ID]], blocks: [
    "Mitochondria make most of a cell's energy. With age they work less well: they make less energy, leak more reactive oxygen species, and damaged ones are cleared less often.",
    "The old free radical theory said oxidative damage drives aging. Antioxidant supplements mostly failed in trials, so the current view is that mitochondria matter through signalling and energy, not only through damage.",
    "Exercise is one of the most reliable ways to make new mitochondria.",
  ] },
  { id: "example-nutrient-sensing", title: "Nutrient sensing", daysAgo: 6, relations: [["part-of", EXAMPLE_ROOT_ID]], blocks: [
    "Cells track how much food is around and switch between growing and repairing. The main switches are insulin and IGF-1 signalling, mTOR, AMPK and the sirtuins.",
    "When food is plentiful, mTOR drives growth and turns down autophagy, the cell's recycling. When food is scarce, AMPK turns autophagy up. Turning the growth signals down extends lifespan in yeast, worms, flies and mice.",
    "```mermaid\nflowchart LR\n  F[Plenty of food] --> I[Insulin and IGF-1]\n  I --> M[mTOR]\n  M --> G[Growth]\n  M -. turns down .-> A[Autophagy]\n  S[Scarce food] --> K[AMPK]\n  K -. turns down .-> M\n  K --> A\n  R[Rapamycin] -. blocks .-> M\n```",
    "This is why [[Rapamycin]] and [[Caloric restriction]] are the two best-studied interventions.",
  ] },
  { id: "example-interventions", title: "Interventions that extend lifespan", daysAgo: 5, blocks: [
    "What has extended lifespan in mammals so far, mostly in mice. The National Institute on Aging's Interventions Testing Program (ITP) tests each compound at three sites at once, so a result has to repeat to count.",
    "| Intervention | In mice | In people |\n| --- | --- | --- |\n| [[Caloric restriction]] | Longer life in many studies; depends on the strain | Better risk markers in the CALERIE trial |\n| [[Rapamycin]] | Longer life in the ITP, even started late | Small trials, mostly safety |\n| Acarbose | Longer life in the ITP, mostly in males | Approved for diabetes |\n| [[Senolytics]] | Better health, some lifespan gains | Early, small trials |\n| [[Metformin]] | No clear lifespan gain in the ITP | TAME trial proposed |",
    "None of these has been shown to extend human lifespan. Lifespan trials in people would take decades, so researchers look for markers such as [[Epigenetic clocks]] to stand in.",
  ] },
  { id: "example-rapamycin", title: "Rapamycin", daysAgo: 4, relations: [["depends-on", "example-nutrient-sensing"], ["example-of", "example-interventions"]], blocks: [
    "Rapamycin blocks mTOR. It was found in soil bacteria on Easter Island (Rapa Nui) and is used to prevent organ transplant rejection.",
    "In 2009 the ITP reported that rapamycin extended lifespan in mice of both sexes, even when started at 600 days old, roughly 60 in human years. It extends lifespan in yeast, worms and flies too.",
    "At transplant doses the side effects include mouth ulcers, higher blood sugar and weaker immunity. Lower or weekly doses may avoid some of them, but the human evidence is thin.",
  ] },
  { id: "example-caloric-restriction", title: "Caloric restriction", daysAgo: 4, relations: [["depends-on", "example-nutrient-sensing"], ["example-of", "example-interventions"]], blocks: [
    "Eating less without malnutrition extends lifespan in yeast, worms, flies and many strains of mice and rats. The size of the effect varies a lot by strain, and some strains don't benefit.",
    "Two long monkey studies disagreed: the Wisconsin study found longer life and the NIA study didn't. Differences in diet, and in how much the control monkeys ate, probably explain much of the gap.",
    "In people, the CALERIE trial asked healthy adults to eat 25% less for two years. They managed about 12% and still improved blood pressure, cholesterol and other risk markers.",
  ] },
  { id: "example-senolytics", title: "Senolytics", daysAgo: 3, relations: [["depends-on", "example-senescence"], ["example-of", "example-interventions"]], blocks: [
    "Senolytics are drugs that kill senescent cells. The first pair studied was dasatinib, a cancer drug, with quercetin, a plant compound. Fisetin is another.",
    "In old mice they improved physical function and extended remaining lifespan. Senescent cells take time to come back, so the drugs can be given in short bursts rather than every day.",
    "Human trials so far are small and early, in conditions such as lung fibrosis and diabetic kidney disease.",
  ] },
  { id: "example-metformin", title: "Metformin", daysAgo: 2, relations: [["example-of", "example-interventions"]], blocks: [
    "Metformin is a cheap, old diabetes drug. Some studies found that people with diabetes taking it lived about as long as people without diabetes, which raised interest in it for aging.",
    "In mice the ITP found no clear lifespan gain, and in older adults it can blunt some of the benefits of exercise.",
    "TAME (Targeting Aging with Metformin) is a proposed trial to find out whether it delays heart disease, cancer and dementia together.",
  ] },
  { id: "example-open-questions", title: "Open questions", daysAgo: 1, blocks: [
    "Questions I keep coming back to, each linked to where I'm working on it.",
    `- [ ] Which DNA repair pathways fail first with age? ([[${STARTER_TITLE}]])\n- [ ] Do epigenetic clocks measure a cause of aging or only a record of it? ([[Epigenetic clocks]])\n- [ ] Can partial reprogramming be made safe in people? ([[Partial reprogramming]])\n- [x] Why did the two monkey caloric restriction studies disagree? ([[Caloric restriction]])\n- [ ] Is chronic inflammation a cause of aging or a symptom? ([[Cellular senescence]])`,
  ] },
  { id: "example-reading-list", title: "Reading list", daysAgo: 10, relations: [["cites", EXAMPLE_ROOT_ID], ["cites", "example-epigenetic-clocks"], ["cites", "example-rapamycin"], ["cites", "example-senolytics"]], blocks: [
    "Papers behind these notes.",
    "- López-Otín et al., *Hallmarks of aging: an expanding universe*, Cell, 2023: [[Why we age]]\n- Horvath, *DNA methylation age of human tissues and cell types*, Genome Biology, 2013: [[Epigenetic clocks]]\n- Harrison et al., *Rapamycin fed late in life extends lifespan in genetically heterogeneous mice*, Nature, 2009: [[Rapamycin]]\n- Baker et al., *Naturally occurring p16Ink4a-positive cells shorten healthy lifespan*, Nature, 2016: [[Cellular senescence]]\n- Ocampo et al., *In vivo amelioration of age-associated hallmarks by partial reprogramming*, Cell, 2016: [[Partial reprogramming]]\n- Xu et al., *Senolytics improve physical function and increase lifespan in old age*, Nature Medicine, 2018: [[Senolytics]]",
  ] },
];

const GROUPS: Array<{ id: string; name: string; ids: string[] }> = [
  { id: "example-group-biology", name: "Aging biology", ids: [EXAMPLE_ROOT_ID, "example-telomeres", "example-senescence", "example-epigenetic-clocks", "example-mitochondria", "example-nutrient-sensing"] },
  { id: "example-group-interventions", name: "Interventions", ids: ["example-interventions", "example-rapamycin", "example-caloric-restriction", "example-senolytics", "example-metformin"] },
  { id: "example-group-questions", name: "Questions and reading", ids: ["example-open-questions", "example-reading-list"] },
];

/** Children grown from a passage: margin notes, side documents and AI answers. */
export type ExampleChild =
  | { kind: "note"; id: string; parentId: string; block: number; quote: string; text: string }
  | { kind: "side"; id: string; parentId: string; block: number; quote: string; title: string; blocks: string[]; open?: boolean }
  | { kind: "ai"; id: string; parentId: string; block: number; quote: string; question: string; answer: string; open?: boolean };

const CHILDREN: ExampleChild[] = [
  { kind: "side", id: "example-antagonistic-pleiotropy", parentId: EXAMPLE_ROOT_ID, block: 1, quote: "antagonistic pleiotropy", title: "Antagonistic pleiotropy", blocks: [
    "A gene with two effects: good early in life, harmful later. Because selection is strong while animals are young and weak once most have died, the early benefit wins.",
    "A classic example is a gene that boosts fertility while also raising cancer risk late in life.",
  ] },
  { kind: "note", id: "example-note-disposable-soma", parentId: EXAMPLE_ROOT_ID, block: 1, quote: "disposable soma",
    text: "Kirkwood, 1977. Does it explain animals that barely seem to age, like the naked mole-rat?" },
  { kind: "note", id: "example-note-telomerase", parentId: "example-telomeres", block: 2, quote: "most cancers",
    text: "So longer telomeres are a trade-off, not a free win. Look for studies on telomere length and cancer risk." },
  { kind: "note", id: "example-note-protective", parentId: "example-senescence", block: 0, quote: "protective",
    text: "Same trade-off as telomeres: a defence against cancer that costs us later." },
  { kind: "ai", id: "example-ai-sasp", parentId: "example-senescence", block: 1, quote: "SASP", open: true,
    question: "How does the SASP lead to chronic inflammation?",
    answer: "The SASP is the mix of signals senescent cells release: cytokines such as IL-6 and IL-1, chemokines that call in immune cells, growth factors, and enzymes that break down the tissue around them.\n\n- **At first, it helps.** The signals bring in immune cells that clear the senescent cell, and they help wounds heal.\n- **With age, clearing slows.** Senescent cells accumulate, so the signals never switch off.\n- **The signals spread.** They can push nearby cells into senescence too, so the effect grows.\n- **Low-grade inflammation follows.** This steady background inflammation, sometimes called *inflammaging*, is linked to heart disease, frailty and diabetes.\n\nSo the SASP connects two hallmarks: cellular senescence and chronic inflammation." },
  { kind: "side", id: "example-partial-reprogramming", parentId: "example-epigenetic-clocks", block: 2, quote: "make cells younger", title: "Partial reprogramming", blocks: [
    "Shinya Yamanaka found that four genes (Oct4, Sox2, Klf4 and c-Myc) can turn an adult cell back into a stem cell. Done all the way, the cell forgets what kind of cell it was.",
    "Partial reprogramming switches the factors on only briefly. In 2016, cycling them in mice with a premature-aging disease extended lifespan and made tissues look younger, while the cells kept their identity.",
    "The risk is tumours: left on too long, the factors cause teratomas. Safe delivery in people is the hard part.",
  ] },
  { kind: "note", id: "example-note-antioxidants", parentId: "example-mitochondria", block: 1, quote: "Antioxidant supplements mostly failed in trials",
    text: "Worth a side document on why. Too much antioxidant may block useful signals, including the ones exercise sends." },
  { kind: "ai", id: "example-ai-trials", parentId: "example-interventions", block: 2, quote: "Lifespan trials in people would take decades",
    question: "Why are lifespan trials in people so hard?",
    answer: "- **Time.** People live around 80 years, so a trial that waits for deaths would outlast its funding.\n- **Size.** Small changes in death rates need many thousands of people to detect.\n- **Aging isn't a disease to regulators.** Drugs are approved for diseases, so a trial has to target heart disease or a set of age-related diseases instead.\n- **Healthy volunteers.** Giving a drug with side effects to healthy people for years sets a high bar for safety.\n\nThat is why TAME measures how long it takes for any of several age-related diseases to appear, and why better markers of aging would speed everything up." },
  { kind: "note", id: "example-note-600-days", parentId: "example-rapamycin", block: 1, quote: "600 days old",
    text: "Started this late and it still worked. This is the result that made people take rapamycin seriously." },
];

export function blocks(id: string, contents: string[], at: string, authorship: DocumentBlock["authorship"] = "user"): DocumentBlock[] {
  return contents.map((content, index) => ({ id: `${id}-block-${index + 1}`, kind: "markdown", content, createdAt: at, updatedAt: at, authorship }));
}

function relations(pairs: Array<[DocumentRelationTypeId, string]> = [], at: string): DocumentRelation[] {
  return pairs.map(([type, targetConversationId]) => ({ type, targetConversationId, origin: "user", createdAt: at }));
}

function anchorIn(parent: Conversation, blockIndex: number, quote: string) {
  const block = parent.document!.blocks[blockIndex];
  const startOffset = block.content.indexOf(quote);
  if (startOffset < 0) throw new Error(`Example quote not found: ${quote}`);
  return { sourceMessageId: `document:${block.id}`, sourceBlockId: block.id, startOffset, endOffset: startOffset + quote.length, quote };
}

/** Adds a note, side document or AI answer anchored to `quote` in the parent's block. */
export function addExampleChild(state: AppState, child: ExampleChild, at: string): AppState {
  const parent = state.conversations[child.parentId];
  const source = anchorIn(parent, child.block, child.quote);
  if (child.kind === "note") {
    return addChildConversation(state, createMarginDocument(parent, { id: child.id, kind: "comment", content: child.text, ...source, createdAt: at, updatedAt: at }));
  }
  const base: Conversation = {
    id: child.id, kind: "chat", title: child.kind === "ai" ? child.question : child.title, parentId: parent.id, childIds: [],
    serviceId: parent.serviceId, modelId: parent.modelId, messages: [], notes: [], documents: [], createdAt: at, updatedAt: at,
    branchAnchor: { id: `anchor:${child.id}`, sourceConversationId: parent.id, ...source,
      prompt: child.kind === "ai" ? child.question : "Side document", createdAt: at },
  };
  const conversation: Conversation = child.kind === "ai"
    ? { ...base, messages: [{ id: `${child.id}-question`, role: "user", content: child.question, createdAt: at },
        { id: `${child.id}-answer`, role: "assistant", content: child.answer, createdAt: at }] }
    : { ...base, document: { schemaVersion: 1, blocks: blocks(child.id, child.blocks, at), prompts: [], generations: [] } };
  // An AI answer keeps its question and reply, the same shape Ask AI saves.
  const withDocument = child.kind === "ai" ? { ...conversation, document: getEditableDocument(conversation) } : conversation;
  const next = addChildConversation(state, withDocument);
  if (child.open) return next;
  // Side documents wait as a small node beside their passage; AI answers close until opened.
  return child.kind === "side" ? minimizeDocument(next, child.id) : closeDocument(next, child.id);
}

/** True once the example documents are in the vault (or were, before the visitor deleted them). */
export function hasExampleVault(state: AppState) {
  return Object.hasOwn(state.conversations, EXAMPLE_ROOT_ID);
}

/** Adds the example documents beside "Start here". The visitor's own documents are left as they are. */
export function addExampleVault(state: AppState, now = new Date().toISOString()): AppState {
  if (hasExampleVault(state)) return state;
  const nowMs = Date.parse(now);
  const dated = (daysAgo: number) => new Date(nowMs - daysAgo * DAY).toISOString();
  const conversations = { ...state.conversations };
  for (const root of ROOTS) {
    const at = dated(root.daysAgo);
    conversations[root.id] = {
      id: root.id, title: root.title, kind: "note", parentId: null, childIds: [], branchAnchor: null, messages: [], notes: [],
      serviceId: state.defaultServiceId, modelId: state.defaultModelId, createdAt: at, updatedAt: at,
      ...(root.relations ? { relations: relations(root.relations, at) } : {}),
      document: { schemaVersion: 1, blocks: blocks(root.id, root.blocks, at), prompts: [], generations: [] },
    };
  }
  const groups: Record<string, ConversationGroup> = { ...state.groups };
  GROUPS.forEach((group, index) => {
    groups[group.id] = { id: group.id, name: group.name, color: CONVERSATION_GROUP_COLORS[index % CONVERSATION_GROUP_COLORS.length], collapsed: false, conversationIds: group.ids };
  });
  let next: AppState = { ...state, conversations, groups };
  for (const child of CHILDREN) {
    const parent = ROOTS.find((root) => root.id === child.parentId);
    next = addExampleChild(next, child, dated(Math.max(0, (parent?.daysAgo ?? 1) - 1)));
  }
  next = welcomeLine(next, now);
  if (next.sessions) {
    // A second session, so switching between projects has something to show.
    const session: WorkspaceSession = {
      id: SESSION_ID, name: "Aging research", nameSource: "user", color: SESSION_COLORS[1],
      documentIds: [EXAMPLE_ROOT_ID, "example-senescence", "example-interventions"], activeDocumentId: "example-senescence",
      createdAt: dated(12), lastOpenedAt: dated(1),
    };
    next = { ...next, sessions: { ...next.sessions, items: { ...next.sessions.items, [SESSION_ID]: session },
      tabIds: next.sessions.tabIds.includes(SESSION_ID) ? next.sessions.tabIds : [...next.sessions.tabIds, SESSION_ID] } };
  }
  return next;
}

const WELCOME = "This trial comes with an example vault: a few weeks of research notes on why we age, with margin notes, side documents and AI answers. Open [[Why we age]] or **Map View** to look around, and change anything you like. It all stays in this browser.";

/** Points "Start here" at the example documents, right under its first paragraph. */
function welcomeLine(state: AppState, at: string): AppState {
  return addStartHereLine(state, "example", WELCOME, at);
}

/** Adds a paragraph to "Start here" under its first paragraph and any lines added before, once. */
export function addStartHereLine(state: AppState, key: string, content: string, at: string): AppState {
  const root = Object.values(state.conversations).find((conversation) => conversation.title === STARTER_TITLE
    && conversation.parentId === null && conversation.childIds.includes(STARTER_NOTE_ID));
  const current = root?.document?.blocks;
  const id = `${root?.id}-block-${key}`;
  if (!root || !current || current.some((block) => block.id === id || block.content === content)) return state;
  const line: DocumentBlock = { id, kind: "markdown", content, createdAt: at, updatedAt: at, authorship: "user" };
  let index = 1;
  while (index < current.length && current[index].id.startsWith(`${root.id}-block-`) && !/-block-\d+$/.test(current[index].id)) index += 1;
  return { ...state, conversations: { ...state.conversations, [root.id]: { ...root,
    document: { ...root.document!, blocks: [...current.slice(0, index), line, ...current.slice(index)] } } } };
}
