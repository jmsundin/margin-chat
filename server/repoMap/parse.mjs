import { posix } from "node:path";

/**
 * Turns a repository's source files into a code graph: each file with the
 * functions, classes and types it defines, the repo files it imports and the
 * packages it uses. Parsing is by pattern, not a compiler, so it is fast and
 * free, and good enough to see how a codebase hangs together.
 */

export const FILE_BYTE_LIMIT = 300_000;
const SYMBOLS_PER_FILE = 120;

const LANGUAGES = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", rb: "ruby", php: "php", cs: "csharp",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", scala: "scala", vue: "vue", svelte: "svelte",
  css: "css", scss: "scss", html: "html", md: "markdown", mdx: "markdown", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", sh: "shell",
};
const SKIPPED_DIRECTORIES = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|coverage|__pycache__|\.next|\.venv|venv|\.cache|\.turbo|Pods)(\/|$)/u;
const SKIPPED_FILES = /(\.min\.(js|css)|\.map|(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum))$/u;

export function languageOf(path) {
  const extension = posix.extname(path).slice(1).toLowerCase();
  return LANGUAGES[extension] ?? null;
}

/** Whether a path in the archive is worth reading. */
export function isSourcePath(path) {
  return !SKIPPED_DIRECTORIES.test(path) && !SKIPPED_FILES.test(path) && languageOf(path) !== null;
}

/** Removes strings and comments from a line so braces inside them are not counted. */
function codeOnly(line, state) {
  let out = "", index = 0;
  while (index < line.length) {
    if (state.block) {
      const end = line.indexOf("*/", index);
      if (end < 0) return out;
      state.block = false; index = end + 2; continue;
    }
    const character = line[index], next = line[index + 1];
    if (character === "/" && next === "*") { state.block = true; index += 2; continue; }
    if ((character === "/" && next === "/") || (character === "#" && state.hashComments)) return out;
    if (character === "\"" || character === "'" || character === "`") {
      let end = index + 1;
      while (end < line.length && line[end] !== character) end += line[end] === "\\" ? 2 : 1;
      out += character + character; index = end + 1; continue;
    }
    out += character; index += 1;
  }
  return out;
}

/** The line where a braced block that opens at or after `start` closes. */
function braceEnd(lines, start, hashComments = false) {
  const state = { block: false, hashComments };
  let depth = 0, parens = 0, opened = false;
  for (let index = start; index < Math.min(lines.length, start + 4000); index += 1) {
    const code = codeOnly(lines[index], state);
    for (const character of code) {
      // Braces inside the parameter list are destructuring, not the body.
      if (character === "(") parens += 1;
      else if (character === ")") parens = Math.max(0, parens - 1);
      else if (parens && !opened) continue;
      else if (character === "{") { depth += 1; opened = true; }
      else if (character === "}") { depth -= 1; if (opened && depth <= 0) return index; }
    }
    // A declaration with no body, like `type A = B;` or an arrow returning an expression.
    if (!opened && !parens && /;\s*$/u.test(code)) return index;
    if (!opened && index > start + (parens ? 60 : 12)) return start;
  }
  return opened ? Math.min(lines.length - 1, start + 4000) : start;
}

/** The last line of an indented Python block that starts at `start`. */
function indentEnd(lines, start) {
  const indent = lines[start].match(/^\s*/u)[0].length;
  let last = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (line.match(/^\s*/u)[0].length <= indent && !/^\s*[)\]}]/u.test(line)) break;
    last = index;
  }
  return last;
}

const signatureOf = (line) => line.trim().replace(/\s*\{\s*$/u, "").slice(0, 160);
const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else", "do", "try", "with", "new", "typeof", "super", "await"]);

function javascriptSymbols(lines) {
  const symbols = [];
  const state = { block: false };
  let depth = 0;
  const classes = [];
  for (let index = 0; index < lines.length && symbols.length < SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    const code = codeOnly(line, state);
    if (depth === 0) {
      let match;
      const exported = /^\s*export\b/u.test(line);
      if ((match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u))) {
        symbols.push({ name: match[1], kind: "function", line: index, end: braceEnd(lines, index), exported, signature: signatureOf(line) });
      } else if ((match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u))) {
        const end = braceEnd(lines, index);
        symbols.push({ name: match[1], kind: "class", line: index, end, exported, signature: signatureOf(line) });
        classes.push({ name: match[1], end });
      } else if ((match = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/u))) {
        symbols.push({ name: match[2], kind: "type", line: index, end: braceEnd(lines, index), exported, signature: signatureOf(line) });
      } else if ((match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>|\(\s*$)/u))) {
        symbols.push({ name: match[1], kind: "function", line: index, end: braceEnd(lines, index), exported, signature: signatureOf(line) });
      } else if ((match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_$][\w$.]*\s*)?\(/u)) && /^[A-Z]|^use[A-Z]/u.test(match[1])) {
        // Wrapped components and hooks, like `const List = memo((props) => …)`.
        symbols.push({ name: match[1], kind: "function", line: index, end: braceEnd(lines, index), exported, signature: signatureOf(line) });
      }
    } else if (depth === 1 && classes.length && index < classes.at(-1).end) {
      const match = line.match(/^\s+(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{=]+)?\{?\s*$/u);
      if (match && !JS_KEYWORDS.has(match[1]) && /[{(]\s*$|\)\s*(?::[^{]+)?\{\s*$/u.test(line)) {
        symbols.push({ name: `${classes.at(-1).name}.${match[1].replace(/^#/u, "")}`, kind: "method", line: index, end: braceEnd(lines, index), exported: false, signature: signatureOf(line) });
      }
    }
    for (const character of code) depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    if (depth < 0) depth = 0;
  }
  return symbols;
}

function javascriptImports(text) {
  const found = new Set();
  const patterns = [/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/gu, /\bimport\s*["']([^"']+)["']/gu, /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/gu];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function pythonSymbols(lines) {
  const symbols = [];
  let currentClass = null;
  for (let index = 0; index < lines.length && symbols.length < SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/u);
    if (!match) continue;
    const indent = match[1].length;
    if (indent === 0) {
      const end = indentEnd(lines, index);
      symbols.push({ name: match[3], kind: match[2] === "class" ? "class" : "function", line: index, end, exported: !match[3].startsWith("_"), signature: signatureOf(line) });
      currentClass = match[2] === "class" ? { name: match[3], end } : null;
    } else if (currentClass && index <= currentClass.end && match[2] === "def" && indent <= 8) {
      symbols.push({ name: `${currentClass.name}.${match[3]}`, kind: "method", line: index, end: indentEnd(lines, index), exported: false, signature: signatureOf(line) });
    }
  }
  return symbols;
}

function pythonImports(text) {
  const found = new Set();
  for (const match of text.matchAll(/^\s*import\s+([\w., ]+)/gmu)) for (const name of match[1].split(",")) found.add(name.trim().split(/\s+/u)[0]);
  for (const match of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([\w, *]+)/gmu)) {
    found.add(match[1]);
    // `from . import a, b` names modules, not values.
    if (/^\.+$/u.test(match[1])) for (const name of match[2].split(",")) if (name.trim() && name.trim() !== "*") found.add(`${match[1]}${name.trim().split(/\s+/u)[0]}`);
  }
  return [...found].filter(Boolean);
}

function goSymbols(lines) {
  const symbols = [];
  for (let index = 0; index < lines.length && symbols.length < SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    let match;
    if ((match = line.match(/^func\s+(?:\(\s*\w*\s*\*?(\w+)[^)]*\)\s*)?([A-Za-z_]\w*)/u))) {
      symbols.push({ name: match[1] ? `${match[1]}.${match[2]}` : match[2], kind: match[1] ? "method" : "function", line: index, end: braceEnd(lines, index), exported: /^[A-Z]/u.test(match[2]), signature: signatureOf(line) });
    } else if ((match = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/u))) {
      symbols.push({ name: match[1], kind: match[2] === "struct" ? "class" : "type", line: index, end: braceEnd(lines, index), exported: /^[A-Z]/u.test(match[1]), signature: signatureOf(line) });
    }
  }
  return symbols;
}

function goImports(text) {
  const found = new Set();
  for (const match of text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gmu)) found.add(match[1]);
  for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gmu)) for (const match of block[1].matchAll(/"([^"]+)"/gu)) found.add(match[1]);
  return [...found];
}

function rustSymbols(lines) {
  const symbols = [];
  let impl = null;
  for (let index = 0; index < lines.length && symbols.length < SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    let match;
    if ((match = line.match(/^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/u))) { impl = { name: match[1], end: braceEnd(lines, index) }; continue; }
    if ((match = line.match(/^(\s*)(pub(?:\([\w:]+\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+([A-Za-z_]\w*)/u))) {
      const inImpl = impl && index <= impl.end && match[1].length > 0;
      if (match[1].length && !inImpl) continue;
      symbols.push({ name: inImpl ? `${impl.name}.${match[3]}` : match[3], kind: inImpl ? "method" : "function", line: index, end: braceEnd(lines, index), exported: Boolean(match[2]), signature: signatureOf(line) });
    } else if ((match = line.match(/^(pub(?:\([\w:]+\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/u))) {
      symbols.push({ name: match[3], kind: match[2] === "struct" ? "class" : "type", line: index, end: braceEnd(lines, index), exported: Boolean(match[1]), signature: signatureOf(line) });
    }
  }
  return symbols;
}

function rustImports(text) {
  const found = new Set();
  for (const match of text.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gmu)) found.add(`mod:${match[1]}`);
  for (const match of text.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::[A-Za-z_]\w*)+)/gmu)) found.add(match[1]);
  for (const match of text.matchAll(/^\s*(?:pub\s+)?use\s+([A-Za-z_]\w*)::/gmu)) if (!["crate", "super", "self", "std", "core", "alloc"].includes(match[1])) found.add(match[1]);
  return [...found];
}

function javaLikeSymbols(lines) {
  const symbols = [];
  let currentClass = null;
  for (let index = 0; index < lines.length && symbols.length < SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    let match;
    if ((match = line.match(/^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data|partial)\s+)*(class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/u))) {
      const end = braceEnd(lines, index);
      symbols.push({ name: match[2], kind: match[1] === "interface" || match[1] === "enum" ? "type" : "class", line: index, end, exported: /\bpublic\b/u.test(line) || !/\bprivate\b/u.test(line), signature: signatureOf(line) });
      if (!currentClass || index > currentClass.end) currentClass = { name: match[2], end };
    } else if ((match = line.match(/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|suspend|async|virtual|synchronized)\s+)*(?:fun\s+|func\s+|def\s+)?(?:[\w<>[\],.? ]+\s+)?([A-Za-z_]\w*)\s*\([^;]*$/u))
      && !JS_KEYWORDS.has(match[1]) && /\{\s*$|=\s*$|\)\s*$/u.test(line) && /^\s+/u.test(line) && currentClass && index <= currentClass.end) {
      symbols.push({ name: `${currentClass.name}.${match[1]}`, kind: "method", line: index, end: braceEnd(lines, index), exported: /\bpublic\b/u.test(line), signature: signatureOf(line) });
    }
  }
  return symbols;
}

/** Symbols and raw import specifiers for one file. Lines are 0-based here and 1-based in the graph. */
export function parseSource(path, text) {
  const language = languageOf(path);
  const lines = text.split(/\r?\n/u);
  let symbols = [], imports = [];
  if (language === "typescript" || language === "javascript" || language === "vue" || language === "svelte") { symbols = javascriptSymbols(lines); imports = javascriptImports(text); }
  else if (language === "python") { symbols = pythonSymbols(lines); imports = pythonImports(text); }
  else if (language === "go") { symbols = goSymbols(lines); imports = goImports(text); }
  else if (language === "rust") { symbols = rustSymbols(lines); imports = rustImports(text); }
  else if (["java", "kotlin", "csharp", "scala", "swift"].includes(language)) symbols = javaLikeSymbols(lines);
  return { language, lines: lines.length, symbols: symbols.map((symbol) => ({ ...symbol, line: symbol.line + 1, end: Math.max(symbol.line, symbol.end) + 1 })), imports };
}

const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".vue", ".svelte", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

/**
 * Resolves raw import specifiers to files (or, for Go, folders) in the repo.
 * What does not resolve and looks like a package becomes an external name.
 */
export function resolveImports(files, { goModule = null } = {}) {
  const paths = new Set(files.map((file) => file.path));
  const folders = new Set(files.flatMap((file) => { const parts = file.path.split("/"); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")); }));
  const tryPaths = (base, extensions) => {
    for (const extension of extensions) {
      const candidate = posix.normalize(base + extension);
      if (paths.has(candidate)) return candidate;
      // TypeScript lets `./a.js` name `./a.ts`.
      const swapped = candidate.replace(/\.(m|c)?js$/u, ".$1ts").replace(/\.jsx$/u, ".tsx");
      if (swapped !== candidate && paths.has(swapped)) return swapped;
    }
    return null;
  };
  // Common source roots for absolute imports, like `@/lib/x` or `src/lib/x`.
  const roots = ["", "src/", "lib/", "app/", ...[...folders].filter((folder) => /(^|\/)src$/u.test(folder)).map((folder) => `${folder}/`)];
  return files.map((file) => {
    const directory = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);
    const resolved = new Set(), external = new Set();
    for (const specifier of file.imports) {
      let target = null;
      if (file.language === "typescript" || file.language === "javascript" || file.language === "vue" || file.language === "svelte") {
        if (specifier.startsWith(".")) target = tryPaths(posix.join(directory, specifier), JS_EXTENSIONS);
        else if (/^[@~#]\//u.test(specifier)) for (const root of roots) { target = tryPaths(root + specifier.slice(2), JS_EXTENSIONS); if (target) break; }
        else if (!specifier.startsWith("node:")) {
          target = null;
          for (const root of roots.slice(1)) { target = tryPaths(root + specifier, JS_EXTENSIONS.slice(1)); if (target) break; }
          if (!target) external.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
        }
      } else if (file.language === "python") {
        const dots = specifier.match(/^\.*/u)[0].length;
        const rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
        const bases = dots ? [posix.join(directory, ...Array(Math.max(0, dots - 1)).fill(".."), rest)] : roots.map((root) => root + rest);
        for (const base of bases) { target = tryPaths(base, [".py", "/__init__.py"]); if (target) break; }
        if (!target && !dots) external.add(specifier.split(".")[0]);
      } else if (file.language === "go") {
        if (goModule && (specifier === goModule || specifier.startsWith(`${goModule}/`))) {
          const folder = specifier.slice(goModule.length + 1);
          if (folders.has(folder) || folder === "") target = folder || null;
        } else if (specifier.includes(".")) external.add(specifier.split("/").slice(0, 3).join("/"));
      } else if (file.language === "rust") {
        if (specifier.startsWith("mod:")) {
          const name = specifier.slice(4);
          const own = /(^|\/)(main|lib|mod)\.rs$/u.test(file.path) ? directory : posix.join(directory, posix.basename(file.path, ".rs"));
          target = tryPaths(posix.join(own, name), [".rs", "/mod.rs"]);
        } else if (/^(crate|super|self)::/u.test(specifier)) {
          const parts = specifier.split("::");
          const crateRoot = file.path.includes("src/") ? file.path.slice(0, file.path.lastIndexOf("src/") + 4) : "";
          let base = parts[0] === "crate" ? crateRoot : parts[0] === "super" ? posix.join(directory, "..") + "/" : `${directory}/`;
          for (let count = parts.length; count > 1 && !target; count -= 1) target = tryPaths(posix.join(base, ...parts.slice(1, count)), [".rs", "/mod.rs"]);
        } else external.add(specifier);
      }
      if (target && target !== file.path) resolved.add(target);
    }
    return { imports: [...resolved].slice(0, 80), external: [...external].slice(0, 40) };
  });
}

/**
 * For each exported symbol, the files that import its file and mention its
 * name: a cheap stand-in for "where is this used".
 */
export function findUsages(files, texts) {
  const importers = new Map();
  files.forEach((file, index) => {
    for (const target of file.imports) {
      const owners = paths(files, target);
      for (const owner of owners) importers.set(owner, [...importers.get(owner) ?? [], index]);
    }
  });
  return files.map((file, index) => file.symbols.map((symbol) => {
    if (!symbol.exported || symbol.kind === "method") return [];
    const name = symbol.name.split(".").at(-1);
    if (name.length < 3) return [];
    const pattern = new RegExp(`\\b${name.replace(/[$]/gu, "\\$")}\\b`, "u");
    return [...new Set(importers.get(index) ?? [])].filter((other) => pattern.test(texts[other] ?? "")).slice(0, 24);
  }));
}

const pathIndex = new WeakMap();
function paths(files, target) {
  let index = pathIndex.get(files);
  if (!index) {
    index = new Map();
    files.forEach((file, position) => {
      index.set(file.path, [position]);
      const folder = posix.dirname(file.path);
      index.set(`${folder}/`, [...index.get(`${folder}/`) ?? [], position]);
    });
    pathIndex.set(files, index);
  }
  return index.get(target) ?? index.get(`${target}/`) ?? [];
}
