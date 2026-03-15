import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadProjectEnv(projectRoot, env = process.env) {
  loadEnvFile(resolve(projectRoot, "client/.env"), env);
  loadEnvFile(resolve(projectRoot, ".env"), env);
}

export function loadEnvFile(filePath, env = process.env) {
  if (!existsSync(filePath)) {
    return;
  }

  const fileContents = readFileSync(filePath, "utf8");

  for (const rawLine of fileContents.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());

    if (!key || env[key] !== undefined) {
      continue;
    }

    env[key] = value;
  }
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
