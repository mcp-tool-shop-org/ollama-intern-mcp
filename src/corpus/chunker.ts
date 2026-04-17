/**
 * Heading-aware document chunker.
 *
 * `chunk()` is the size-based sliding-window primitive — kept as the
 * low-level splitter that operates within a single heading section.
 *
 * `chunkDocument()` is the real entry point: it walks the document,
 * splits on heading boundaries first, preserves fenced code blocks
 * intact, classifies each segment (frontmatter / heading / paragraph /
 * code / list), attaches the heading_path breadcrumb, and only then
 * size-splits oversized segments. This gives retrieval real metadata
 * to rank on (heading_path match, chunk_type filter, title boost).
 *
 * Boundaries are preserved in absolute char offsets against the input
 * text so callers can slice back into the source if needed.
 */

export type ChunkType = "heading" | "paragraph" | "code" | "list" | "frontmatter";

export interface Chunk {
  index: number;
  char_start: number;
  char_end: number;
  text: string;
  heading_path: string[];
  chunk_type: ChunkType;
}

export interface ChunkOptions {
  chunk_chars: number;
  chunk_overlap: number;
}

export const DEFAULT_CHUNK: ChunkOptions = {
  chunk_chars: 800,
  chunk_overlap: 100,
};

export interface ChunkedDocument {
  title: string | null;
  chunks: Chunk[];
}

interface RawChunk {
  index: number;
  char_start: number;
  char_end: number;
  text: string;
}

/**
 * Primitive size-based sliding-window splitter. Used internally by
 * chunkDocument() to size-split oversized heading sections; also exposed
 * so existing tests can exercise window math directly.
 */
export function chunk(text: string, opts: ChunkOptions = DEFAULT_CHUNK): RawChunk[] {
  const size = Math.max(100, opts.chunk_chars);
  const overlap = Math.min(opts.chunk_overlap, Math.floor(size / 2));
  if (text.length === 0) return [];
  if (text.length <= size) {
    return [{ index: 0, char_start: 0, char_end: text.length, text }];
  }
  const out: RawChunk[] = [];
  const step = size - overlap;
  let cursor = 0;
  let i = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + size, text.length);
    out.push({
      index: i,
      char_start: cursor,
      char_end: end,
      text: text.slice(cursor, end),
    });
    if (end === text.length) break;
    cursor += step;
    i += 1;
  }
  return out;
}

interface Segment {
  type: ChunkType;
  heading_path: string[];
  char_start: number;
  char_end: number;
  content: string;
}

const HEADING_RX = /^(#{1,6})\s+(.+?)\s*$/;
const CODE_FENCE_RX = /^(```|~~~)/;
const LIST_ITEM_RX = /^\s*([-*+]|\d+[.)])\s+/;

function isHeadingLine(line: string): { depth: number; text: string } | null {
  const m = HEADING_RX.exec(line);
  if (!m) return null;
  return { depth: m[1].length, text: m[2] };
}

function isCodeFence(line: string): boolean {
  return CODE_FENCE_RX.test(line.trim());
}

function isListItem(line: string): boolean {
  return LIST_ITEM_RX.test(line);
}

function isListMajority(content: string): boolean {
  const lines = content.split(/\r?\n/).map((l) => l.replace(/\r$/, ""));
  const nonEmpty = lines.filter((l) => l.trim().length > 0 && isHeadingLine(l) === null);
  if (nonEmpty.length === 0) return false;
  const listCount = nonEmpty.filter(isListItem).length;
  return listCount * 2 > nonEmpty.length;
}

/** Match YAML frontmatter at the very start of the document. */
function extractFrontmatter(text: string): { end: number; content: string } | null {
  if (!text.startsWith("---")) return null;
  // Require newline right after leading ---
  const afterOpen = text.indexOf("\n", 3);
  if (afterOpen === -1) return null;
  // Find closing --- on its own line.
  const rest = text.slice(afterOpen + 1);
  const closeRx = /(^|\n)---\s*(\n|$)/;
  const m = closeRx.exec(rest);
  if (!m) return null;
  const closeStart = afterOpen + 1 + m.index + (m[1] === "" ? 0 : 1);
  const closeEnd = afterOpen + 1 + m.index + m[0].length;
  return { end: closeEnd, content: text.slice(0, closeEnd) };
}

function pushSegment(
  segments: Segment[],
  type: ChunkType,
  headingPath: string[],
  start: number,
  end: number,
  content: string,
): void {
  const trimmed = content.replace(/^\s+|\s+$/g, "");
  if (trimmed.length === 0) return;
  segments.push({
    type,
    heading_path: headingPath,
    char_start: start,
    char_end: end,
    content: trimmed,
  });
}

/**
 * Heading-aware document chunker.
 *
 * Behavior:
 *  - YAML frontmatter at the very top becomes a single "frontmatter" chunk.
 *  - Every markdown heading (# through ######) updates a depth-indexed
 *    stack; chunks inherit the heading_path of the section they sit in.
 *  - Fenced code blocks (``` or ~~~) are preserved intact — never split.
 *  - Non-code sections are classified as "list" if majority of non-empty
 *    lines are list items, else "paragraph".
 *  - Sections that exceed chunk_chars are size-split via chunk() with
 *    overlap; sub-chunks inherit the parent's heading_path + type.
 *  - Title = first H1 heading after frontmatter, else null.
 */
export function chunkDocument(
  text: string,
  opts: ChunkOptions = DEFAULT_CHUNK,
): ChunkedDocument {
  if (text.length === 0) return { title: null, chunks: [] };

  const segments: Segment[] = [];
  let title: string | null = null;

  let cursor = 0;
  const fm = extractFrontmatter(text);
  if (fm) {
    pushSegment(segments, "frontmatter", [], 0, fm.end, fm.content);
    cursor = fm.end;
  }

  const headingStack: (string | null)[] = [null, null, null, null, null, null];
  const getPath = (): string[] =>
    headingStack.filter((h): h is string => h !== null);

  let bufStart = cursor;
  let bufEnd = cursor;
  let bufText = "";
  let inCode = false;
  let codeStart = 0;

  const flushBuf = (): void => {
    if (bufText.length === 0) return;
    const type: ChunkType = isListMajority(bufText) ? "list" : "paragraph";
    pushSegment(segments, type, getPath(), bufStart, bufEnd, bufText);
    bufText = "";
  };

  // Line walker over text[cursor..].
  let pos = cursor;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    const lineStart = pos;
    const nextPos = nl === -1 ? text.length + 1 : nl + 1;

    if (inCode) {
      if (isCodeFence(line)) {
        const codeEnd = nextPos - (nl === -1 ? 1 : 0);
        pushSegment(
          segments,
          "code",
          getPath(),
          codeStart,
          codeEnd,
          text.slice(codeStart, codeEnd),
        );
        inCode = false;
        bufStart = nextPos;
        bufEnd = nextPos;
      }
      pos = nextPos;
      continue;
    }

    if (isCodeFence(line)) {
      flushBuf();
      inCode = true;
      codeStart = lineStart;
      pos = nextPos;
      continue;
    }

    const heading = isHeadingLine(line);
    if (heading) {
      flushBuf();
      for (let d = heading.depth + 1; d <= 6; d++) headingStack[d - 1] = null;
      headingStack[heading.depth - 1] = heading.text;
      if (title === null && heading.depth === 1) title = heading.text;
      bufStart = lineStart;
      bufEnd = nextPos;
      bufText = line;
      pos = nextPos;
      continue;
    }

    if (bufText.length === 0) {
      bufStart = lineStart;
      bufText = line;
    } else {
      bufText += "\n" + line;
    }
    bufEnd = nextPos;
    pos = nextPos;
  }

  if (inCode) {
    pushSegment(
      segments,
      "code",
      getPath(),
      codeStart,
      text.length,
      text.slice(codeStart),
    );
  } else {
    flushBuf();
  }

  // Size-split oversized segments; never cross heading boundaries.
  const chunks: Chunk[] = [];
  let idx = 0;
  for (const seg of segments) {
    if (seg.content.length <= opts.chunk_chars || seg.type === "code") {
      chunks.push({
        index: idx++,
        char_start: seg.char_start,
        char_end: seg.char_end,
        text: seg.content,
        heading_path: seg.heading_path,
        chunk_type: seg.type,
      });
      continue;
    }
    const sub = chunk(seg.content, opts);
    for (const s of sub) {
      chunks.push({
        index: idx++,
        char_start: seg.char_start + s.char_start,
        char_end: seg.char_start + s.char_end,
        text: s.text,
        heading_path: seg.heading_path,
        chunk_type: seg.type,
      });
    }
  }

  return { title, chunks };
}
