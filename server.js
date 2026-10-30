// PII/PHI redaction PoC - small backend.
//  - serves the UI, the Web SDK and the sample document
//  - /api/config      : Web SDK license key + AI Assistant JWT (approach A)
//  - /api/detect      : PII/PHI detection on the JSON text structure (approach B)
//  - /api/scrub       : strips document metadata/XMP after redactions are applied
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { createSign, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName } from "pdf-lib";

const root = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  (existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const cfg = (k, d) => process.env[k] || env[k] || d;
const PORT = Number(cfg("PORT", 4810));
const AIA_URL = cfg("AIA_URL", "http://localhost:4100");
const OPENAI_MODEL = cfg("OPENAI_MODEL", "gpt-4o-mini");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(join(root, "public")));
app.use("/vendor", express.static(join(root, "node_modules/@nutrient-sdk/viewer/dist")));

// ---------- AI Assistant JWT (RS256, signed with keys/jwt.pem) ----------
const b64url = (b) => Buffer.from(b).toString("base64url");
function signJwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...claims, iat: now, exp: now + 3600 }));
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(readFileSync(join(root, "keys/jwt.pem"))).toString("base64url")}`;
}

app.get("/api/config", async (_req, res) => {
  let aiaUp = false;
  try { aiaUp = (await fetch(`${AIA_URL}/`, { signal: AbortSignal.timeout(1500) })).status < 500; } catch {}
  res.json({
    licenseKey: cfg("NUTRIENT_WEB_LICENSE_KEY", ""),
    aia: { up: aiaUp, backendUrl: AIA_URL, jwt: signJwt({}), sessionId: "poc" + randomUUID().replace(/-/g, "") },
    llm: { model: OPENAI_MODEL, configured: !!cfg("OPENAI_API_KEY") },
  });
});

// ---------- Approach B: detection on the JSON structure ----------
const CATEGORIES = [
  "PERSON_NAME", "DATE_OF_BIRTH", "ADDRESS", "POSTCODE", "EMAIL", "PHONE",
  "NATIONAL_INSURANCE_NUMBER", "NHS_NUMBER", "BANK_ACCOUNT_NUMBER", "SORT_CODE", "IBAN",
  "MEDICAL_CONDITION", "PROFESSIONAL_ID", "OTHER_PII",
];

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["entities"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["category", "text", "page", "lineId", "confidence", "subjectData", "reason"],
        properties: {
          category: { type: "string", enum: CATEGORIES },
          text: { type: "string", description: "Exact substring copied character-for-character from the line text (keep OCR errors and odd spacing)." },
          page: { type: "integer", description: "1-based page number" },
          lineId: { type: "string" },
          confidence: { type: "integer", description: "0-100: how sure you are that this exact span is personal data that must be redacted" },
          subjectData: { type: "boolean", description: "true if it belongs to the data subject" },
          reason: { type: "string" },
        },
      },
    },
  },
};

function systemPrompt(ctx) {
  return [
    "You are a PII/PHI detection engine for a UK legal case-management redaction workflow (GDPR, SAR, FOI).",
    "Input: a JSON structure of a document: pages -> lines, each line has an id and its text (OCR may contain errors: O instead of 0, extra spaces).",
    "Return every span that is personal data, using the categories given. Rules:",
    "- `text` MUST be copied exactly as it appears inside that line (do not fix OCR errors or spacing).",
    "- Return one entity per occurrence (same value on 3 pages = 3 entities) with its own page/lineId and its own confidence.",
    "- Confidence must be CALIBRATED and vary per occurrence, like an Azure AI Language PII score:",
    "    95-99: unambiguous and well-formed (clean email, full name next to 'Full name:', IBAN, NI number).",
    "    70-89: probably personal data but degraded or ambiguous (OCR errors such as J0hn or O77OO 9OO123, split emails like 'j ohn.smith @example.co.uk', partial references such as 'account ending 3377', initials).",
    "    30-69: weak signal, a human should decide.",
    "    0-29: looks like PII but context says it is not (company names such as 'John Smith & Sons Ltd', system/reference codes, case-system references formatted like phone numbers, the word 'rose' in a garden, street names inside an address already returned).",
    "- ALSO return those low-confidence look-alikes (with their low score and reason) so the reviewer can see what was deliberately left out.",
    "- Do not return generic dates that are not dates of birth, unless they identify a person.",
    "- Names of the data subject, relatives, third parties and their contact data are PII.",
    ctx.foi
      ? "- FOI/SAR context: names and WORK contact details of public officials (council officers) acting in their official capacity are NOT to be redacted -> confidence <= 20 with reason 'FOI: official capacity'. Private individuals, relatives, doctors' patient data and solicitors/representatives are still PII."
      : "- No FOI exemption: officials' names are PII like any other name.",
    ctx.instructions ? `- Extra instructions from the reviewer: ${ctx.instructions}` : "",
  ].filter(Boolean).join("\n");
}

app.post("/api/detect", async (req, res) => {
  const key = cfg("OPENAI_API_KEY");
  if (!key) return res.status(500).json({ error: "OPENAI_API_KEY missing in .env" });
  const { document, foi = true, instructions = "" } = req.body;
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "pii", strict: true, schema: SCHEMA } },
        messages: [
          { role: "system", content: systemPrompt({ foi, instructions }) },
          { role: "user", content: JSON.stringify(document) },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || "LLM error" });
    const parsed = JSON.parse(data.choices[0].message.content);
    res.json({ ...parsed, usage: data.usage, model: OPENAI_MODEL, ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Metadata scrub after apply (Info dictionary + XMP stream) ----------
app.post("/api/scrub", express.raw({ type: "application/pdf", limit: "100mb" }), async (req, res) => {
  try {
    const pdf = await PDFDocument.load(req.body, { updateMetadata: false });
    const before = {
      title: pdf.getTitle(), author: pdf.getAuthor(), subject: pdf.getSubject(),
      keywords: pdf.getKeywords(), creator: pdf.getCreator(), producer: pdf.getProducer(),
    };
    const trailerInfo = pdf.context.trailerInfo;
    if (trailerInfo.Info) { pdf.context.delete(trailerInfo.Info); delete trailerInfo.Info; }
    pdf.catalog.delete(PDFName.of("Metadata"));
    pdf.catalog.delete(PDFName.of("PieceInfo"));
    // Belt and braces: any annotation left on a page goes too.
    let removedAnnots = 0;
    for (const p of pdf.getPages()) {
      const a = p.node.lookup(PDFName.of("Annots"));
      if (a) { removedAnnots += a.size(); p.node.delete(PDFName.of("Annots")); }
    }
    pdf.setProducer("Redacted export");
    const bytes = await pdf.save({ updateFieldAppearances: false });
    res.set("X-Scrub-Report", encodeURIComponent(JSON.stringify({ before, removedAnnots })));
    res.type("application/pdf").send(Buffer.from(bytes));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`PII redaction PoC on http://localhost:${PORT}  (AI Assistant: ${AIA_URL})`));
