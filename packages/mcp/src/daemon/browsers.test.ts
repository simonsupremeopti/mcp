import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type BrowserInfo, browserAuthPayload } from "@browsermcp/protocol";

import { BrowserAllowlist, verifyBrowserSignature } from "@/daemon/browsers";
import { browsersPath, joinTokenPath } from "@/daemon/paths";

const browser: BrowserInfo = {
  name: "Chrome",
  version: "156",
  userAgent: "test",
};
const host = "10.1.2.3";
const port = 9010;
const challenge = "Y2hhbGxlbmdl";

/** A browser's key pair, as the extension's WebCrypto makes it */
function browserKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload, "utf8"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64"),
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "browsermcp-allowlist-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("verifyBrowserSignature", () => {
  it("accepts the browser's own signature over the host, port and challenge", () => {
    const { key, sign } = browserKey();
    const signature = sign(browserAuthPayload(host, port, challenge));
    expect(
      verifyBrowserSignature({ key, signature, host, port, challenge }),
    ).toBe(true);
  });

  it("refuses a signature made for another daemon, port or connection", () => {
    const { key, sign } = browserKey();
    const signature = sign(browserAuthPayload(host, port, challenge));
    expect(
      verifyBrowserSignature({
        key,
        signature,
        host: "10.9.9.9",
        port,
        challenge,
      }),
    ).toBe(false);
    expect(
      verifyBrowserSignature({ key, signature, host, port: 9011, challenge }),
    ).toBe(false);
    expect(
      verifyBrowserSignature({
        key,
        signature,
        host,
        port,
        challenge: "b3RoZXI=",
      }),
    ).toBe(false);
  });

  it("refuses another browser's key, and malformed input", () => {
    const { sign } = browserKey();
    const signature = sign(browserAuthPayload(host, port, challenge));
    expect(
      verifyBrowserSignature({
        key: browserKey().key,
        signature,
        host,
        port,
        challenge,
      }),
    ).toBe(false);
    expect(
      verifyBrowserSignature({
        key: "not base64 spki",
        signature,
        host,
        port,
        challenge,
      }),
    ).toBe(false);
  });
});

describe("BrowserAllowlist", () => {
  it("makes a join token once and keeps it", () => {
    const first = BrowserAllowlist.load(home, () => {});
    expect(first.joinToken).toMatch(/^[\w-]{10,}$/);
    expect(BrowserAllowlist.load(home, () => {}).joinToken).toBe(
      first.joinToken,
    );
    expect(readFileSync(joinTokenPath(home), "utf8").trim()).toBe(
      first.joinToken,
    );
  });

  it("adds a browser that sends the right token, and remembers it", () => {
    const allowlist = BrowserAllowlist.load(home, () => {});
    const { key } = browserKey();
    expect(allowlist.has(key)).toBe(false);
    expect(allowlist.join(key, "wrong", browser)).toBe(false);
    expect(allowlist.join(key, undefined, browser)).toBe(false);
    expect(allowlist.has(key)).toBe(false);

    expect(allowlist.join(key, allowlist.joinToken, browser)).toBe(true);
    expect(allowlist.has(key)).toBe(true);
    // A daemon that starts again still knows it
    const next = BrowserAllowlist.load(home, () => {});
    expect(next.has(key)).toBe(true);
    expect(next.browsers[0]?.name).toBe("Chrome 156");
    expect(JSON.parse(readFileSync(browsersPath(home), "utf8"))).toHaveLength(
      1,
    );
  });

  it("doesn't add the same browser twice", () => {
    const allowlist = BrowserAllowlist.load(home, () => {});
    const { key } = browserKey();
    allowlist.join(key, allowlist.joinToken, browser);
    allowlist.join(key, allowlist.joinToken, browser);
    expect(allowlist.browsers).toHaveLength(1);
  });
});
