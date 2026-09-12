import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
} from "node:path";
import {
  createMarkdownWorkspace,
  parseMarkdownWorkspace,
} from "../client/src/lib/workspaceMarkdown";
import {
  createAppStateFromWorkspaceDocument,
  createWorkspaceDocument,
  parseWorkspaceDocument,
} from "../client/src/lib/workspaceModel";
import type { AppState, Conversation } from "../client/src/types";
import { normalizeAppState } from "../server/db/validation.mjs";

type MigrationOptions = {
  inPlace?: boolean;
  outputDirectory?: string;
};

export async function migrateWorkspaceJsonToMarkdown(
  inputPath: string,
  options: MigrationOptions = {},
) {
  const absoluteInputPath = resolve(inputPath);
  const input = JSON.parse(await readFile(absoluteInputPath, "utf8")) as unknown;
  const { savedAt, state } = extractWorkspaceState(input);
  const workspace = createMarkdownWorkspace(state, savedAt);
  const verificationState = parseMarkdownWorkspace(
    workspace.manifest,
    workspace.files,
  );

  if (
    !verificationState ||
    stableSerialize(createWorkspaceDocument(verificationState)) !==
      stableSerialize(createWorkspaceDocument(state))
  ) {
    throw new Error("Generated Markdown did not round-trip to the source workspace.");
  }

  const inputDirectory = dirname(absoluteInputPath);
  const inputFileName = basename(absoluteInputPath);
  const inputBaseName = inputFileName.slice(0, -extname(inputFileName).length);
  const outputDirectory = options.inPlace
    ? inputDirectory
    : resolve(
        options.outputDirectory ?? join(inputDirectory, `${inputBaseName}-obsidian`),
      );
  let backupPath: string | null = null;

  await mkdir(outputDirectory, { recursive: true });

  if (options.inPlace) {
    const backupDirectory = join(outputDirectory, "Backups");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(
      backupDirectory,
      `${inputBaseName}.v1.${timestamp}.json`,
    );
    await mkdir(backupDirectory, { recursive: true });
    await copyFile(absoluteInputPath, backupPath);
  }

  for (const [relativePath, contents] of Object.entries(workspace.files)) {
    const targetPath = join(outputDirectory, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents, "utf8");
  }

  const manifestPath = join(outputDirectory, inputFileName);
  const temporaryManifestPath = `${manifestPath}.migrating`;
  await writeFile(
    temporaryManifestPath,
    `${JSON.stringify(workspace.manifest, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryManifestPath, manifestPath);

  return {
    backupPath,
    chatFileCount: workspace.manifest.files.filter(
      (file) => file.type === "conversation" && file.path.startsWith("Chats/"),
    ).length,
    manifestPath,
    noteFileCount: workspace.manifest.files.filter((file) =>
      file.path.startsWith("Notes/"),
    ).length,
    outputDirectory,
    sourcePath: absoluteInputPath,
  };
}

function extractWorkspaceState(input: unknown): {
  savedAt: string;
  state: AppState;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Workspace JSON must contain an object.");
  }

  const candidate = input as {
    savedAt?: unknown;
    state?: unknown;
    workspace?: unknown;
  };
  const workspaceDocument = parseWorkspaceDocument(
    candidate.workspace ?? input,
  );
  const documentState = workspaceDocument
    ? createAppStateFromWorkspaceDocument(workspaceDocument)
    : null;
  const rawState = documentState ?? candidate.state ?? input;
  const normalized = normalizeAppState(rawState);
  const conversations = Object.fromEntries(
    normalized.conversations.map((conversation: Omit<Conversation, "childIds">) => [
      conversation.id,
      { ...conversation, childIds: [] },
    ]),
  ) as Record<string, Conversation>;

  for (const conversation of Object.values(conversations)) {
    if (conversation.parentId && conversations[conversation.parentId]) {
      conversations[conversation.parentId].childIds.push(conversation.id);
    }
  }

  for (const conversation of Object.values(conversations)) {
    conversation.childIds.sort((left, right) =>
      conversations[left].createdAt.localeCompare(conversations[right].createdAt),
    );
  }

  const savedAt =
    typeof candidate.savedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.savedAt))
      ? candidate.savedAt
      : new Date().toISOString();

  return {
    savedAt,
    state: {
      activeConversationId: normalized.activeConversationId,
      conversations,
      defaultModelId: normalized.defaultModelId,
      defaultServiceId: normalized.defaultServiceId,
      graphLayouts: normalized.graphLayouts,
      groups: normalized.groups,
      pinnedThreadIds: normalized.pinnedThreadIds,
      railOpen: normalized.railOpen,
      rootId: normalized.rootId,
    },
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function printUsage() {
  console.error(
    "Usage: bun scripts/migrate-workspace-json-to-markdown.ts <workspace.json> [--in-place | --output <directory>]",
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputPath = args[0];

  if (!inputPath) {
    printUsage();
    process.exitCode = 1;
  } else {
    const inPlace = args.includes("--in-place");
    const outputIndex = args.indexOf("--output");
    const outputDirectory =
      outputIndex === -1 ? undefined : args[outputIndex + 1];

    if (inPlace && outputDirectory) {
      throw new Error("Use either --in-place or --output, not both.");
    }
    if (outputIndex !== -1 && !outputDirectory) {
      throw new Error("--output requires a directory.");
    }

    const result = await migrateWorkspaceJsonToMarkdown(inputPath, {
      inPlace,
      outputDirectory,
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
