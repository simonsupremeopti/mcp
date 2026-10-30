import net from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  NO_EXTENSION_MESSAGE,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayUpdateReason,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type { BackendEvents } from "@/contracts";
import { verifyBrowserSignature } from "@/daemon/browsers";
import type { CdpBridge } from "@/relay/bridge";
import {
  noSuchTabMessage,
  TAB_DETACHED_MESSAGE,
  rejectedExtensionMessage,
  UPDATE_EXTENSION_MESSAGE,
} from "@/relay/messages";
import { FakeChromium, FakeExtension } from "@/testing/fake-extension";
import {
  backendTabId,
  startTestBackend,
  tabIdMap,
} from "@/testing/test-backend";

let chromium: FakeChromium;
let relay: Awaited<ReturnType<typeof startTestBackend>>;
const extensions: FakeExtension[] = [];

async function connect(
  options: Partial<Parameters<typeof FakeExtension.connect>[0]> = {},
) {
  const extension = await FakeExtension.connect({
    port: relay.port,
    chromium,
    ...options,
  });
  extensions.push(extension);
  return extension;
}

/** A connected browser's slot, whose internals some tests reach into. Browsers are `b1`, `b2`… in the order they first connect */
function slot(browserId = "b1") {
  const current = (
    relay.backend as unknown as { slots: Map<string, BrowserSlotInternals> }
  ).slots.get(browserId);
  if (!current) {
    throw new Error(`Browser ${browserId} isn't connected`);
  }
  return current;
}

/** The ID the backend gives one of a browser's tabs: unique across browsers, so it isn't the extension's own tab ID */
function tabIdIn(browserId: string, extensionTabId: number) {
  const id = tabIdMap(relay.backend).get(`${browserId}:${extensionTabId}`);
  if (id === undefined) {
    throw new Error(`No backend ID for tab ${extensionTabId} of ${browserId}`);
  }
  return id;
}

type BrowserSlotInternals = {
  bridge: CdpBridge;
  connection: { pendingCount: number };
  waitForPage(targetId: string, stillClaimed: () => boolean): Promise<unknown>;
  pageWaiters: Map<string, unknown>;
};

beforeAll(async () => {
  chromium = await FakeChromium.launch();
}, 60_000);

afterAll(async () => {
  await chromium?.close();
});

beforeEach(async () => {
  relay = await startTestBackend();
});

afterEach(async () => {
  for (const extension of extensions.splice(0)) {
    await extension.close();
  }
  await relay.close();
});

describe("RelayBackend", () => {
  it("names a refused extension until one connects", async () => {
    const id = "a".repeat(32);
    relay.backend.noteRejectedExtension(undefined);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    relay.backend.noteRejectedExtension(id);
    expect(relay.backend.unavailableReason()).toBe(
      rejectedExtensionMessage(id),
    );
    await expect(relay.backend.page(1)).rejects.toThrow(id);

    await connect();
    expect(relay.backend.unavailableReason()).toBeNull();
  });

  it("says no browser is connected until an extension connects", async () => {
    expect(relay.backend.connected).toBe(false);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    await expect(relay.backend.page(1)).rejects.toThrow(NO_EXTENSION_MESSAGE);

    const connections: boolean[] = [];
    relay.backend.on("connection", ({ connected }) =>
      connections.push(connected),
    );
    await connect();
    expect(relay.backend.connected).toBe(true);
    expect(relay.backend.unavailableReason()).toBeNull();
    expect(connections).toEqual([true]);
  });

  it("signs the extension's challenge with its key (verified with WebCrypto)", async () => {
    const extension = await connect();
    expect(await extension.verifyWelcome()).toBe(true);
    expect(extension.welcome.protocol).toBe(RELAY_PROTOCOL_VERSION);
  });

  it("signs the port it listens on, so a challenge relayed from another port fails verification", async () => {
    // A program on another port that relays the extension's connection to the real daemon
    const relayer = net.createServer((socket) => {
      const upstream = net.connect(relay.port, "127.0.0.1");
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) =>
      relayer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const relayed = await connect({
        port: (relayer.address() as net.AddressInfo).port,
      });
      expect(await relayed.verifyWelcome()).toBe(false);
      // The signature itself is the daemon's, over its own port
      relayed.port = relay.port;
      expect(await relayed.verifyWelcome()).toBe(true);
    } finally {
      for (const extension of extensions.splice(0)) {
        await extension.close();
      }
      relayer.close();
    }
  });

  it("asks for Allow, with the popup's code, while pairing is pending", async () => {
    const extension = await connect({ pairing: "pending" });
    const code = extension.code!;
    expect(code).toMatch(/^\d{3} \d{3}$/);
    // The popup's code, computed from the nonces the extension sent and checked against the commitment, is the one in the tool message
    await vi.waitUntil(() => relay.backend.unavailableReason()?.includes(code));
    expect(relay.backend.unavailableReason()).toBe(
      pairingRequiredMessage(code),
    );
    expect(relay.backend.unavailableReason()).toBe(
      `Click Allow in the Browser MCP extension's popup. The code is ${code}`,
    );
    expect(relay.backend.tabs()).toEqual([]);
    await expect(relay.backend.page(1)).rejects.toThrow(`The code is ${code}`);

    const states: BackendEvents["state"][] = [];
    relay.backend.on("state", (state) => states.push(state));
    extension.allow();
    await vi.waitUntil(() => states.at(-1)?.pairing === "paired");
    expect(relay.backend.unavailableReason()).toBeNull();
    expect(relay.backend.tabs().length).toBeGreaterThan(0);
  });

  it("commits to its nonce in the signed welcome, and reveals it only after the extension's nonce", async () => {
    const extension = await connect({
      pairing: "pending",
      pairingNonce: false,
    });
    expect(await extension.verifyWelcome()).toBe(true);
    expect(atob(extension.welcome.pairingCommitment)).toHaveLength(32);
    // Before the extension's nonce, still Allow, without a code
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(extension.daemonNonce).toBeNull();
    expect(relay.backend.unavailableReason()).toBe(pairingRequiredMessage());
    expect(relay.backend.unavailableReason()).not.toContain("code");

    await extension.exchangePairingNonces();
    await vi.waitUntil(() =>
      relay.backend.unavailableReason()?.includes(extension.code!),
    );
  });

  it("gives a fresh code on each connection", async () => {
    const first = await connect({ pairing: "pending" });
    await first.disconnect();
    const second = await connect({ pairing: "pending" });
    expect(second.welcome.publicKey).toBe(first.welcome.publicKey);
    expect(second.welcome.pairingCommitment).not.toBe(
      first.welcome.pairingCommitment,
    );
    expect(second.daemonNonce).not.toBe(first.daemonNonce);
    // Different nonces give another code (equal by chance one time in a million)
    expect(second.code).not.toBe(first.code);
    await vi.waitUntil(() =>
      relay.backend.unavailableReason()?.includes(second.code!),
    );
  });

  it("reveals its nonce once per connection, and closes a connection that sends another", async () => {
    const extension = await connect({ pairing: "pending" });
    extension.postRaw({ type: "pairingNonce", nonce: "another" });
    expect(await extension.closed).toEqual({
      code: 1008,
      reason: "Unexpected pairingNonce",
    });
  });

  it("closes an extension with an unsupported protocol and says to update it", async () => {
    await expect(connect({ protocol: 0 })).rejects.toThrow(
      `Closed ${RelayCloseCode.unsupportedProtocol} ${RelayUpdateReason.updateExtension}`,
    );
    expect(relay.backend.unavailableReason()).toBe(UPDATE_EXTENSION_MESSAGE);
  });

  it("keeps both browsers connected, with tab IDs of their own", async () => {
    const first = await connect();
    const second = await connect();
    expect(first.closed).toBeInstanceOf(Promise);
    expect(relay.backend.browsers().map((browser) => browser.id)).toEqual([
      "b1",
      "b2",
    ]);
    const firstTab = tabIdIn("b1", [...first.tabs.keys()][0]!);
    const secondTab = tabIdIn("b2", [...second.tabs.keys()][0]!);
    expect(firstTab).not.toBe(secondTab);
    // Each ID reaches only its own browser
    await relay.backend.activateTab(secondTab);
    expect(second.requests.at(-1)?.method).toBe("activateTab");
    expect(
      first.requests.some((request) => request.method === "activateTab"),
    ).toBe(false);
  });

  it("lets another browser connect while an agent uses a tab in the first", async () => {
    const first = await connect();
    const extensionTabId = [...first.tabs.keys()][0]!;
    await slot().bridge.claim(extensionTabId);
    const second = await connect();
    expect(relay.backend.browsers()).toHaveLength(2);
    expect(relay.backend.isClaimed(tabIdIn("b1", extensionTabId))).toBe(true);
    expect(first.requests.at(-1)?.method).toBe("attach");
    expect(second.requests.some((request) => request.method === "attach")).toBe(
      false,
    );
  });

  it("gives a browser its slot and tab IDs back when its service worker restarts", async () => {
    const first = await connect();
    const extensionTabId = [...first.tabs.keys()][0]!;
    const before = tabIdIn("b1", extensionTabId);
    await relay.backend.groupTab(before, {
      id: "claude-code",
      name: "Claude Code",
    });
    await first.disconnect();
    await vi.waitUntil(() => !relay.backend.connected);
    await connect();
    expect(relay.backend.browsers().map((browser) => browser.id)).toEqual([
      "b1",
    ]);
    expect(tabIdIn("b1", extensionTabId)).toBe(before);
    await expect(relay.backend.activateTab(before)).resolves.toBeUndefined();
  });

  it("counts a browser as in use while a tab an agent selected there is open, even unclaimed", async () => {
    const first = await connect();
    const tabId = tabIdIn("b1", [...first.tabs.keys()][0]!);
    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    expect(relay.backend.isClaimed(tabId)).toBe(false);
    expect(relay.backend.browsers()[0]?.inUse).toBe(true);
  });

  it("doesn't count tabs agents used once no session is open", async () => {
    await relay.close();
    relay = await startTestBackend({ hasSessions: () => false });
    const first = await connect();
    const tabId = tabIdIn("b1", [...first.tabs.keys()][0]!);
    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    expect(relay.backend.browsers()[0]?.inUse).toBe(false);
  });

  it("keeps another browser's tabs under IDs of their own", async () => {
    const app = { id: "claude-code", name: "Claude Code" };
    const first = await connect();
    const extensionTabId = [...first.tabs.keys()][0]!;
    const firstTab = tabIdIn("b1", extensionTabId);
    await relay.backend.groupTab(firstTab, app);

    // Another browser, whose tab with the same extension tab ID is another tab
    const second = await connect({ userAgent: "Another browser" });
    const secondTab = tabIdIn("b2", [...second.tabs.keys()][0]!);
    expect(secondTab).not.toBe(firstTab);
    await relay.backend.activateTab(secondTab);
    expect(second.requests.at(-1)?.method).toBe("activateTab");
    expect(
      first.requests.some((request) => request.method === "activateTab"),
    ).toBe(false);
  });

  it("refuses tabs the connected browser doesn't report", async () => {
    await connect();
    await expect(relay.backend.page(987_654)).rejects.toThrow(
      noSuchTabMessage(987_654),
    );
  });

  it("finds a tab a browser reports a moment after `tabOpened` names it", async () => {
    // The real extension sends `state` 100 ms after a change, but names an opened tab at once
    const extension = await connect({ stateDelayMs: 300 });
    const opener = [...extension.tabs.keys()][0]!;
    const opened = await extension.openTabFrom(opener, "about:blank");
    const tabId = await backendTabId(relay.backend, opened);
    expect(relay.backend.tabs().map((tab) => tab.tabId)).not.toContain(tabId);
    expect((await relay.backend.findTab(tabId))?.tabId).toBe(tabId);
  });

  it("doesn't find a tab no browser ever reports", async () => {
    await relay.close();
    relay = await startTestBackend({ unknownTabWaitMs: 100 });
    await connect();
    await expect(relay.backend.findTab(987_654)).resolves.toBeUndefined();
  });

  describe("off loopback", () => {
    // The daemon only has to believe it listens off loopback; the socket stays on 127.0.0.1
    const host = "10.1.2.3";

    it("refuses a browser whose key it doesn't know, naming the join token", async () => {
      await relay.close();
      relay = await startTestBackend({
        host,
        authorizeBrowser: ({ key, joinToken }) =>
          joinToken === "right" || key === "known"
            ? null
            : "Paste the join token into the extension's settings",
      });
      const extension = await connect();
      expect(await extension.closed).toMatchObject({
        code: RelayCloseCode.notAuthorized,
      });
      expect(relay.backend.connected).toBe(false);
      await vi.waitUntil(
        () =>
          relay.backend.unavailableReason() ===
          "Paste the join token into the extension's settings",
      );
    });

    it("accepts a browser that sends the join token, and checks its signature", async () => {
      const seen: { key: string; signature: string; challenge: string }[] = [];
      await relay.close();
      relay = await startTestBackend({
        host,
        authorizeBrowser: (auth) => {
          seen.push(auth);
          return verifyBrowserSignature(auth) && auth.joinToken === "right"
            ? null
            : "No";
        },
      });
      const extension = await connect({ joinToken: "right" });
      await vi.waitUntil(() => relay.backend.connected);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.key).toBe(extension.browserKey?.key);
      // The daemon signed the host as well as the port, so the extension can tell the two apart
      expect(extension.welcome.host).toBe(host);
      expect(extension.welcome.authChallenge).toEqual(expect.any(String));
    });

    it("closes a browser that never proves its key", async () => {
      await relay.close();
      relay = await startTestBackend({
        host,
        authTimeoutMs: 100,
        authorizeBrowser: () => null,
      });
      const extension = await connect({ browserAuth: false });
      expect(await extension.closed).toMatchObject({
        code: RelayCloseCode.notAuthorized,
      });
    });
  });

  it("times out requests the extension doesn't answer, forgetting them", async () => {
    await relay.close();
    relay = await startTestBackend({ requestTimeoutMs: 200 });
    const extension = await connect();
    extension.answering = false;
    const tabId = tabIdIn("b1", [...extension.tabs.keys()][0]!);
    await expect(relay.backend.activateTab(tabId)).rejects.toThrow(
      "The browser didn't answer activateTab in time",
    );
    expect(slot().connection.pendingCount).toBe(0);
    extension.answering = true;
  });

  it("forgets page waiters that timed out", async () => {
    await relay.close();
    relay = await startTestBackend({ pageTimeoutMs: 100 });
    await connect();
    const browser = slot();
    await expect(browser.waitForPage("missing", () => true)).rejects.toThrow(
      "didn't become ready",
    );
    expect(browser.pageWaiters.size).toBe(0);
  });

  it("stops waiting for a page once the browser dropped its target", async () => {
    await relay.close();
    // Long enough that only giving up on the dropped target can end the wait
    relay = await startTestBackend({ pageTimeoutMs: 30_000 });
    await connect();
    const started = Date.now();
    // A tab whose debugger detaches again while Playwright opens it (another extension's frame that comes back) would otherwise hang every later command
    await expect(slot().waitForPage("dropped", () => false)).rejects.toThrow(
      TAB_DETACHED_MESSAGE,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("waits for an extension that's expected back, then answers at once", async () => {
    await relay.close();
    relay = await startTestBackend({ reconnectGraceMs: 3000 });
    setTimeout(() => void connect(), 300);
    await relay.backend.whenReady();
    expect(relay.backend.unavailableReason()).toBeNull();

    await extensions.pop()!.close();
    await vi.waitUntil(() => !relay.backend.connected);
    const start = Date.now();
    await relay.backend.whenReady();
    expect(Date.now() - start).toBeGreaterThan(2000);
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    const again = Date.now();
    await relay.backend.whenReady();
    expect(Date.now() - again).toBeLessThan(100);
  });

  it("returns a new tab once the extension reports it", async () => {
    // The real extension sends `state` 100 ms after a change, after answering `createTab`
    await connect({ stateDelayMs: 150 });
    const tabId = await relay.backend.createTab({
      app: { id: "claude-code", name: "Claude Code" },
    });
    expect(relay.backend.tabs().map((tab) => tab.tabId)).toContain(tabId);
  });

  it("returns from closing a tab once the extension no longer reports it", async () => {
    await connect({ stateDelayMs: 150 });
    const tabId = await relay.backend.createTab({
      app: { id: "claude-code", name: "Claude Code" },
    });
    await relay.backend.closeTab(tabId);
    expect(relay.backend.tabs().map((tab) => tab.tabId)).not.toContain(tabId);
  });

  it("forwards tab events and requests", async () => {
    const extension = await connect();
    const assigned: BackendEvents["tabAssigned"][] = [];
    relay.backend.on("tabAssigned", (event) => assigned.push(event));
    const extensionTabId = [...extension.tabs.keys()][0]!;
    const tabId = tabIdIn("b1", extensionTabId);
    extension.assign(extensionTabId, "cursor");
    await vi.waitUntil(() => assigned.length === 1);
    expect(assigned[0]).toEqual({ tabId, appId: "cursor" });

    await relay.backend.groupTab(tabId, {
      id: "claude-code",
      name: "Claude Code",
    });
    expect(extension.tabs.get(tabId)?.appId).toBe("claude-code");
    relay.backend.noteActivity("claude-code");
    await vi.waitUntil(() =>
      extension.requests.some((request) => request.method === "activity"),
    );
  });
});
