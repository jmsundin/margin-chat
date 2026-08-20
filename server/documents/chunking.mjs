const DEFAULT_CHUNK_CHARACTERS = 2_400;
const DEFAULT_OVERLAP_CHARACTERS = 320;

function findChunkEnd(text, start, targetEnd) {
  if (targetEnd >= text.length) {
    return text.length;
  }

  const searchStart = Math.max(start + Math.floor((targetEnd - start) * 0.65), start + 1);
  const candidates = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

  for (const separator of candidates) {
    const index = text.lastIndexOf(separator, targetEnd);

    if (index >= searchStart) {
      return index + separator.length;
    }
  }

  return targetEnd;
}

export function chunkDocumentSections(
  sections,
  {
    chunkCharacters = DEFAULT_CHUNK_CHARACTERS,
    overlapCharacters = DEFAULT_OVERLAP_CHARACTERS,
  } = {},
) {
  const chunks = [];

  for (const section of sections) {
    const text = section.content.trim();
    let start = 0;

    while (start < text.length) {
      const end = findChunkEnd(
        text,
        start,
        Math.min(start + chunkCharacters, text.length),
      );
      const content = text.slice(start, end).trim();

      if (content) {
        chunks.push({
          content,
          index: chunks.length,
          pageNumber: section.pageNumber ?? null,
          tokenCount: Math.max(1, Math.ceil(content.length / 4)),
        });
      }

      if (end >= text.length) {
        break;
      }

      start = Math.max(end - overlapCharacters, start + 1);
    }
  }

  return chunks;
}
