/**
 * Verifies provider selection + config reporting without hitting the network.
 *   npx tsx scripts/test-social-provider-status.ts
 */
import { getProviderStatus, getSocialProvider, selectedProviderId } from "@/lib/social/providers";
import { isProviderConfigError } from "@/lib/social/providers/errors";

function reset() {
  delete process.env.SOCIAL_PUBLISHING_PROVIDER;
  delete process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_BASE_URL;
}

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
  if (!cond) failures++;
}

async function main() {
// 1) Default → mock, configured.
reset();
check("unset provider → mock", selectedProviderId() === "mock");
check("mock configured=true", getProviderStatus().configured === true);
check("mock missingEnv empty", getProviderStatus().missingEnv.length === 0);

// 2) zernio without key → not configured, reports missing key by NAME only.
reset();
process.env.SOCIAL_PUBLISHING_PROVIDER = "zernio";
{
  const s = getProviderStatus();
  check("zernio selected", s.provider === "zernio");
  check("zernio configured=false when key missing", s.configured === false);
  check("missingEnv names ZERNIO_API_KEY", s.missingEnv.includes("ZERNIO_API_KEY"));
  check("status object contains no key value", !JSON.stringify(s).includes("sk_"));
}

// 3) zernio unconfigured → getConnectUrl throws a ProviderConfigError.
{
  let threw = false;
  try {
    await getSocialProvider().getConnectUrl({ provider: "instagram", userId: "u" });
  } catch (e) {
    threw = isProviderConfigError(e);
  }
  check("zernio getConnectUrl throws ProviderConfigError when unconfigured", threw);
  // getConnections must degrade to [] (never throw) even unconfigured.
  const conns = await getSocialProvider().getConnections({ userId: "u" });
  check("zernio getConnections → [] when unconfigured", Array.isArray(conns) && conns.length === 0);
}

// 4) zernio WITH key → configured (no network call made here).
reset();
process.env.SOCIAL_PUBLISHING_PROVIDER = "zernio";
process.env.ZERNIO_API_KEY = "sk_" + "a".repeat(64);
{
  const s = getProviderStatus();
  check("zernio configured=true with key", s.configured === true);
  check("missingEnv empty with key", s.missingEnv.length === 0);
}

reset();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

void main();
