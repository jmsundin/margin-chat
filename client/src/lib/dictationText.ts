/** Characters of transcript per cleanup request, so each one's cleaned text fits in a single reply. */
export const CLEANUP_PIECE_CHARACTERS = 4000;

/** Splits a long transcript at sentence ends, or at spaces when it has no punctuation. */
export function splitForCleanup(text: string, limit = CLEANUP_PIECE_CHARACTERS): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const sentence = Math.max(...[". ", "? ", "! ", "\n"].map((end) => window.lastIndexOf(end)));
    const space = window.lastIndexOf(" ");
    const cut = sentence > limit / 2 ? sentence + 1 : space > limit / 2 ? space : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Joins the transcripts of a recording's pieces, in order. */
export function joinTranscripts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}
