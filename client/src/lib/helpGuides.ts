/**
 * The guides shown in the Help panel. They are plain data so they can be searched, linked to each
 * other and tested without rendering. Text supports **bold** for the names of buttons and menus.
 *
 * Keep each guide about one task, in the words the interface itself uses: when a button is renamed,
 * rename it here in the same change.
 */

export type HelpCategoryId = "start" | "ai" | "notes" | "map" | "vault" | "learn" | "apps" | "account" | "trouble";

export interface HelpCategory {
  id: HelpCategoryId;
  name: string;
  description: string;
}

/** Something a guide can do for the reader, run by the workspace. */
export type HelpAction =
  | { kind: "settings"; section: "features" | "account" | "billing" | "api-keys" | "agents" | "appearance" | "voice" | "storage"; label: string }
  | { kind: "tour"; label: string }
  | { kind: "search"; label: string }
  | { kind: "import-chats"; label: string };

export interface HelpStep {
  title: string;
  body: string;
}

export interface HelpGuide {
  id: string;
  category: HelpCategoryId;
  title: string;
  /** One or two sentences: what the reader will be able to do. Shown in lists and at the top of the guide. */
  summary: string;
  /** What must be true first. */
  before?: string[];
  steps: HelpStep[];
  /** Limits, tips and what to expect afterwards. */
  notes?: string[];
  /** Ids of guides to read next. */
  related?: string[];
  /** Extra words people search with that the title and summary don't contain. */
  keywords?: string;
  action?: HelpAction;
}

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: "start", name: "Getting started", description: "Your first document, first question and first note." },
  { id: "ai", name: "Asking AI", description: "Ask about a passage, pick a model and let Agent mode work." },
  { id: "notes", name: "Documents & notes", description: "Write, link, organize and go back in time." },
  { id: "map", name: "The map", description: "See how your notes connect and explore beyond them." },
  { id: "vault", name: "Your vault & sync", description: "Where your files live and how they reach your devices." },
  { id: "learn", name: "Learning tools", description: "Roadmaps, flashcards and reading in another language." },
  { id: "apps", name: "Other apps & devices", description: "Connect AI apps, the browser extension and the desktop app." },
  { id: "account", name: "Plans & account", description: "What each plan includes, credit and your own keys." },
  { id: "trouble", name: "Troubleshooting", description: "When AI won't answer or a document seems missing." },
];

export const HELP_GUIDES: HelpGuide[] = [
  // Getting started
  {
    id: "first-document",
    category: "start",
    title: "Write your first document",
    summary: "A document is a page you write on, alone or with AI. Everything else in Margin Chat hangs off one.",
    steps: [
      { title: "Start a document", body: "In the sidebar, choose **New document**. On a phone, tap **+** in the dock and choose **New document**." },
      { title: "Write, or ask", body: "Type anything. On an empty line, press **Space** to ask AI instead of writing yourself." },
      { title: "Give it a title", body: "Click the title at the top and type. Margin Chat suggests one from what you wrote if you leave it empty." },
    ],
    notes: [
      "Every document is saved as a Markdown file in your vault as you type. There is no save button.",
      "The **Try it** list on a new page ticks itself off as you go.",
    ],
    related: ["ask-about-passage", "margin-note", "take-the-tour"],
    keywords: "new page create begin start blank",
  },
  {
    id: "take-the-tour",
    category: "start",
    title: "Take the guided tour",
    summary: "A short walk through the document, the vault list, the map and connected apps. You can pause it and come back.",
    steps: [
      { title: "Open the menu", body: "In the sidebar, open the **⋯** menu." },
      { title: "Start it", body: "Choose **Take the tour**. Each step points at the part of the screen it describes." },
      { title: "Pause when you like", body: "Closing a step pauses the tour and leaves a small pill you can resume from." },
    ],
    notes: ["Hiding the pill ends the tour. **Take the tour** in the ⋯ menu brings it back."],
    related: ["first-document", "turn-on-features"],
    keywords: "onboarding walkthrough intro introduction",
    action: { kind: "tour", label: "Start the tour" },
  },
  {
    id: "turn-on-features",
    category: "start",
    title: "Turn on more features",
    summary: "Margin Chat starts simple. Roadmaps, flashcards, language learning, boards, spaces and more are switched on when you want them.",
    steps: [
      { title: "Open Features", body: "Choose **Open profile** at the bottom of the sidebar, then **Features**. **More features…** at the end of any ⋯ menu goes to the same place." },
      { title: "Switch on what you need", body: "Features are grouped under Think, Learn, Capture and Organize. Each has a one-line description." },
      { title: "Find the new tool", body: "A feature you turn on appears where it is used: in the sidebar, the document menu or the map." },
    ],
    notes: ["Your choice follows your account, so every device shows the same features."],
    related: ["roadmap", "flashcards", "language-reader"],
    keywords: "settings plugins customize customise enable hidden missing option",
    action: { kind: "settings", section: "features", label: "Open Features" },
  },
  {
    id: "keyboard-shortcuts",
    category: "start",
    title: "Keyboard shortcuts",
    summary: "The keys that move you around the workspace. On Windows and Linux, use Ctrl where a Mac uses ⌘.",
    steps: [
      { title: "Search", body: "**⌘K** searches the vault by words and by meaning. **⌘O** opens the quick switcher." },
      { title: "Map", body: "**⌘G** switches between the document and the map around it." },
      { title: "Sidebar", body: "**⌘B** shows or hides the sidebar." },
      { title: "Walk between documents", body: "**Ctrl+Alt+↑** opens the parent, **Ctrl+Alt+↓** the first child, and **Ctrl+Alt+←** or **→** the neighbours beside it." },
      { title: "Ask AI", body: "Press **Space** on an empty line. **Esc** closes whatever is open on top." },
      { title: "Help", body: "**F1** opens and closes this panel." },
    ],
    related: ["search-vault", "open-map"],
    keywords: "hotkeys keys keybindings cmd ctrl command quick",
  },

  // Asking AI
  {
    id: "ask-about-passage",
    category: "ai",
    title: "Ask AI about a passage",
    summary: "Select any words and ask about them. The answer becomes its own note, linked to the exact passage, so the page you were reading stays where it was.",
    before: ["AI is set up: a plan with credit, or your own model key. See **Choose how AI is paid for**."],
    steps: [
      { title: "Select the words", body: "Drag across them. On a phone, hold a word and drag. A row appears with **Highlight**, **Note**, **Link** and **✦ Ask AI**." },
      { title: "Choose Ask AI", body: "Type your question, or send it empty to have the passage explained." },
      { title: "Pick where the answer goes", body: "Answer in a side document beside the original, or right in the document." },
      { title: "Keep going", body: "The answer is a document too. Select words in it and ask again to branch further." },
    ],
    notes: [
      "A side document is saved in your vault with a link back to the passage it came from.",
      "A document with **Hide from AI** on is never sent. Turn it off in the document's menu to ask about it.",
    ],
    related: ["choose-model", "agent-mode", "margin-note"],
    keywords: "highlight question branch side document explain selection select",
  },
  {
    id: "choose-model",
    category: "ai",
    title: "Choose a model",
    summary: "Use models from OpenAI, Anthropic, Google, xAI or Hugging Face, with your own keys or the hosted models.",
    steps: [
      { title: "Open the AI controls", body: "They sit beside the box where you type a question." },
      { title: "Pick a model", body: "Models you can use are listed by provider. Ones that need a key or credit you don't have say so." },
      { title: "Check what answered", body: "Under each answer, the model's name is shown. **Why this model?** explains an automatic choice." },
    ],
    notes: ["The model is remembered per document, so a research page and a quick note can use different ones."],
    related: ["ai-access", "own-keys"],
    keywords: "gpt claude gemini grok provider switch llm",
  },
  {
    id: "agent-mode",
    category: "ai",
    title: "Let Agent mode work through your notes",
    summary: "In Agent mode, AI searches your vault, reads what it finds and shows each step. It drafts edits and new documents that change nothing until you approve them.",
    steps: [
      { title: "Switch to Agent", body: "In the AI controls, switch Ask AI to **Agent**." },
      { title: "Ask for the outcome", body: "Describe what you want, such as a summary across several notes. Paste links or PDFs for it to read." },
      { title: "Answer its question", body: "If the request is unclear, it asks one short question before continuing." },
      { title: "Review what it proposes", body: "Edits and new documents arrive as drafts. Approve the ones you want; the rest change nothing." },
    ],
    notes: [
      "Each step it took is listed in the run log under the answer.",
      "Documents hidden from AI are never read.",
    ],
    related: ["ask-about-passage", "answer-from-vault", "hide-from-ai"],
    keywords: "autonomous research tools steps approve proposal web search",
  },
  {
    id: "answer-from-vault",
    category: "ai",
    title: "Get an answer from your own notes",
    summary: "Ask a question and get a short answer written only from your vault, with each claim cited to the passage it came from.",
    steps: [
      { title: "Open search", body: "Press **⌘K**, or choose search in the sidebar." },
      { title: "Type your question", body: "Write it the way you would ask a person." },
      { title: "Choose Answer from my vault", body: "The answer opens with numbered sources. Click one to open that passage." },
    ],
    notes: ["If your notes don't cover the question, the answer says so instead of guessing."],
    related: ["search-vault", "agent-mode"],
    keywords: "rag cite citation sources question knowledge base",
    action: { kind: "search", label: "Open search" },
  },
  {
    id: "hide-from-ai",
    category: "ai",
    title: "Hide a document from AI",
    summary: "A hidden document is never sent to a model and never read by a connected app. Search still finds it by its title.",
    steps: [
      { title: "Open the document's menu", body: "Use the **⋯** menu on the document." },
      { title: "Turn on Hide from AI", body: "The document shows a **Hidden from AI** label while it is on." },
    ],
    notes: ["Asking AI about a hidden document sends nothing and tells you why. Turn the setting off to ask."],
    related: ["connect-ai-apps", "agent-mode"],
    keywords: "private privacy secret exclude sensitive",
  },

  // Documents & notes
  {
    id: "margin-note",
    category: "notes",
    title: "Write a note in the margin",
    summary: "Keep a thought next to the line that sparked it. The note sits beside its passage and is saved as a small linked document.",
    steps: [
      { title: "Select the passage", body: "Drag across the words the note is about." },
      { title: "Choose Note", body: "Write your thought. It appears in the margin beside the passage." },
      { title: "Open it wider", body: "Click the note's dot to open it next to the page. **Open beside** in its menu does the same." },
    ],
    notes: ["A note can be moved out to a side document and put back in the margin from its menu."],
    related: ["ask-about-passage", "link-documents"],
    keywords: "annotation comment annotate sidenote highlight",
  },
  {
    id: "link-documents",
    category: "notes",
    title: "Link documents together",
    summary: "Links are what the map is drawn from. Link a passage to another document, or type a wiki link as you write.",
    steps: [
      { title: "Link from a passage", body: "Select words, choose **Link**, and pick the document to link to." },
      { title: "Or type a wiki link", body: "Type **[[** and start typing a title. Pick the document from the list." },
      { title: "Follow it", body: "Click a link to open the document. The linked document shows what points to it." },
    ],
    notes: ["Links are saved as Obsidian-style wiki links in the Markdown file, so they work in other editors too."],
    related: ["open-map", "search-vault"],
    keywords: "wikilink backlink connect reference relation",
  },
  {
    id: "search-vault",
    category: "notes",
    title: "Search your vault",
    summary: "Search finds words and meaning, and opens the passage itself with your terms highlighted, so you find the line and not only the file.",
    steps: [
      { title: "Open search", body: "Press **⌘K**." },
      { title: "Type a few words", body: "Exact words match first. Notes about the same idea in other words follow." },
      { title: "Preview, then open", body: "Move through results to preview each passage. Press **Enter** to open one." },
    ],
    notes: ["To jump to a document by its title, **⌘O** opens the quick switcher."],
    related: ["answer-from-vault", "keyboard-shortcuts"],
    keywords: "find lookup semantic full text remember",
    action: { kind: "search", label: "Open search" },
  },
  {
    id: "spaces-and-tabs",
    category: "notes",
    title: "Keep a project together with spaces and tabs",
    summary: "Tabs are the documents you have open. A space keeps a set of documents for one project so you can come back to them.",
    before: ["**Spaces** is turned on in Features."],
    steps: [
      { title: "Open documents as tabs", body: "Each document you open joins the tab row. On a phone, tap the title to switch." },
      { title: "Make a space", body: "Use the space button at the left of the tabs and name the space." },
      { title: "Come back to it", body: "Switch spaces from the same button. Each one reopens the documents you added to it." },
    ],
    related: ["turn-on-features", "first-document"],
    keywords: "workspace session project group organize organise",
  },
  {
    id: "version-history",
    category: "notes",
    title: "Go back to an earlier version",
    summary: "Every document keeps its earlier versions. Compare one with what you have now and restore it.",
    steps: [
      { title: "Open Version history", body: "In the document's **⋯** menu, choose **Version history**." },
      { title: "Pick a version", body: "Versions are listed newest first. Picking one shows what restoring it would change." },
      { title: "Restore", body: "Restoring makes a new version, so the one you replaced is still in the list." },
    ],
    related: ["recently-deleted"],
    keywords: "undo revert restore history previous old lost changes",
  },
  {
    id: "recently-deleted",
    category: "notes",
    title: "Get back a deleted document",
    summary: "Deleted documents stay in Recently deleted for 30 days.",
    steps: [
      { title: "Open Vault & storage", body: "Open your profile and choose **Vault & storage**." },
      { title: "Find Recently deleted", body: "Each deleted document is listed with when it was deleted." },
      { title: "Put it back", body: "Restore the document and it returns to your vault where it was." },
    ],
    related: ["version-history", "missing-document"],
    keywords: "trash bin recover undelete restore removed",
    action: { kind: "settings", section: "storage", label: "Open Vault & storage" },
  },

  // The map
  {
    id: "open-map",
    category: "map",
    title: "See your notes as a map",
    summary: "On the map, every document is a card and every link is a line. Zoom out to see how topics cluster and zoom in until the cards become pages you can edit.",
    steps: [
      { title: "Open the map", body: "Switch from **Document** to **Map** at the top, or press **⌘G**." },
      { title: "Move around", body: "Drag to pan and scroll to zoom. Click a card to centre the map on it and open it beside." },
      { title: "Arrange and link", body: "Drag cards where you want them. Drag from one card to another to link them." },
    ],
    notes: ["Focus centres one note and shows only what links to and from it. Clusters groups notes by their links or by meaning."],
    related: ["link-documents", "explore-topics"],
    keywords: "graph canvas visual network overview cluster",
  },
  {
    id: "explore-topics",
    category: "map",
    title: "Explore topics beyond your notes",
    summary: "Walk through Wikipedia's topics on the map, read details written by AI, and keep what you find as a note.",
    steps: [
      { title: "Open Wikipedia on the map", body: "Open the map and switch its source to Wikipedia." },
      { title: "Walk into a topic", body: "Tap a topic to see what sits under it." },
      { title: "Keep what you find", body: "Save a topic and it becomes a note in your vault, with its source." },
    ],
    related: ["open-map", "roadmap"],
    keywords: "wikipedia discover browse library research web",
  },

  // Vault & sync
  {
    id: "connect-folder",
    category: "vault",
    title: "Keep your vault in a folder on your computer",
    summary: "Your documents are plain Markdown files. Connect a folder and they live there, where other editors such as Obsidian can open them.",
    steps: [
      { title: "Open Vault & storage", body: "Open your profile and choose **Vault & storage**." },
      { title: "Choose a folder", body: "Pick an empty folder, or one that already holds Markdown files. An Obsidian vault works." },
      { title: "Let it read the folder", body: "Files already there join your vault. Plain Markdown files get an id and a created date on first read." },
    ],
    notes: [
      "Files you add to the folder from outside appear in Margin Chat.",
      "If a large number of files disappear from the folder at once, nothing is deleted until you choose.",
    ],
    related: ["cloud-sync", "import-chats"],
    keywords: "obsidian local markdown files directory import export own data",
    action: { kind: "settings", section: "storage", label: "Open Vault & storage" },
  },
  {
    id: "cloud-sync",
    category: "vault",
    title: "Sync your vault across devices",
    summary: "With cloud sync on, the same vault is on your computer, your phone and the web. Edits made offline on two devices are merged when they reconnect.",
    before: ["You are on the Cloud or Plus plan. See **What each plan includes**."],
    steps: [
      { title: "Sign in on each device", body: "Use the same account on the desktop app, the web and your phone's browser." },
      { title: "Check the sync indicator", body: "It sits by the vault's name and says whether everything is synced. Click it for details." },
      { title: "Work as usual", body: "Changes travel on their own. There is no sync button to press." },
    ],
    notes: ["Two edits to the same document are merged without conflict markers. The versions that were merged stay in Version history."],
    related: ["connect-folder", "version-history", "plans"],
    keywords: "backup phone mobile multiple computers offline merge conflict",
  },
  {
    id: "import-chats",
    category: "vault",
    title: "Bring your chat history from ChatGPT",
    summary: "Import a ChatGPT export and every old chat becomes a Markdown document you can continue, annotate and search.",
    before: ["You have downloaded your data export from ChatGPT."],
    steps: [
      { title: "Open the import", body: "In the sidebar's **⋯** menu, choose **Bring your chat history**." },
      { title: "Choose the export file", body: "Pick the file from the export. Chats already in your vault are skipped." },
      { title: "Open a chat", body: "Imported chats appear in your vault. You can undo the import from the same window." },
    ],
    related: ["connect-ai-apps", "search-vault"],
    keywords: "openai export migrate conversations old move",
    action: { kind: "import-chats", label: "Bring your chat history" },
  },

  // Learning tools
  {
    id: "roadmap",
    category: "learn",
    title: "Learn a subject with a roadmap",
    summary: "Type what you want to learn and AI drafts a roadmap: stages, lessons in order, and what each one unlocks.",
    before: ["**Roadmaps** is turned on in Features."],
    steps: [
      { title: "Say what you want to learn", body: "Type a goal, or paste a link to a course outline for the roadmap to follow." },
      { title: "Read the draft", body: "Lessons are grouped in stages and ordered so each builds on the last." },
      { title: "Open a lesson", body: "AI writes it as a document you can annotate, question and keep." },
    ],
    notes: ["Progress is marked per lesson, so you can see what is done and what is next."],
    related: ["flashcards", "turn-on-features"],
    keywords: "course curriculum study plan syllabus path",
  },
  {
    id: "flashcards",
    category: "learn",
    title: "Make and review flashcards",
    summary: "A line written as Question :: Answer becomes a card. Review brings each card back at growing intervals.",
    before: ["**Flashcards and quiz** is turned on in Features."],
    steps: [
      { title: "Write a card", body: "On its own line in any document, write the question, then **::**, then the answer." },
      { title: "Or have AI make them", body: "Choose to make cards from a document or a selected passage, then keep the ones you want." },
      { title: "Review", body: "Choose **Review flashcards** at the bottom of the sidebar. Rate how well you knew each card and it is scheduled for you." },
    ],
    notes: ["Cards can be imported from and exported to Anki."],
    related: ["roadmap", "turn-on-features"],
    keywords: "anki spaced repetition quiz memorize memorise study cards",
  },
  {
    id: "language-reader",
    category: "learn",
    title: "Read in another language",
    summary: "Turn on Language learning for a document and tap a word to see what it means in this sentence, then rate how well you know it.",
    before: ["**Language learning** is turned on in Features."],
    steps: [
      { title: "Turn on Language learning", body: "Open a document in the language you are learning. In its **⋯** menu, turn on **Language learning**." },
      { title: "Tap a word", body: "Its meaning is shown from Wiktionary, machine translation and AI." },
      { title: "Rate it", body: "Mark how well you know the word. Words you know stop being marked as new." },
    ],
    related: ["flashcards", "turn-on-features"],
    keywords: "translate vocabulary foreign words lingq spanish reading",
  },

  // Other apps & devices
  {
    id: "connect-ai-apps",
    category: "apps",
    title: "Connect Claude, ChatGPT or Gemini to your vault",
    summary: "The AI apps you already use can search and read your notes, and save what you make with them as new documents.",
    before: ["You are on the Cloud or Plus plan, because connected apps read your cloud vault."],
    steps: [
      { title: "Open Connected apps", body: "Open your profile and choose **Connected apps**." },
      { title: "Follow the steps for your app", body: "Some apps connect by signing in. Others use a token: make one per app." },
      { title: "Decide whether it can save", body: "Tick **Can create documents and add to them** for apps that should write to your vault." },
    ],
    notes: [
      "A connected app never changes or deletes what you wrote.",
      "Documents hidden from AI stay out.",
      "Step-by-step guides for each app are at marginchat.com/connect.",
    ],
    related: ["hide-from-ai", "plans"],
    keywords: "mcp connector cursor claude code token agent integration api",
    action: { kind: "settings", section: "agents", label: "Open Connected apps" },
  },
  {
    id: "browser-extension",
    category: "apps",
    title: "Use Margin Chat on any web page",
    summary: "The Chrome extension opens your workspace on top of the page you are reading. Highlight a passage to ask about it, or save the page to your vault with its source.",
    before: ["You are on the Plus plan."],
    steps: [
      { title: "Install the extension", body: "Add the Margin Chat extension to Chrome and sign in." },
      { title: "Open it on a page", body: "Your workspace opens beside the page." },
      { title: "Ask or save", body: "Highlight a passage and ask about it, or save the page or a link. Saved pages arrive in your Inbox." },
    ],
    related: ["ask-about-passage", "plans"],
    keywords: "chrome capture clip web clipper save article inbox",
  },
  {
    id: "desktop-app",
    category: "apps",
    title: "Get the desktop app",
    summary: "The desktop app for Mac, Windows and Linux opens straight into your vault folder and keeps itself up to date.",
    steps: [
      { title: "Download it", body: "Get the app for your computer from marginchat.com." },
      { title: "Sign in and choose your vault", body: "Open a folder, or create a new vault. The app remembers it next time." },
    ],
    related: ["connect-folder", "cloud-sync"],
    keywords: "mac windows linux install download native electron",
  },

  // Plans & account
  {
    id: "plans",
    category: "account",
    title: "What each plan includes",
    summary: "Writing, the map and local files are free. Cloud adds sync across devices. Plus adds monthly AI credit and the browser extension.",
    steps: [
      { title: "Free", body: "Everything on this device, with your own model keys or credit you add." },
      { title: "Cloud, $10 a month", body: "A cloud vault and sync across devices. AI uses your own keys or credit you add." },
      { title: "Plus, $20 a month", body: "Everything in Cloud, $20 of AI credit with each payment, and the Chrome extension and Inbox." },
    ],
    notes: [
      "Unused credit rolls over, and stays after you cancel.",
      "You can add credit without a subscription.",
    ],
    related: ["ai-access", "own-keys"],
    keywords: "pricing price cost subscription billing upgrade cancel pay",
    action: { kind: "settings", section: "billing", label: "Open Plan & credit" },
  },
  {
    id: "ai-access",
    category: "account",
    title: "Choose how AI is paid for",
    summary: "There are two ways: hosted models paid from your credit, or your own keys paid to the provider.",
    steps: [
      { title: "Use hosted models", body: "Subscribe to Plus or add credit under **Plan & credit**. Each answer is charged to your balance." },
      { title: "Or use your own keys", body: "Add a key from a provider under **AI & privacy**. Margin Chat charges nothing for those answers." },
      { title: "Check your balance", body: "**Plan & credit** shows what you can spend, this month's use and receipts." },
    ],
    related: ["own-keys", "plans", "ai-not-answering"],
    keywords: "credit balance top up money hosted budget spend",
    action: { kind: "settings", section: "billing", label: "Open Plan & credit" },
  },
  {
    id: "own-keys",
    category: "account",
    title: "Use your own model keys",
    summary: "Add a key from OpenAI, Anthropic, Google, xAI or Hugging Face and pay that provider directly.",
    steps: [
      { title: "Get a key", body: "Create one in your account with the provider." },
      { title: "Add it", body: "Open your profile, choose **AI & privacy**, and paste the key for that provider." },
      { title: "Pick a model", body: "That provider's models can now be chosen in the AI controls." },
    ],
    related: ["choose-model", "ai-access"],
    keywords: "api key byok openai anthropic gemini bring your own",
    action: { kind: "settings", section: "api-keys", label: "Open AI & privacy" },
  },

  // Troubleshooting
  {
    id: "ai-not-answering",
    category: "trouble",
    title: "AI won't answer",
    summary: "Three things stop an answer: no way to pay for it, a hidden document, or a model you can't use.",
    steps: [
      { title: "Check credit or keys", body: "Open **Plan & credit** for your balance, or **AI & privacy** to confirm a key is saved." },
      { title: "Check Hide from AI", body: "If the document shows **Hidden from AI**, nothing in it is sent. Turn it off in the document's menu." },
      { title: "Try another model", body: "A model without a key or price is refused before anything is sent. Pick a different one." },
    ],
    related: ["ai-access", "hide-from-ai", "choose-model"],
    keywords: "error failed nothing happens stuck broken not working balance",
  },
  {
    id: "missing-document",
    category: "trouble",
    title: "A document seems to be missing",
    summary: "Documents are rarely gone. Check search, Recently deleted and sync before anything else.",
    steps: [
      { title: "Search for it", body: "Press **⌘K** and type a few words you remember from it, not only its title." },
      { title: "Look in Recently deleted", body: "Under **Vault & storage**. Deleted documents stay for 30 days." },
      { title: "Check sync", body: "Click the sync indicator by the vault's name. A device that was offline may not have sent its changes yet." },
      { title: "Check the folder", body: "If your vault is a folder, make sure it has not been moved or renamed. A missing folder is never read as empty." },
    ],
    related: ["recently-deleted", "cloud-sync", "version-history"],
    keywords: "lost gone disappeared cannot find deleted vanished",
  },
];

/** The guides offered first, before the reader has searched for anything. */
export const POPULAR_GUIDE_IDS = ["first-document", "ask-about-passage", "margin-note", "search-vault", "open-map", "connect-ai-apps"];

const BY_ID = new Map(HELP_GUIDES.map((guide) => [guide.id, guide]));

export function getHelpGuide(id: string): HelpGuide | undefined {
  return BY_ID.get(id);
}

export function getHelpCategory(id: HelpCategoryId): HelpCategory | undefined {
  return HELP_CATEGORIES.find((category) => category.id === id);
}

export function guidesInCategory(id: HelpCategoryId): HelpGuide[] {
  return HELP_GUIDES.filter((guide) => guide.category === id);
}

function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Bold markers are formatting, not words to match. */
function plain(text: string): string {
  return text.replace(/\*\*/g, "");
}

/**
 * Guides matching every word of the query, best first. A word matches when a word in the guide starts
 * with it, so "flash" finds flashcards. Title matches outrank summary and keyword matches, which outrank
 * matches in the steps.
 */
export function searchHelpGuides(query: string, guides: HelpGuide[] = HELP_GUIDES): HelpGuide[] {
  const terms = words(query);
  if (!terms.length) return [];
  const scored: { guide: HelpGuide; score: number; order: number }[] = [];
  guides.forEach((guide, order) => {
    const title = words(guide.title);
    const lead = words(`${guide.summary} ${guide.keywords ?? ""} ${getHelpCategory(guide.category)?.name ?? ""}`);
    const body = words(plain([...guide.steps.flatMap((step) => [step.title, step.body]), ...(guide.notes ?? []), ...(guide.before ?? [])].join(" ")));
    let score = 0;
    for (const term of terms) {
      const starts = (word: string) => word.startsWith(term);
      if (title.some(starts)) score += 6;
      else if (lead.some(starts)) score += 3;
      else if (body.some(starts)) score += 1;
      else return;
    }
    scored.push({ guide, score, order });
  });
  return scored.sort((left, right) => right.score - left.score || left.order - right.order).map((item) => item.guide);
}
