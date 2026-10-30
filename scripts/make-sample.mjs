// Generates a deliberately "messy" 3-page case file with fake PII/PHI, reviewer
// comments, a highlight and document metadata, to test: per-page confidence,
// OCR-style spacing and O/0 swaps, the same name in several contexts,
// phone-looking account references, PHI, FOI context, a signature, and
// "comments must disappear on finalize".
//
// All names, organisations and personal data below are fictitious (Ofcom drama
// numbers, example.co.uk and .example domains, documented test-style numbers).
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFHexString, degrees } from "pdf-lib";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../public/docs/sample-case-file.pdf");

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const mono = await doc.embedFont(StandardFonts.Courier);
const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

const W = 595, H = 842;
const ink = rgb(0.12, 0.12, 0.14), grey = rgb(0.45, 0.45, 0.5), brand = rgb(0.1, 0.33, 0.62);

function header(page, n) {
  page.drawRectangle({ x: 0, y: H - 70, width: W, height: 70, color: rgb(0.95, 0.96, 0.98) });
  // fake logo
  page.drawCircle({ x: 52, y: H - 35, size: 16, color: brand });
  page.drawText("NB", { x: 42, y: H - 40, size: 13, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Northgate Borough Council - Legal Case Management", { x: 80, y: H - 32, size: 13, font: bold, color: ink });
  page.drawText("Case ref. LCM/2026/0457   |   Classification: OFFICIAL-SENSITIVE   |   Scanned copy", { x: 80, y: H - 50, size: 8, font, color: grey });
  page.drawText(`Page ${n} of 3`, { x: W - 90, y: 25, size: 8, font, color: grey });
}

// Writes lines; returns the y after the block. Each entry is [text, opts].
function block(page, x, y, lines, { size = 10.5, lead = 15, f = font, color = ink } = {}) {
  for (const l of lines) {
    const [t, o = {}] = Array.isArray(l) ? l : [l];
    page.drawText(t, { x: x + (o.dx || 0), y, size: o.size || size, font: o.font || f, color: o.color || color, rotate: o.rot ? degrees(o.rot) : undefined });
    y -= o.lead || lead;
  }
  return y;
}

// ---------- Page 1: case summary (clean-ish) ----------
const p1 = doc.addPage([W, H]);
header(p1, 1);
let y = block(p1, 50, H - 105, [["Subject Access Request - Case Summary", { font: bold, size: 15, lead: 26 }]]);
y = block(p1, 50, y, [
  ["Data subject", { font: bold }],
  "Full name: John Michael Smith",
  "Date of birth: 14/03/1982",
  "National Insurance number: QQ 12 34 56 C",
  "Home address: 42 Rose Street, Camden, London NW1 7AB",
  "Email: john.smith@example.co.uk",
  "Mobile: 07700 900123      Landline: 020 7946 0958",
  ["", { lead: 8 }],
  ["Payment details on file", { font: bold }],
  "Bank: Example Bank    Sort code: 20-45-77    Account number: 41023377",
  "IBAN: GB33 BUKB 2020 1555 5555 55",
  "Internal account ref: 00 1234 5678   (case-system reference, not a phone number)",
  ["", { lead: 8 }],
  ["Case notes", { font: bold }],
  "Mr Smith submitted a subject access request on 02/09/2026 asking for all records held about",
  "him by the Housing department. The request was acknowledged by case officer Priya Natarajan",
  "(priya.natarajan@northgate.gov.example) on 04/09/2026. Statutory deadline: 02/10/2026.",
  "Supplier invoices from John Smith & Sons Ltd (building contractor, Companies House 01234567)",
  "are referenced in the housing file but relate to a company, not the data subject.",
]);
p1.drawRectangle({ x: 50, y: y - 70, width: 495, height: 60, borderColor: rgb(0.8, 0.8, 0.85), borderWidth: 1 });
block(p1, 60, y - 25, [
  ["Requester's representative: Daniel Hart, Hart & Partners Solicitors, tel. +44 20 7946 0321", { size: 9.5 }],
  ["Correspondence to: Flat 3, 18 Elm Grove, Bristol BS8 1AA", { size: 9.5 }],
]);

// ---------- Page 2: scanned medical letter (messy OCR-like) ----------
const p2 = doc.addPage([W, H]);
header(p2, 2);
// scan noise
for (let i = 0; i < 260; i++) {
  p2.drawCircle({ x: (i * 97) % W, y: 80 + ((i * 233) % (H - 170)), size: 0.6 + (i % 3) * 0.3, color: rgb(0.78, 0.78, 0.8) });
}
p2.drawRectangle({ x: 0, y: 0, width: 14, height: H, color: rgb(0.85, 0.85, 0.87) }); // scanner edge
y = block(p2, 58, H - 105, [["Enclosure B - GP letter (scanned, OCR text layer)", { font: bold, size: 13, lead: 24 }]]);
y = block(p2, 58, y, [
  "Riverside Medical Practice, 9 Mill Lane, London N1 9GU",
  "Dear Housing Officer,",
  "Re: J0hn  Smith   DOB 14/O3/1982   NHS No. 943 476 5919",
  "I confirm that my patient has been diagnosed with Type 2 diabetes and moderate depression",
  "and has been under my care since 2019. He should not be housed above the second floor.",
  "Patient contact on our records:  j ohn.smith @example.co.uk   /   O77OO 9OO123",
  "Next of kin: Mary Smith (wife), 07700 900456.",
  "Yours sincerely,",
  ["Dr Sarah O'Neill, GMC 7654321", { font: oblique }],
], { f: mono, size: 9.6, lead: 17 });
y = block(p2, 58, y - 12, [
  ["Officer's handwritten margin note (transcribed):", { font: bold, size: 9 }],
  ["spoke w/ Mr Smith 12/09 - confirmed acct 41O23377 for housing benefit refund", { font: oblique, size: 9.5, rot: -1.2 }],
]);
block(p2, 58, y - 18, [
  ["Garden assessment: the property has a small rose bed and an apple tree; no access issues.", { size: 9.5 }],
  ["Ref. lookup codes: 9434765919-X  /  SCRN-0457-B  (system codes)", { size: 9.5 }],
]);

// ---------- Page 3: FOI-related correspondence + signature ----------
const p3 = doc.addPage([W, H]);
header(p3, 3);
y = block(p3, 50, H - 105, [["Appendix C - Correspondence & sign-off", { font: bold, size: 14, lead: 24 }]]);
y = block(p3, 50, y, [
  "From: Priya Natarajan <priya.natarajan@northgate.gov.example>   (Council case officer)",
  "To: Daniel Hart <d.hart@hart-partners.example>",
  "Subject: LCM/2026/0457 - disclosure bundle",
  "",
  "Dear Mr Hart,",
  "Please find enclosed the disclosure bundle for your client Mr John Smith. Third-party personal",
  "data (e.g. the GP's patient-facing details and the next of kin) has been reviewed. Names of",
  "Council officers acting in their official capacity are not redacted under our FOI/SAR policy.",
  "Your client's housing benefit refund will be paid to the account ending 3377.",
  "",
  "Kind regards,",
  "Priya Natarajan, Senior Case Officer, Legal Services",
]);
y -= 20;
block(p3, 50, y, [["Signed by the data subject:", { font: bold, size: 10 }]]);
// a fake handwritten signature (vector path) - only an area redaction / VLM can find it
p3.drawSvgPath("M0 0 C 10 -25, 25 20, 35 0 S 55 -20, 65 5 C 75 25, 85 -15, 100 0 C 110 10, 125 -5, 140 2", {
  x: 60, y: y - 35, borderColor: rgb(0.05, 0.15, 0.45), borderWidth: 1.4,
});
block(p3, 60, y - 60, [["J. M. Smith      Date: 18/09/2026", { size: 9.5 }]]);

// ---------- Reviewer annotations (must be gone after finalize) ----------
function addAnnot(page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots) annots.push(ref); else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  return ref;
}
const now = PDFString.of("D:20260918101500Z");
// Sticky note on page 1
addAnnot(p1, {
  Type: "Annot", Subtype: "Text", Rect: [400, 690, 420, 710], Open: false, Name: "Comment",
  T: PDFString.of("Reviewer 1"), M: now, C: [1, 0.85, 0.2],
  Contents: PDFString.of("Supervisor: should the representative's details (Daniel Hart) be redacted too? Not the subject's data."),
});
// Highlight with comment on page 2 (NHS number line)
const hy = H - 105 - 24 - 17 * 2; // baseline of the "Re:" line
addAnnot(p2, {
  Type: "Annot", Subtype: "Highlight", Rect: [56, hy - 3, 470, hy + 11],
  QuadPoints: [56, hy + 11, 470, hy + 11, 56, hy - 3, 470, hy - 3], C: [1, 0.9, 0.2], CA: 0.5,
  T: PDFString.of("Reviewer 1"), M: now,
  Contents: PDFString.of("PHI - NHS number + DOB with OCR errors (0/O). Check the model still catches them."),
});
// Free-text "draft" stamp on page 3
addAnnot(p3, {
  Type: "Annot", Subtype: "FreeText", Rect: [360, 760, 545, 790], DA: PDFString.of("/Helv 11 Tf 0.8 0 0 rg"),
  T: PDFString.of("Reviewer 1"), M: now, C: [1, 1, 1],
  Contents: PDFString.of("DRAFT - for supervisor review"),
});

doc.setTitle("LCM-2026-0457 Subject Access Request - DRAFT");
doc.setAuthor("Case reviewer");
doc.setSubject("SAR disclosure bundle - contains personal data of John Michael Smith");
doc.setKeywords(["SAR", "Housing", "John Smith", "NHS 9434765919"]);
doc.setCreator("CaseManager 4.2 (internal)");
doc.setProducer("CaseManager PDF export");

// Stable /ID in the trailer: viewers and AI Assistant use it as the document identity.
const id = createHash("md5").update("sample-case-file-v1").digest("hex");
doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await doc.save());
console.log("Sample written:", out);
