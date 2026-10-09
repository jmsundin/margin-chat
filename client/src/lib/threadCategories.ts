import type { ThreadCategoryId } from "../types";

interface ThreadCategoryDefinition {
  description: string;
  id: ThreadCategoryId;
  keywords: string[];
  label: string;
}

export const THREAD_CATEGORY_DEFINITIONS: ThreadCategoryDefinition[] = [
  {
    description: "Code, debugging, APIs, frontend, backend, and engineering work.",
    id: "coding",
    keywords: [
      "api",
      "backend",
      "bug",
      "build",
      "bun",
      "code",
      "component",
      "css",
      "debug",
      "deploy",
      "error",
      "fix",
      "frontend",
      "function",
      "javascript",
      "js",
      "node",
      "react",
      "refactor",
      "repo",
      "script",
      "server",
      "test",
      "ts",
      "tsx",
      "typescript",
      "vite",
    ],
    label: "Coding",
  },
  {
    description: "Research, comparisons, explanations, and doc-driven exploration.",
    id: "research",
    keywords: [
      "analyze",
      "analysis",
      "compare",
      "comparison",
      "docs",
      "documentation",
      "evaluate",
      "explain",
      "explore",
      "findings",
      "investigate",
      "learn",
      "overview",
      "research",
      "study",
      "summarize",
      "summary",
    ],
    label: "Research",
  },
  {
    description: "Drafting, rewriting, editing, and polishing written content.",
    id: "writing",
    keywords: [
      "article",
      "blog",
      "copy",
      "cover letter",
      "draft",
      "edit",
      "email",
      "essay",
      "headline",
      "newsletter",
      "pitch",
      "post",
      "proposal",
      "resume",
      "rewrite",
      "tone",
      "write",
      "writing",
    ],
    label: "Writing",
  },
  {
    description: "Planning, scoping, strategy, roadmaps, and execution sequencing.",
    id: "planning",
    keywords: [
      "backlog",
      "goal",
      "launch",
      "milestone",
      "next steps",
      "plan",
      "planning",
      "prioritize",
      "priority",
      "requirements",
      "roadmap",
      "scope",
      "spec",
      "sprint",
      "strategy",
      "task",
      "timeline",
    ],
    label: "Planning",
  },
  {
    description: "Product design, UI, UX, visuals, layout, and brand direction.",
    id: "design",
    keywords: [
      "brand",
      "color palette",
      "design",
      "figma",
      "font",
      "hero section",
      "icon",
      "layout",
      "landing page",
      "mockup",
      "palette",
      "prototype",
      "typography",
      "ui",
      "ux",
      "visual",
      "wireframe",
    ],
    label: "Design",
  },
  {
    description: "Metrics, spreadsheets, SQL, dashboards, and data-heavy analysis.",
    id: "data",
    keywords: [
      "chart",
      "cohort",
      "csv",
      "dashboard",
      "data",
      "dataset",
      "kpi",
      "metric",
      "query",
      "report",
      "revenue",
      "sheet",
      "spreadsheet",
      "sql",
      "table",
    ],
    label: "Data",
  },
  {
    description: "Personal organization, travel, wellness, or everyday life tasks.",
    id: "personal",
    keywords: [
      "budget",
      "family",
      "fitness",
      "gift",
      "health",
      "home",
      "itinerary",
      "journal",
      "meal",
      "personal",
      "recipe",
      "travel",
      "trip",
      "vacation",
      "workout",
    ],
    label: "Personal",
  },
  {
    description: "Threads that do not strongly match a more specific category yet.",
    id: "general",
    keywords: [],
    label: "General",
  },
];

const THREAD_CATEGORY_LOOKUP = Object.fromEntries(
  THREAD_CATEGORY_DEFINITIONS.map((category) => [category.id, category]),
) as Record<ThreadCategoryId, ThreadCategoryDefinition>;

interface ThreadCategoryInput {
  context: string;
  preview: string;
  title: string;
}

function normalizeCategoryText(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  return normalized ? ` ${normalized} ` : " ";
}

// Keywords are normalized and indexed once, so each thread is scored by
// looking up its own words: large vaults categorize every thread on each map
// render. A keyword listed twice still counts twice.
const SCORED_CATEGORIES = THREAD_CATEGORY_DEFINITIONS.filter((category) => category.id !== "general");
const CATEGORY_WORD_INDEX = new Map<string, number[]>();
const CATEGORY_PHRASES: Array<{ phrase: string; category: number }> = [];
SCORED_CATEGORIES.forEach((category, index) => {
  for (const keyword of category.keywords) {
    const normalizedKeyword = normalizeCategoryText(keyword).trim();
    if (!normalizedKeyword) continue;
    if (normalizedKeyword.includes(" ")) CATEGORY_PHRASES.push({ phrase: ` ${normalizedKeyword} `, category: index });
    else CATEGORY_WORD_INDEX.set(normalizedKeyword, [...(CATEGORY_WORD_INDEX.get(normalizedKeyword) ?? []), index]);
  }
});

/** Keyword matches per scored category, in `SCORED_CATEGORIES` order. */
function getKeywordScores(value: string) {
  const text = normalizeCategoryText(value);
  const scores = new Array<number>(SCORED_CATEGORIES.length).fill(0);
  for (const word of new Set(text.trim().split(" "))) {
    for (const category of CATEGORY_WORD_INDEX.get(word) ?? []) scores[category]++;
  }
  for (const { phrase, category } of CATEGORY_PHRASES) if (text.includes(phrase)) scores[category]++;
  return scores;
}

export function categorizeThread({
  context,
  preview,
  title,
}: ThreadCategoryInput): ThreadCategoryId {
  const titleScores = getKeywordScores(title);
  const previewScores = getKeywordScores(preview);
  const contextScores = getKeywordScores(context);
  let bestCategoryId: ThreadCategoryId = "general";
  let bestScore = 0;

  for (const [index, category] of SCORED_CATEGORIES.entries()) {
    const score = titleScores[index] * 4 + previewScores[index] * 2 + contextScores[index];

    if (score > bestScore) {
      bestCategoryId = category.id;
      bestScore = score;
    }
  }

  return bestScore >= 2 ? bestCategoryId : "general";
}

export function getThreadCategoryDescription(categoryId: ThreadCategoryId) {
  return THREAD_CATEGORY_LOOKUP[categoryId].description;
}

export function getThreadCategoryLabel(categoryId: ThreadCategoryId) {
  return THREAD_CATEGORY_LOOKUP[categoryId].label;
}
