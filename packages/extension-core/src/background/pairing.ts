import {
  BROWSER_KEY_ALGORITHM,
  type ExtensionMessage,
  PAIRING_KEY_ALGORITHM,
  browserAuthPayload,
  pairingCode,
  pairingCommitment,
  pairingPayload,
} from "@browsermcp/protocol";

import {
  browserKeyItem,
  joinTokenItem,
  pairedDaemonKeysItem,
} from "../storage";

/** Base64 of 32 random bytes, which the daemon signs in `welcome` */
export function createChallenge(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Whether the daemon holds the private key of `publicKey` (base64 SPKI): its signature of `pairingPayload(challenge, port, pairingCommitment)` (base64 IEEE P1363), with the port the extension dialed, verifies. `false` for malformed keys, signatures or commitments, and for a signature made for another port (a program on one of `RELAY_PORTS` relaying the challenge to the real daemon)
 */
export async function verifyDaemonSignature({
  challenge,
  port,
  host,
  publicKey,
  pairingCommitment,
  signature,
}: {
  challenge: string;
  port: number;
  /** The host the extension dialed, when the daemon isn't on loopback */
  host?: string;
  publicKey: string;
  pairingCommitment: string;
  signature: string;
}): Promise<boolean> {
  if (typeof pairingCommitment !== "string" || !pairingCommitment) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(publicKey),
      {
        name: PAIRING_KEY_ALGORITHM.name,
        namedCurve: PAIRING_KEY_ALGORITHM.namedCurve,
      },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: PAIRING_KEY_ALGORITHM.name, hash: PAIRING_KEY_ALGORITHM.hash },
      key,
      fromBase64(signature),
      new TextEncoder().encode(
        pairingPayload(challenge, port, pairingCommitment, host),
      ),
    );
  } catch {
    return false;
  }
}

/**
 * The six-digit code the popup shows next to **Allow** and the daemon's tool results show, so the user can match them (`pairingCode()`), once the daemon revealed the nonce `welcome` committed to. `null` when the reveal doesn't match the commitment: the daemon is untrusted
 */
export async function getPairingCode({
  publicKey,
  pairingCommitment: commitment,
  extensionNonce,
  daemonNonce,
}: {
  publicKey: string;
  pairingCommitment: string;
  extensionNonce: string;
  daemonNonce: unknown;
}): Promise<string | null> {
  try {
    if (
      typeof daemonNonce !== "string" ||
      (await pairingCommitment(daemonNonce)) !== commitment
    ) {
      return null;
    }
    return await pairingCode(publicKey, extensionNonce, daemonNonce);
  } catch {
    // Not base64
    return null;
  }
}

/** Whether the user clicked **Allow** for this daemon key, on this browser profile */
export async function isPairedKey(publicKey: string): Promise<boolean> {
  return (await pairedDaemonKeysItem.getValue()).includes(publicKey);
}

export async function addPairedKey(publicKey: string): Promise<void> {
  const keys = await pairedDaemonKeysItem.getValue();
  if (!keys.includes(publicKey)) {
    await pairedDaemonKeysItem.setValue([...keys, publicKey]);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * This browser's own key pair, made on first use and kept in `storage.local`. A daemon off loopback only drives browsers whose public key is in its allowlist, which the join token adds to: without it anyone who can route to the daemon's port could connect as a browser and have the agent drive their tabs
 */
async function browserKey(): Promise<{
  publicKey: string;
  key: CryptoKey;
}> {
  const stored = await browserKeyItem.getValue();
  if (stored) {
    return {
      publicKey: stored.publicKey,
      key: await crypto.subtle.importKey(
        "jwk",
        stored.privateKey,
        {
          name: BROWSER_KEY_ALGORITHM.name,
          namedCurve: BROWSER_KEY_ALGORITHM.namedCurve,
        },
        true,
        ["sign"],
      ),
    };
  }
  const pair = await crypto.subtle.generateKey(
    {
      name: BROWSER_KEY_ALGORITHM.name,
      namedCurve: BROWSER_KEY_ALGORITHM.namedCurve,
    },
    true,
    ["sign", "verify"],
  );
  const publicKey = toBase64(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  await browserKeyItem.setValue({
    publicKey,
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  });
  return { publicKey, key: pair.privateKey };
}

/** The answer to `welcome`'s `authChallenge`: this browser's key and its signature of `browserAuthPayload(host, port, challenge)`, with the join token while the daemon doesn't know the key yet */
export async function createBrowserAuth(
  host: string,
  port: number,
  challenge: string,
): Promise<Extract<ExtensionMessage, { type: "browserAuth" }>> {
  const { publicKey, key } = await browserKey();
  const signature = await crypto.subtle.sign(
    { name: BROWSER_KEY_ALGORITHM.name, hash: BROWSER_KEY_ALGORITHM.hash },
    key,
    new TextEncoder().encode(browserAuthPayload(host, port, challenge)),
  );
  const joinToken = await joinTokenItem.getValue();
  return {
    type: "browserAuth",
    key: publicKey,
    signature: toBase64(new Uint8Array(signature)),
    ...(joinToken ? { joinToken } : {}),
  };
}
