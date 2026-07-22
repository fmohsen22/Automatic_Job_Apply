import {
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import type { CvSection, StructuredCv } from "./cvStructure.js";

// Builds a clean, fully editable .docx from the tailored CV so the user can
// always hand-edit the Word version — even for formats whose primary output is
// HTML/PDF (navy template) or plain text. This is intentionally a simple,
// professional layout, not a pixel copy of the designed templates.

const FONT = "Calibri";
const NAVY = "14233B";
const GOLD = "8A6D2F";
const GRAY = "6B7480";
const BODY = "1F2937";
const BODY_SIZE = 21; // half-points -> 10.5pt

export async function buildDocxFromStructuredCv(cv: StructuredCv): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(namePara(cv.name || "Candidate"));
  if (cv.headline) children.push(subtitlePara(cv.headline));

  const contact = (cv.contact ?? []).filter(Boolean).join("  ·  ");
  if (contact) children.push(mutedPara(contact));

  const stats = (cv.stats ?? [])
    .filter((stat) => stat && stat.value)
    .map((stat) => (stat.label ? `${stat.value} ${stat.label}` : stat.value))
    .join("   ·   ");
  if (stats) children.push(mutedPara(stats));

  if (cv.summary) {
    children.push(headingPara("Profile"));
    children.push(bodyPara(cv.summary));
  }

  for (const section of cv.sections ?? []) {
    children.push(...renderSection(section));
  }

  return Packer.toBuffer(buildDocument(children));
}

// Fallback for plain-text tailored CVs: detect headings and bullets so the
// Word file reads like a document instead of a wall of text.
export async function buildDocxFromText(text: string): Promise<Buffer> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const children: Paragraph[] = [];
  let sawTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!sawTitle) {
      children.push(namePara(line));
      sawTitle = true;
      continue;
    }

    const bullet = line.match(/^[-–—•*·▪]\s+(.*)$/);
    if (bullet) {
      children.push(bulletPara([new TextRun({ text: bullet[1], font: FONT, size: BODY_SIZE, color: BODY })]));
      continue;
    }

    if (looksLikeHeading(line)) {
      children.push(headingPara(line.replace(/:$/, "")));
      continue;
    }

    children.push(bodyPara(line));
  }

  if (!children.length) {
    children.push(bodyPara(text.trim() || "CV"));
  }

  return Packer.toBuffer(buildDocument(children));
}

const SECTION_HEADING_PATTERN = new RegExp(
  "^(profile|summary|professional summary|about( me)?|objective|" +
  "experience|work experience|professional experience|employment( history)?|career( history)?|" +
  "education|academic background|skills|technical skills|core skills|key skills|tech(nology)? stack|competencies|" +
  "certifications?|certificates?|licenses?|training|courses?|" +
  "projects?|selected projects|portfolio|publications?|awards?|honors?|achievements?|impact|" +
  "languages?|interests|hobbies|volunteering|references|clients( & sectors)?|sectors)\\s*:?\\s*$",
  "i"
);

function looksLikeHeading(line: string): boolean {
  if (line.length > 60) return false;
  if (SECTION_HEADING_PATTERN.test(line)) return true;
  // Short all-caps lines (with at least a few letters) read as section headings.
  const letters = line.replace(/[^a-zA-Z]/g, "");
  return letters.length >= 3 && line === line.toUpperCase() && line.length <= 48;
}

function renderSection(section: CvSection): Paragraph[] {
  const paragraphs: Paragraph[] = [headingPara(section.heading || "Section")];

  switch (section.type) {
    case "pills":
      paragraphs.push(bodyPara((section.pills ?? []).filter(Boolean).join("  ·  ")));
      break;
    case "techstack":
      for (const row of section.rows ?? []) {
        paragraphs.push(new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: `${row.label}:  `, bold: true, font: FONT, size: BODY_SIZE, color: NAVY }),
            new TextRun({ text: row.value ?? "", font: FONT, size: BODY_SIZE, color: BODY })
          ]
        }));
      }
      break;
    case "experience":
      for (const entry of section.entries ?? []) {
        paragraphs.push(new Paragraph({
          spacing: { before: 120, after: 20 },
          children: [new TextRun({ text: entry.title ?? "", bold: true, font: FONT, size: 22, color: NAVY })]
        }));
        if (entry.meta) {
          paragraphs.push(new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: entry.meta, italics: true, font: FONT, size: 19, color: GRAY })]
          }));
        }
        for (const bullet of entry.bullets ?? []) {
          paragraphs.push(bulletPara(leadRuns(bullet.lead, bullet.text)));
        }
      }
      break;
    case "projects":
      for (const entry of section.entries ?? []) {
        paragraphs.push(new Paragraph({
          spacing: { before: 100, after: 20 },
          children: [new TextRun({ text: entry.title ?? "", bold: true, font: FONT, size: 22, color: NAVY })]
        }));
        if (entry.description) paragraphs.push(bodyPara(entry.description));
        if (entry.tags) {
          paragraphs.push(new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: entry.tags, italics: true, font: FONT, size: 19, color: GRAY })]
          }));
        }
      }
      break;
    case "languages": {
      const runs: TextRun[] = [];
      (section.items ?? []).forEach((item, index) => {
        if (index > 0) runs.push(new TextRun({ text: "   ·   ", font: FONT, size: BODY_SIZE, color: GRAY }));
        runs.push(new TextRun({ text: item.label ?? "", bold: true, font: FONT, size: BODY_SIZE, color: NAVY }));
        if (item.value) runs.push(new TextRun({ text: ` ${item.value}`, font: FONT, size: BODY_SIZE, color: BODY }));
      });
      paragraphs.push(new Paragraph({ spacing: { after: 60 }, children: runs }));
      break;
    }
    case "bullets":
    default:
      for (const bullet of section.bullets ?? []) {
        paragraphs.push(bulletPara(leadRuns(bullet.lead, bullet.text)));
      }
      break;
  }

  return paragraphs;
}

function leadRuns(lead: string | undefined, text: string): TextRun[] {
  const runs: TextRun[] = [];
  if (lead) runs.push(new TextRun({ text: `${lead} — `, bold: true, font: FONT, size: BODY_SIZE, color: NAVY }));
  runs.push(new TextRun({ text: text ?? "", font: FONT, size: BODY_SIZE, color: BODY }));
  return runs;
}

function namePara(name: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: name, bold: true, font: FONT, size: 52, color: NAVY })]
  });
}

function subtitlePara(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text, bold: true, font: FONT, size: 23, color: GOLD })]
  });
}

function mutedPara(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text, font: FONT, size: 19, color: GRAY })]
  });
}

function headingPara(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "C9CFD8", space: 2 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, font: FONT, size: 21, color: NAVY })]
  });
}

function bodyPara(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text, font: FONT, size: BODY_SIZE, color: BODY })]
  });
}

function bulletPara(runs: TextRun[]): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: runs
  });
}

function buildDocument(children: Paragraph[]): Document {
  return new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE, color: BODY },
          paragraph: { spacing: { line: 276 } }
        }
      }
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 720, right: 850, bottom: 720, left: 850 } }
        },
        children
      }
    ]
  });
}
