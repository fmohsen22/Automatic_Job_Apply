import PizZip from "pizzip";

// A DOCX is a zip whose word/document.xml holds the body. Paragraphs are <w:p>
// elements; their visible text lives in <w:t> nodes inside <w:r> runs. To tailor
// the CV while keeping the EXACT formatting, we only swap the text inside the
// paragraphs we change and leave every other byte (styles, fonts, tables,
// colors, images) untouched.

export type DocxSegment = {
  index: number;
  text: string;
};

const DOCUMENT_PART = "word/document.xml";
const PARAGRAPH_RE = /<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const TEXT_NODE_RE = /<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\b[^>]*\/>/g;
const TEXT_CONTENT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

// PizZip's asText() decodes bytes as Latin-1, which corrupts multi-byte UTF-8
// characters (·, —, é, …). We always read and write document.xml as UTF-8.
function readPartUtf8(zip: PizZip): string {
  const part = zip.file(DOCUMENT_PART);
  if (!part) {
    throw new Error("This .docx file has no word/document.xml part and cannot be tailored.");
  }
  return Buffer.from(part.asUint8Array()).toString("utf8");
}

export function readDocumentXml(buffer: Buffer): string {
  return readPartUtf8(new PizZip(buffer));
}

// Ordered list of every paragraph's plain text. The index is the paragraph's
// position in document order and is stable across extract + apply.
export function extractDocxSegments(buffer: Buffer): DocxSegment[] {
  const xml = readDocumentXml(buffer);
  const segments: DocxSegment[] = [];
  let index = 0;
  for (const match of xml.matchAll(PARAGRAPH_RE)) {
    segments.push({ index, text: paragraphText(match[0]) });
    index += 1;
  }
  return segments;
}

// Rewrite the document, replacing the text of the paragraphs named in
// `replacements` (keyed by paragraph index) and returning a new .docx buffer.
export function applyDocxReplacements(buffer: Buffer, replacements: Map<number, string>): Buffer {
  const zip = new PizZip(buffer);
  const xml = readPartUtf8(zip);

  let out = "";
  let cursor = 0;
  let index = 0;
  for (const match of xml.matchAll(PARAGRAPH_RE)) {
    const start = match.index ?? 0;
    out += xml.slice(cursor, start);
    const block = match[0];
    const replacement = replacements.get(index);
    out += replacement !== undefined ? replaceParagraphText(block, replacement) : block;
    cursor = start + block.length;
    index += 1;
  }
  out += xml.slice(cursor);

  // Write back as UTF-8 bytes so inserted characters (and the originals) survive.
  zip.file(DOCUMENT_PART, Buffer.from(out, "utf8"));
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

// Replace embedded image parts (e.g. the template's sample photo) with new image
// bytes, keeping the same part names so Word's relationships stay valid.
export function swapDocxImages(buffer: Buffer, parts: string[], image: Buffer): Buffer {
  const zip = new PizZip(buffer);
  let changed = false;
  for (const part of parts) {
    if (zip.file(part)) {
      zip.file(part, image);
      changed = true;
    }
  }
  return changed ? zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) : buffer;
}

function paragraphText(paragraphXml: string): string {
  let text = "";
  for (const match of paragraphXml.matchAll(TEXT_CONTENT_RE)) {
    text += decodeXml(match[1]);
  }
  return text.trim();
}

// Put the whole new text into the paragraph's first <w:t> (preserving that
// run's formatting) and blank the remaining text nodes. Paragraphs with no text
// node are left untouched so we never corrupt structure-only paragraphs.
function replaceParagraphText(paragraphXml: string, newText: string): string {
  let seen = 0;
  let touched = false;
  const result = paragraphXml.replace(TEXT_NODE_RE, () => {
    seen += 1;
    touched = true;
    if (seen === 1) {
      return `<w:t xml:space="preserve">${escapeXml(newText)}</w:t>`;
    }
    return `<w:t xml:space="preserve"></w:t>`;
  });
  return touched ? result : paragraphXml;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
