import assert from "node:assert/strict";
import test from "node:test";
import { isPublicIpAddress, safeOutboundUrl } from "./safeOutboundUrl";

const publicDns = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
];

test("accepts HTTP(S) hosts when every resolved address is public", async () => {
  const url = await safeOutboundUrl("https://example.com/path", publicDns);
  assert.equal(url.hostname, "example.com");
});

test("rejects non-HTTP schemes and URL credentials", async () => {
  await assert.rejects(() => safeOutboundUrl("file:///etc/passwd", publicDns));
  await assert.rejects(() => safeOutboundUrl("https://user:pass@example.com", publicDns));
});

test("rejects loopback, private, link-local, and non-standard IP literals", async () => {
  for (const input of [
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[fe80::1]",
    "http://127.1",
    "http://0177.0.0.1",
    "http://2130706433",
    "http://134744072",
    "http://010.010.010.010",
  ]) {
    await assert.rejects(() => safeOutboundUrl(input, publicDns), input);
  }
});

test("rejects a hostname when any DNS answer is non-public", async () => {
  await assert.rejects(() =>
    safeOutboundUrl("https://example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
});

test("classifies representative public and non-public addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("192.168.1.1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicIpAddress("fc00::1"), false);
});
