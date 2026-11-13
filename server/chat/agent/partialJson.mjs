/**
 * Reads JSON that is still being written, or was cut off: everything up to the last object or
 * array that closed, with the containers still open closed after it. A tool call's arguments
 * stream in as text, so this is how a roadmap shows its stages while the model is still writing
 * them, and how a call cut off at the output limit keeps what it finished.
 * Returns null when nothing has closed yet.
 */
export function parsePartialJson(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { /* Still open: fall through. */ }
  const stack = [];
  let inString = false;
  let escaped = false;
  let safe = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== (character === "}" ? "{" : "[")) return null;
      safe = { end: index + 1, open: [...stack] };
    }
  }
  if (!safe || !safe.open.length) return null;
  const closers = safe.open.reverse().map((opener) => opener === "{" ? "}" : "]").join("");
  try { return JSON.parse(text.slice(0, safe.end) + closers); } catch { return null; }
}
