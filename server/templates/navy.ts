import type { Bullet, CvSection, StructuredCv } from "../services/cvStructure.js";

// Recreation of the candidate's navy / energy CV design as an HTML/CSS template.
// Rendered to PDF by Chromium. Pure presentation — content comes from StructuredCv.

export function renderNavyTemplate(cv: StructuredCv, photoDataUrl?: string): string {
  const contact = (cv.contact ?? []).filter(Boolean).map(esc).join("  ·  ");
  const stats = (cv.stats ?? [])
    .map((s) => `<div class="stat"><div class="value">${esc(s.value)}</div>${s.label ? `<div class="label">${esc(s.label)}</div>` : ""}</div>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1f2937; font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.3px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .masthead { background: #14233b; color: #fff; padding: 26px 40px 18px; display: flex; align-items: center; gap: 26px; }
  .masthead .id { flex: 1; min-width: 0; }
  .masthead .photo { flex: 0 0 auto; width: 104px; height: 104px; border-radius: 50%; object-fit: cover; border: 3px solid #c79a3c; }
  .masthead h1 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: 8px; text-transform: uppercase; }
  .headline { margin: 9px 0 0; color: #c79a3c; font-size: 12px; font-weight: 600; letter-spacing: 0.4px; }
  .contact { margin: 9px 0 0; color: #c2ccd8; font-size: 9.3px; }
  .stats { display: flex; background: #eceef1; padding: 12px 40px; }
  .stat { flex: 1; padding-right: 14px; }
  .stat .value { color: #14233b; font-size: 13px; font-weight: 700; }
  .stat .label { color: #6b7480; font-size: 8.3px; letter-spacing: 0.8px; text-transform: uppercase; margin-top: 3px; }
  main { padding: 16px 40px 38px; }
  .summary { margin: 0 0 4px; }
  h2 { color: #14233b; font-size: 10px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; margin: 15px 0 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { position: relative; padding-left: 14px; margin: 3px 0; }
  li::before { content: ""; position: absolute; left: 0; top: 5px; width: 5px; height: 5px; background: #c79a3c; }
  .lead { font-weight: 700; color: #14233b; }
  .pills { margin: 2px 0; }
  .tech-row { display: flex; gap: 16px; margin: 5px 0; }
  .tech-label { width: 120px; flex-shrink: 0; color: #c79a3c; font-size: 8.4px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; padding-top: 1px; }
  .tech-value { flex: 1; }
  .xp { margin: 7px 0 2px; }
  .xp-title { font-weight: 700; color: #14233b; }
  .xp-meta { color: #6b7480; font-size: 9px; font-style: italic; margin: 1px 0 3px; }
  .proj { margin: 6px 0 2px; }
  .proj-title { font-weight: 700; color: #14233b; }
  .proj-tags { color: #8a94a0; font-size: 9px; font-style: italic; margin-top: 1px; }
  .langs span { margin-right: 20px; }
  .langs b { color: #14233b; }
</style></head><body>
  <header class="masthead">
    <div class="id">
      <h1>${esc(cv.name)}</h1>
      ${cv.headline ? `<p class="headline">${esc(cv.headline)}</p>` : ""}
      ${contact ? `<p class="contact">${contact}</p>` : ""}
    </div>
    ${photoDataUrl ? `<img class="photo" src="${photoDataUrl}" alt="" />` : ""}
  </header>
  ${stats ? `<div class="stats">${stats}</div>` : ""}
  <main>
    ${cv.summary ? `<p class="summary">${esc(cv.summary)}</p>` : ""}
    ${(cv.sections ?? []).map(renderSection).join("\n")}
  </main>
</body></html>`;
}

function renderSection(section: CvSection): string {
  const heading = `<h2>${esc(section.heading)}</h2>`;
  switch (section.type) {
    case "pills":
      return heading + `<p class="pills">${(section.pills ?? []).map(esc).join("  ·  ")}</p>`;
    case "techstack":
      return heading + (section.rows ?? [])
        .map((r) => `<div class="tech-row"><div class="tech-label">${esc(r.label)}</div><div class="tech-value">${esc(r.value)}</div></div>`)
        .join("");
    case "experience":
      return heading + (section.entries ?? [])
        .map((e) => `<div class="xp"><div class="xp-title">${esc(e.title)}</div>${e.meta ? `<div class="xp-meta">${esc(e.meta)}</div>` : ""}${bulletList(e.bullets)}</div>`)
        .join("");
    case "projects":
      return heading + (section.entries ?? [])
        .map((e) => `<div class="proj"><div class="proj-title">${esc(e.title)}</div>${e.description ? `<div>${esc(e.description)}</div>` : ""}${e.tags ? `<div class="proj-tags">${esc(e.tags)}</div>` : ""}</div>`)
        .join("");
    case "languages":
      return heading + `<p class="langs">${(section.items ?? []).map((i) => `<span><b>${esc(i.label)}</b>${i.value ? ` ${esc(i.value)}` : ""}</span>`).join("")}</p>`;
    case "bullets":
    default:
      return heading + bulletList(section.bullets);
  }
}

function bulletList(bullets?: Bullet[]): string {
  if (!bullets?.length) return "";
  return "<ul>" + bullets
    .map((b) => `<li>${b.lead ? `<span class="lead">${esc(b.lead)}</span> — ` : ""}${esc(b.text)}</li>`)
    .join("") + "</ul>";
}

function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
