import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.VIBEPIN_V37_ROOT || path.resolve(here, "../../..");

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function canonicalSql(relative, expectedSha256) {
  const absolute = path.join(root, relative);
  const raw = fs.readFileSync(absolute);
  assert(!raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${relative} has a UTF-8 BOM`);
  const text = raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const actual = crypto.createHash("sha256").update(text).digest("hex");
  assert(actual === expectedSha256, `${relative} SHA-256 drift: ${actual}`);
  return text;
}

const migration = canonicalSql(
  "backend/db/migrate_v63_product_opportunities_v1.sql",
  "6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1",
);
const rollbackSql = canonicalSql(
  "backend/db/rollback_v63_product_opportunities_v1.sql",
  "bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c",
);
const catalogQuery = canonicalSql(
  "backend/docs/product_opportunities_v37_catalog_query_v1.sql",
  "1d0ff2369649f4f01f42be2f55abb6a4b85d24e93c365afd05ebe2dbabb6f035",
);
const baselineQuery = canonicalSql(
  "backend/docs/product_opportunities_v37_stage1_baseline_query_v1.sql",
  "3243cc589731051f173153ff5ef68dc6ffd82af20d2b722cef19d9b4b30f3f5c",
);
const postApplyQuery = canonicalSql(
  "backend/docs/product_opportunities_v37_stage1_post_apply_query_v1.sql",
  "2c482caca84b779dd60d94be8f0f7010162701fea5d0abfa3d773328d69c8b43",
);

const db = new PGlite({ extensions: { pgcrypto } });

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE pin_products (id bigint PRIMARY KEY, marker text);
    CREATE TABLE pin_save_snapshots (id bigint PRIMARY KEY, marker text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    INSERT INTO pin_products VALUES (1, 'legacy-product');
    INSERT INTO pin_save_snapshots VALUES (1, 'legacy-snapshot');
  `);

  const baselineResult = await db.query(baselineQuery);
  assert(baselineResult.rows.length === 1, "baseline query did not return one row");
  const baseline = baselineResult.rows[0].baseline;
  assert(Number(baseline.legacy_products) === 1, "legacy Product baseline count mismatch");
  assert(Number(baseline.legacy_snapshots) === 1, "legacy snapshot baseline count mismatch");
  assert(baseline.legacy_products_md5 === "1a19625d13aa292d3b520459e3c124e7", "legacy Product baseline hash mismatch");
  assert(baseline.legacy_snapshots_md5 === "99db3bd23900450c100f283ce6d06e94", "legacy snapshot baseline hash mismatch");
  assert(Number(baseline.v63_matching_object_count) === 0, "v63 object existed before migration");

  await db.exec(migration);
  const initialCatalogObjects = (await db.query(catalogQuery)).rows.length;
  assert(initialCatalogObjects === 238, `expected 238 catalog objects, got ${initialCatalogObjects}`);

  const postResult = await db.query(postApplyQuery);
  assert(postResult.rows.length === 1, "post-apply query did not return one row");
  const contract = postResult.rows[0].contract;
  const expectedLengths = {
    relations: 10,
    functions: 18,
    triggers: 9,
    policies: 3,
    indexes: 4,
    constraints: 91,
  };
  for (const [key, expected] of Object.entries(expectedLengths)) {
    assert(contract[key].length === expected, `${key} contract expected ${expected}, got ${contract[key].length}`);
  }
  assert(Object.keys(contract.privileges).length === 44, "privilege contract expected 44 facts");
  assert(Number(contract.row_counts.legacy_products) === 1, "post-apply legacy Product count changed");
  assert(Number(contract.row_counts.legacy_snapshots) === 1, "post-apply legacy snapshot count changed");
  assert(contract.row_counts.legacy_products_md5 === baseline.legacy_products_md5, "post-apply legacy Product hash changed");
  assert(contract.row_counts.legacy_snapshots_md5 === baseline.legacy_snapshots_md5, "post-apply legacy snapshot hash changed");
  for (const key of [
    "products",
    "preview_history",
    "evidence",
    "evidence_snapshots",
    "evidence_switches",
    "metrics",
    "calibrations",
    "release_gates",
    "saved",
  ]) {
    assert(Number(contract.row_counts[key]) === 0, `${key} was not empty after migration`);
  }

  const canonical = "https://merchant.example/products/real-item";
  const image = "https://merchant.example/images/real-item.jpg";
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  const candidate = {
    canonical_product_url: canonical,
    canonical_url_hash: hash,
    external_product_url: canonical,
    product_image_url: image,
    product_image_source: "merchant_open_graph",
    product_page_verified_at: "2026-08-28T00:00:00.000Z",
    product_page_verification_method: "merchant_structured_data",
    product_name: null,
    merchant: "Merchant",
    domain: "merchant.example",
    category: "fashion",
    product_type: null,
    product_family: "physical",
    discovery_method: "outbound_link",
    pinterest_pin_id: "123456789012345678",
    pinterest_pin_url: "https://www.pinterest.com/pin/123456789012345678/",
    evidence_type: "source_pin",
    relationship_method: "direct_outbound_link",
    provenance: {
      pdp_gate_passed: true,
      image_found_in_merchant_page: true,
      merchant_page_url: canonical,
      product_image_url: image,
      merchant_page_sha256: crypto.createHash("sha256").update("merchant page").digest("hex"),
      verified_by: "repo-pglite-v37",
      source_category: "fashion",
      pinterest_pin_id: "123456789012345678",
      pin_direct_outbound_url: canonical,
      source_pin_id: "123456789012345678",
      source_pin_direct_outbound_url: canonical,
      merchant_field_evidence: ["merchant:structured-data"],
      merchant_found_in_page: true,
      merchant_value: "Merchant",
    },
    additional_evidence: [],
  };

  async function admissionCounts() {
    return (await db.query(`
      SELECT
        (SELECT count(*)::int FROM product_opportunities) AS products,
        (SELECT count(*)::int FROM product_opportunity_evidence) AS evidence
    `)).rows[0];
  }

  let emptyRejected = false;
  try {
    await db.query("SELECT * FROM admit_product_opportunity_batch($1::jsonb)", ["[]"]);
  } catch (error) {
    emptyRejected = String(error).includes("must not be empty");
  }
  assert(emptyRejected, "empty admission batch was not rejected");
  assert(JSON.stringify(await admissionCounts()) === JSON.stringify({ products: 0, evidence: 0 }), "empty admission changed rows");

  let atomicRejected = false;
  try {
    await db.query("SELECT * FROM admit_product_opportunity_batch($1::jsonb)", [
      JSON.stringify([candidate, { ...candidate, category: "not-reviewed" }]),
    ]);
  } catch (error) {
    atomicRejected = String(error).includes("reviewed business category");
  }
  assert(atomicRejected, "invalid second row did not reject the statement");
  assert(JSON.stringify(await admissionCounts()) === JSON.stringify({ products: 0, evidence: 0 }), "failed multi-row admission was not atomic");

  const admitted = await db.query(
    "SELECT * FROM admit_product_opportunity_batch($1::jsonb)",
    [JSON.stringify([candidate])],
  );
  assert(admitted.rows.length === 1, "valid one-row receipt mismatch");
  const firstId = admitted.rows[0].product_opportunity_id;
  const active = (await db.query(
    `SELECT p.lifecycle_status, p.product_name, p.free_preview_rank,
            e.evidence_status, e.is_primary, e.external_product_url
       FROM product_opportunities p
       JOIN product_opportunity_evidence e ON e.product_opportunity_id = p.id
      WHERE p.id = $1`,
    [firstId],
  )).rows[0];
  assert(
    active.lifecycle_status === "active"
      && active.product_name === null
      && active.free_preview_rank === null
      && active.evidence_status === "active"
      && active.is_primary === true
      && active.external_product_url === canonical,
    "valid admission readback mismatch",
  );

  const retiredReceipt = await db.query(
    "SELECT * FROM rollback_product_opportunity_admission_batch($1::jsonb, $2)",
    [JSON.stringify([firstId]), "repo_pglite_v37"],
  );
  assert(Number(retiredReceipt.rows[0].retired_count) === 1, "rollback receipt mismatch");
  const retired = (await db.query(
    `SELECT p.lifecycle_status, p.lifecycle_reason, e.evidence_status, e.is_primary
       FROM product_opportunities p
       JOIN product_opportunity_evidence e ON e.product_opportunity_id = p.id
      WHERE p.id = $1`,
    [firstId],
  )).rows[0];
  assert(
    retired.lifecycle_status === "retired"
      && retired.lifecycle_reason.startsWith("admission_rollback:")
      && retired.evidence_status === "retired"
      && retired.is_primary === false,
    "history-preserving rollback readback mismatch",
  );

  const replacement = await db.query(
    "SELECT * FROM admit_product_opportunity_batch($1::jsonb)",
    [JSON.stringify([candidate])],
  );
  assert(
    replacement.rows.length === 1
      && replacement.rows[0].product_opportunity_id !== firstId,
    "retired/current coexistence did not create a new current row",
  );
  const coexist = (await db.query(
    `SELECT lifecycle_status, count(*)::int AS count
       FROM product_opportunities
      WHERE canonical_url_hash = $1
      GROUP BY lifecycle_status
      ORDER BY lifecycle_status`,
    [hash],
  )).rows;
  assert(
    coexist.length === 2
      && coexist[0].lifecycle_status === "active"
      && coexist[0].count === 1
      && coexist[1].lifecycle_status === "retired"
      && coexist[1].count === 1,
    "retired/current coexistence counts mismatch",
  );

  await db.exec(rollbackSql);
  const remainingCatalogObjects = (await db.query(catalogQuery)).rows.length;
  assert(remainingCatalogObjects === 0, "schema rollback left matching objects");
  const finalBaseline = (await db.query(baselineQuery)).rows[0].baseline;
  assert(finalBaseline.legacy_products_md5 === baseline.legacy_products_md5, "schema rollback changed legacy Products");
  assert(finalBaseline.legacy_snapshots_md5 === baseline.legacy_snapshots_md5, "schema rollback changed legacy snapshots");

  console.log(JSON.stringify({
    verdict: "PASS",
    relations: contract.relations.length,
    functions: contract.functions.length,
    triggers: contract.triggers.length,
    policies: contract.policies.length,
    indexes: contract.indexes.length,
    constraints: contract.constraints.length,
    privilegeFacts: Object.keys(contract.privileges).length,
    matchingCatalogObjectsAfterMigration: initialCatalogObjects,
    emptyBatchRejected: true,
    failedBatchAtomic: true,
    validAdmission: 1,
    rollbackRetired: 1,
    retiredCurrentCoexistence: true,
    matchingCatalogObjectsAfterCompleteRollback: remainingCatalogObjects,
    legacyCountsAndHashesUnchanged: true,
  }));
} finally {
  await db.close();
}
