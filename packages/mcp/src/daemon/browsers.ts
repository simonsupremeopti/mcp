import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  type BrowserInfo,
  browserAuthPayload,
  PAIRING_KEY_ALGORITHM,
} from "@browsermcp/protocol";

import { browsersPath, joinTokenPath } from "@/daemon/paths";
import type { Logger } from "@/utils/log";

/** A browser the user allowed on a daemon that isn't on loopback */
export type AllowedBrowser = {
  /** Base64 SPKI of the browser's public key */
  key: string;
  /** What it called itself when it joined, e.g. `Chrome 156` */
  name: string;
  addedAt: string;
};

/** Whether the signature is the browser's own, over `browserAuthPayload(host, port, challenge)` */
export function verifyBrowserSignature(options: {
  key: string;
  signature: string;
  host: string;
  port: number;
  challenge: string;
}): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(options.key, "base64"),
      format: "der",
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ec") {
      return false;
    }
    return verify(
      "sha256",
      Buffer.from(
        browserAuthPayload(options.host, options.port, options.challenge),
        "utf8",
      ),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(options.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * The browsers a daemon off loopback drives: `~/.browsermcp/browsers.json`, plus the join token (`~/.browsermcp/join-token`, 0600) the user pastes into a new browser's settings once.
 *
 * On loopback none of this applies: whoever reaches 127.0.0.1 is already the user. Off loopback, anyone who can route to the port could otherwise connect as a browser and have the agent drive *their* tabs, so a browser proves its own key (`browserAuth`) and is only added to the list by the join token
 */
export class BrowserAllowlist {
  private allowed: AllowedBrowser[];
  private token: string;

  private constructor(
    private readonly home: string,
    private readonly log: Logger,
    allowed: AllowedBrowser[],
    token: string,
  ) {
    this.allowed = allowed;
    this.token = token;
  }

  /** Reads the list and the join token, making a token if there isn't one */
  static load(home: string, log: Logger): BrowserAllowlist {
    return new BrowserAllowlist(
      home,
      log,
      readBrowsers(browsersPath(home)),
      readOrCreateToken(joinTokenPath(home)),
    );
  }

  /** The token the user pastes into a browser's settings to let it join */
  get joinToken(): string {
    return this.token;
  }

  get browsers(): readonly AllowedBrowser[] {
    return this.allowed;
  }

  has(key: string): boolean {
    return this.allowed.some((browser) => browser.key === key);
  }

  /** Adds a browser that sent the right join token. Returns false when the token is wrong */
  join(key: string, token: string | undefined, browser: BrowserInfo): boolean {
    if (!token || !safeEqual(token, this.token)) {
      return false;
    }
    if (this.has(key)) {
      return true;
    }
    this.allowed = [
      ...this.allowed,
      {
        key,
        name: `${browser.name} ${browser.version}`.trim(),
        addedAt: new Date().toISOString(),
      },
    ];
    writeBrowsers(browsersPath(this.home), this.allowed);
    this.log(`Allowed ${browser.name} ${browser.version} to connect`);
    return true;
  }
}

/** The algorithm a browser's key uses, for anyone checking one by hand */
export const BROWSER_KEY_ALGORITHM_NAME = PAIRING_KEY_ALGORITHM.name;

function readBrowsers(file: string): AllowedBrowser[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (browser): browser is AllowedBrowser =>
        typeof (browser as AllowedBrowser)?.key === "string",
    );
  } catch {
    return [];
  }
}

function writeBrowsers(file: string, browsers: AllowedBrowser[]) {
  writeFileSync(file, `${JSON.stringify(browsers, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readOrCreateToken(file: string): string {
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) {
      return token;
    }
  } catch {
    // No token yet
  }
  const token = randomBytes(16).toString("base64url");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let different = 0;
  for (let i = 0; i < a.length; i++) {
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return different === 0;
}
