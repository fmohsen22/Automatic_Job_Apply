// Structured representation of a CV that templates render. The AI extracts the
// candidate's real CV into this shape and tailors the wording per job; templates
// only present it. Keep fields plain so JSON stays robust.

export type Bullet = { lead?: string; text: string };

export type CvSection = {
  heading: string;
  // bullets: gold-bullet list with optional bold lead-in
  // pills: a single line of " · "-joined items (e.g. clients, sectors)
  // techstack: two-column label | value rows
  // experience: entries with title + meta + bullets (also used for education)
  // projects: entries with title + description + tags
  // languages: inline label/value pairs
  type: "bullets" | "pills" | "techstack" | "experience" | "projects" | "languages";
  bullets?: Bullet[];
  pills?: string[];
  rows?: { label: string; value: string }[];
  entries?: { title: string; meta?: string; description?: string; tags?: string; bullets?: Bullet[] }[];
  items?: { label: string; value?: string }[];
};

export type StructuredCv = {
  name: string;
  headline?: string;
  contact?: string[];
  stats?: { value: string; label?: string }[];
  summary?: string;
  sections: CvSection[];
};

export function isStructuredCv(value: unknown): value is StructuredCv {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as StructuredCv).name === "string" &&
    Array.isArray((value as StructuredCv).sections)
  );
}
