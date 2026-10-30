// One-time / every-run setup, cross-platform (no openssl or bash needed):
//  - checks .env (created from .env.example) has an OpenAI key
//  - generates the RSA key pair used to sign AI Assistant JWTs (keys/)
//  - writes aia/.env, read by docker compose (OpenAI key, JWT public key, local secrets)
//  - writes aia/license.env only when AIA_ACTIVATION_KEY is set (empty = evaluation mode)
//  - generates the sample document if missing
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

if (!existsSync(envPath)) {
  copyFileSync(join(root, ".env.example"), envPath);
  console.log("Created .env from .env.example");
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (!env.OPENAI_API_KEY) {
  console.error("\n  Please set OPENAI_API_KEY in .env, then run this command again.\n");
  process.exit(1);
}

const keyDir = join(root, "keys");
if (!existsSync(join(keyDir, "jwt.pem"))) {
  mkdirSync(keyDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(join(keyDir, "jwt.pem"), privateKey);
  writeFileSync(join(keyDir, "jwt.pub"), publicKey);
  console.log("Generated JWT key pair in keys/");
}

const pub = readFileSync(join(keyDir, "jwt.pub"), "utf8").trim();
const secret = (name) => env[name] || "change-me";
writeFileSync(
  join(root, "aia", ".env"),
  [
    `OPENAI_API_KEY=${env.OPENAI_API_KEY}`,
    `JWT_PUBLIC_KEY="${pub}"`,
    `AIA_DB_PASSWORD=${secret("AIA_DB_PASSWORD")}`,
    `AIA_API_AUTH_TOKEN=${secret("AIA_API_AUTH_TOKEN")}`,
    `AIA_DASHBOARD_PASSWORD=${secret("AIA_DASHBOARD_PASSWORD")}`,
    `AIA_SECRET_KEY_BASE=${env.AIA_SECRET_KEY_BASE || randomBytes(48).toString("hex")}`,
  ].join("\n") + "\n"
);
console.log("Wrote aia/.env for docker compose");

// The activation key is passed to the container only when it is set:
// without it, AI Assistant runs in evaluation mode.
const licenseEnv = join(root, "aia", "license.env");
if (env.AIA_ACTIVATION_KEY) {
  writeFileSync(licenseEnv, `ACTIVATION_KEY=${env.AIA_ACTIVATION_KEY}\n`);
  console.log("Wrote aia/license.env (AI Assistant activation key)");
} else {
  rmSync(licenseEnv, { force: true });
  console.log("No AIA_ACTIVATION_KEY: AI Assistant runs in evaluation mode");
}

if (!existsSync(join(root, "public/docs/sample-case-file.pdf"))) {
  await import("./make-sample.mjs");
}
