#!/usr/bin/env node
/**
 * Vercel build-time gate for Preview sandbox checkout. It is intentionally a
 * no-op outside Preview, so generic/Production builds never read a Preview-only
 * return-origin variable. The validation logic is shared with predeploy-guard.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeploymentBillingContract } from "./predeploy-guard.mjs";

if (String(process.env.VERCEL_ENV ?? "").trim().toLowerCase() !== "preview") {
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(__dirname, "..", "config", "creem-preview-origin-manifest.json");
let stableOrigins;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  stableOrigins = manifest?.stableOrigins;
  if (!Array.isArray(stableOrigins) || stableOrigins.length === 0 || !stableOrigins.every((value) => typeof value === "string")) {
    throw new Error("stableOrigins must be a non-empty string array");
  }
} catch (err) {
  console.error(`preview-deploy-guard: FAILED — invalid stable-origin manifest: ${(err).message}`);
  process.exit(1);
}

const problems = checkDeploymentBillingContract(process.env, stableOrigins);
if (problems.length > 0) {
  console.error("preview-deploy-guard: FAILED");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

console.log("preview-deploy-guard: Preview billing contract passed");
