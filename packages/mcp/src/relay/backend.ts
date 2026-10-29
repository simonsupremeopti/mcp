import type { CDPSession, Page } from "playwright-core";
import type { WebSocket } from "ws";

import {
  NO_EXTENSION_MESSAGE,
  RelayCloseCode,
  RelayUpdateReason,
  pairingRequiredMessage,
} from "@browsermcp/protocol";

import type {
  AppInfo,
  BackendEvents,
  BackendTab,
  BrowserBackend,
  BrowserSummary,
} from "@/contracts";
import { BrowserSlot } from "@/relay/browser-slot";
import {
  ExtensionConnection,
  type ExtensionConnectionOptions,
  ExtensionProtocolError,
} from "@/relay/extension-connection";
import {
  ANOTHER_BROWSER_MESSAGE,
  noSuchBrowserMessage,
  noSuchTabMessage,
  PAUSED_MESSAGE,
  UPDATE_EXTENSION_MESSAGE,
  UPDATE_SERVER_MESSAGE,
  rejectedExtensionMessage,
} from "@/relay/messages";
import type { Logger } from "@/utils/log";

export type RelayBackendOptions = Omit<
  ExtensionConnectionOptions,
  "log" | "daemonVersion" | "port"
> & {
  daemonVersion: string;
  log: Logger;
  /** Whether any session (thin process) is open: tabs agents used count as in use only while one is. Default: always */
  hasSessions?: () => boolean;
  /** How long `page()` waits for Playwright to see a claimed tab */
  pageTimeoutMs?: number;
  /** How long after the daemon starts, or the last browser disconnects, `whenReady()` waits for one to (re)connect. The extension retries every 1–5 s */
  reconnectGraceMs?: number;
  reattachDelayMs?: number;
  /** How long `findTab()` and `page()` wait for the extension to report a tab it doesn't list yet (1 s) */
  unknownTabWaitMs?: number;
};

type Listeners = {
  [E in keyof BackendEvents]: Set<(data: BackendEvents[E]) => void>;
};

/** What tells browsers apart: the user agent, and the windows they report (window IDs are unique within a browser process, across its profiles) */
type BrowserIdentity = {
  name: string;
  userAgent: string;
  windowIds: Set<number>;
};

function browserOf(connection: ExtensionConnection): BrowserIdentity {
  return {
    name: connection.hello.browser.name,
    userAgent: connection.hello.browser.userAgent,
    windowIds: new Set(connection.state.tabs.map((tab) => tab.windowId)),
  };
}

/** Whether two connections come from the same browser, or `undefined` when that can't be told (one reports no tabs, e.g. while it waits for **Allow**) */
function sameBrowser(
  a: BrowserIdentity,
  b: BrowserIdentity,
): boolean | undefined {
  if (a.name !== b.name || a.userAgent !== b.userAgent) {
    return false;
  }
  if (a.windowIds.size === 0 || b.windowIds.size === 0) {
    return undefined;
  }
  return [...a.windowIds].some((id) => b.windowIds.has(id));
}

/** How long a refused extension is named in `unavailableReason()`: it retries every 1–5 s */
const REJECTED_EXTENSION_MS = 30_000;

/** How many disconnected browsers are remembered, so a restarted service worker is recognised as the same browser */
const RECENT_BROWSERS = 10;

/**
 * `BrowserBackend` over the relay: every connected browser gets a `BrowserSlot` of its own (its extension connection, its CDP bridge and its Playwright `connectOverCDP`), and the backend hands the engine tab IDs that are unique across them all, so the engine keeps addressing tabs by a single number
 */
export class RelayBackend implements BrowserBackend {
  private slots = new Map<string, BrowserSlot>();
  private nextSlotId = 1;
  /** Why the last extension couldn't connect, for `unavailableReason()` */
  private lastProblem: "update-extension" | "update-server" | null = null;
  /** The last extension `/extension` refused by Origin, until one connects: `unavailableReason()` names it, since the extension only retries */
  private rejectedExtension: { id: string | undefined; at: number } | null =
    null;
  private cdpUrl: string | null = null;
  /** When the daemon started or the last browser disconnected: a browser is expected back soon after */
  private expectedSince = Date.now();
  private closing = false;
  /** Browsers that disconnected, to tell whether one that connects is the same (its service worker restarted) or another */
  private recent: {
    id: string;
    browser: BrowserIdentity;
    agentTabs: Set<number>;
  }[] = [];
  /** The tab IDs the engine sees: unique across browsers, since `chrome.debugger` tab IDs only mean something within one */
  private tabRefs = new Map<number, { slotId: string; tabId: number }>();
  private tabIds = new Map<string, number>();
  private nextTabId = 1;
  private readonly listeners = {
    state: new Set(),
    tabAssigned: new Set(),
    tabOpened: new Set(),
    released: new Set(),
    connection: new Set(),
  } as Listeners;

  constructor(private readonly options: RelayBackendOptions) {}

  /** Where Playwright connects: the relay's `/cdp?token=…`, known once the relay listens. Each browser gets `&browser=<id>` on top */
  setCdpUrl(url: string) {
    this.cdpUrl = url;
  }

  // --- Connections from the relay server ---

  /**
   * An extension on `/extension` (`port`: the port it dialed): hello/welcome, then it joins the connected browsers. A browser whose service worker restarted takes its slot back, keeping the tab IDs the engine already knows
   */
  async acceptExtension(ws: WebSocket, port: number): Promise<void> {
    const { log } = this.options;
    this.rejectedExtension = null;
    let connection: ExtensionConnection;
    try {
      connection = await ExtensionConnection.accept(ws, {
        ...this.options,
        log,
        port,
      });
    } catch (error) {
      if (error instanceof ExtensionProtocolError) {
        this.lastProblem = "update-extension";
      }
      log("Extension handshake failed:", error);
      return;
    }
    if (this.closing) {
      connection.close(RelayCloseCode.shuttingDown, "The daemon is exiting");
      return;
    }
    if (!connection.open) {
      return;
    }
    this.adopt(connection);
  }

  /** A Playwright connection on `/cdp`, for the browser named by `browser=<id>` (the only one when unnamed) */
  acceptCdp(ws: WebSocket, browserId?: string) {
    const slot = browserId
      ? this.slots.get(browserId)
      : [...this.slots.values()][0];
    if (!slot) {
      ws.close(1008, "No such browser");
      return;
    }
    slot.bridge.attachClient(ws);
  }

  private adopt(connection: ExtensionConnection) {
    const { hello } = connection;
    const browser = browserOf(connection);
    // The same browser back (its service worker restarted) keeps its slot, so the tab IDs the engine knows still name its tabs
    const index = this.recent.findIndex(
      (other) => sameBrowser(other.browser, browser) === true,
    );
    const returning =
      index >= 0
        ? this.recent.splice(index, 1)[0]
        : this.recentUnknownMatch(browser);
    const id = returning?.id ?? `b${this.nextSlotId++}`;
    this.options.log(
      `Extension ${hello.extensionVersion} connected from ${hello.browser.name} ${hello.browser.version} as ${id} (protocol ${hello.protocol}, pairing ${hello.state.pairing})`,
    );
    const slot = new BrowserSlot(id, connection, {
      log: this.options.log,
      cdpUrl: () => (this.cdpUrl ? `${this.cdpUrl}&browser=${id}` : null),
      onReleased: (tabId, reason) =>
        this.emit("released", { tabId: this.tabIdOf(slot, tabId), reason }),
      reattachDelayMs: this.options.reattachDelayMs,
      pageTimeoutMs: this.options.pageTimeoutMs,
    });
    if (returning) {
      slot.agentTabs = returning.agentTabs;
    }
    this.slots.set(id, slot);
    this.lastProblem = null;
    connection.onEvent((event) => {
      if (this.slots.get(id) !== slot) {
        return;
      }
      slot.bridge.onExtensionEvent(event);
      switch (event.type) {
        case "state":
          slot.stateReceived = true;
          if (event.data.pairing === "paired") {
            slot.pruneClosedTabs(event.data.tabs.map((tab) => tab.tabId));
          }
          this.emitState();
          return;
        case "tabAssigned":
          if (event.data.appId) {
            slot.agentTabs.add(event.data.tabId);
          } else {
            slot.agentTabs.delete(event.data.tabId);
          }
          this.emit("tabAssigned", {
            tabId: this.tabIdOf(slot, event.data.tabId),
            appId: event.data.appId,
          });
          return;
        case "tabOpened":
          this.emit("tabOpened", {
            tabId: this.tabIdOf(slot, event.data.tabId),
            openerTabId: this.tabIdOf(slot, event.data.openerTabId),
            url: event.data.url,
          });
          return;
      }
    });
    connection.onClose((code, reason) => {
      this.options.log(`Browser ${id} disconnected (${code} ${reason})`);
      if (
        code === RelayCloseCode.unsupportedProtocol &&
        reason === RelayUpdateReason.updateServer
      ) {
        this.lastProblem = "update-server";
      }
      if (this.slots.get(id) !== slot) {
        return;
      }
      this.slots.delete(id);
      // Browsers that fall out of `recent` won't be recognised again, so their tab IDs are dead weight
      for (const forgotten of this.recent.slice(0, -(RECENT_BROWSERS - 1))) {
        this.forgetTabIds(forgotten.id);
      }
      this.recent = [
        ...this.recent.slice(-(RECENT_BROWSERS - 1)),
        { id, browser: browserOf(connection), agentTabs: slot.agentTabs },
      ];
      if (this.slots.size === 0) {
        this.expectedSince = Date.now();
      }
      slot.bridge.releaseAll("disconnected");
      void slot.close();
      this.emit("connection", { connected: this.slots.size > 0 });
      this.emitState();
    });
    this.emit("connection", { connected: true });
    this.emitState();
  }

  /** A browser that reports no tabs yet (it's waiting for **Allow**) matched against the one browser of its kind that went away */
  private recentUnknownMatch(browser: BrowserIdentity) {
    const candidates = this.recent.filter(
      (other) => sameBrowser(other.browser, browser) === undefined,
    );
    if (candidates.length !== 1) {
      return undefined;
    }
    this.recent = this.recent.filter((other) => other !== candidates[0]);
    return candidates[0];
  }

  // --- BrowserBackend ---

  get connected(): boolean {
    return this.slots.size > 0;
  }

  /** Every connected browser is paused: a paused one doesn't stop agents using the others */
  get paused(): boolean {
    const slots = [...this.slots.values()];
    return (
      slots.length > 0 && slots.every((slot) => slot.connection.state.paused)
    );
  }

  /** The connected browsers, for `browser list` */
  browsers(): BrowserSummary[] {
    const countAgentTabs =
      !this.options.hasSessions || this.options.hasSessions();
    return [...this.slots.values()].map((slot) => ({
      id: slot.id,
      name: slot.connection.hello.browser.name,
      version: slot.connection.hello.browser.version,
      tabs: slot.tabs().length,
      paused: slot.connection.state.paused,
      pairing: slot.connection.state.pairing,
      inUse: slot.inUse(countAgentTabs),
    }));
  }

  /** `/extension` refused a connection by its Origin (`id` is undefined unless it was a `chrome-extension://` ID) */
  noteRejectedExtension(id: string | undefined) {
    this.rejectedExtension = { id, at: Date.now() };
  }

  unavailableReason(): string | null {
    const slots = [...this.slots.values()];
    if (slots.length === 0) {
      if (
        this.rejectedExtension?.id &&
        Date.now() - this.rejectedExtension.at < REJECTED_EXTENSION_MS
      ) {
        return rejectedExtensionMessage(this.rejectedExtension.id);
      }
      if (this.lastProblem === "update-extension") {
        return UPDATE_EXTENSION_MESSAGE;
      }
      if (this.lastProblem === "update-server") {
        return UPDATE_SERVER_MESSAGE;
      }
      return NO_EXTENSION_MESSAGE;
    }
    // One browser waiting for **Allow** doesn't stop agents using another that's paired
    const pending = slots.filter(
      (slot) => slot.connection.state.pairing === "pending",
    );
    if (pending.length === slots.length) {
      return pairingRequiredMessage(
        pending[0]!.connection.pairingCode ?? undefined,
      );
    }
    return null;
  }

  async whenReady(): Promise<void> {
    const connectBy =
      this.expectedSince + (this.options.reconnectGraceMs ?? 10_000);
    // After connecting, the extension sends its state as soon as it checked the daemon's key
    const stateBy = Date.now() + 2000;
    for (;;) {
      const slots = [...this.slots.values()];
      if (slots.length > 0) {
        if (slots.some((slot) => slot.stateReceived) || Date.now() >= stateBy) {
          return;
        }
      } else if (Date.now() >= connectBy) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Every connected browser's tabs, with IDs that are unique across them */
  tabs(): BackendTab[] {
    return [...this.slots.values()].flatMap((slot) =>
      slot.tabs().map((tab) => ({
        ...tab,
        tabId: this.tabIdOf(slot, tab.tabId),
        browser: slot.id,
      })),
    );
  }

  /** The tab with this ID, waiting (briefly) for a browser to report one it doesn't list yet: it reports a new tab a moment after it appears, though `tabOpened` already named it */
  async findTab(tabId: number): Promise<BackendTab | undefined> {
    const find = () => this.tabs().find((tab) => tab.tabId === tabId);
    const found = find();
    if (found) {
      return found;
    }
    const ref = this.resolve(tabId);
    if (!ref) {
      return undefined;
    }
    await this.waitForTab(
      ref.slot,
      ref.tab,
      this.options.unknownTabWaitMs ?? 1000,
    );
    return find();
  }

  async createTab(options: {
    url?: string;
    app: AppInfo;
    /** Which browser to open it in (`browser list`); the first usable one by default */
    browser?: string;
  }): Promise<number> {
    const slot = this.usableSlot(options.browser);
    const { tabId } = await slot.connection.request("createTab", {
      url: options.url,
      app: options.app,
    });
    slot.agentTabs.add(tabId);
    // The extension reports the new tab in its next `state` (debounced), after answering. Until then the engine would take it for a closed tab
    await this.waitForTab(slot, tabId);
    return this.tabIdOf(slot, tabId);
  }

  async closeTab(tabId: number): Promise<void> {
    const { slot, tab } = this.usableTab(tabId);
    await slot.bridge.release(tab);
    slot.agentTabs.delete(tab);
    await slot.connection.request("closeTab", { tabId: tab });
    // As with `createTab`: until the next `state`, the tab would still be listed
    await this.waitForTab(slot, tab, 3000, false);
  }

  async activateTab(tabId: number): Promise<void> {
    const { slot, tab } = this.usableTab(tabId);
    await slot.connection.request("activateTab", { tabId: tab });
  }

  async groupTab(tabId: number, app: AppInfo | null): Promise<void> {
    const { slot, tab } = this.usableTab(tabId);
    await slot.connection.request("groupTab", { tabId: tab, app });
    if (this.slots.get(slot.id) !== slot) {
      return;
    }
    if (app) {
      slot.agentTabs.add(tab);
    } else {
      slot.agentTabs.delete(tab);
    }
  }

  noteActivity(appId: string): void {
    for (const slot of this.slots.values()) {
      slot.connection.send("activity", { appId }, () => {});
    }
  }

  /** Claims a tab: one its browser reports (waiting briefly for a tab it hasn't reported yet) */
  async page(tabId: number): Promise<Page> {
    const { slot, tab } = this.usableTab(tabId);
    if (!slot.tabs().some((other) => other.tabId === tab)) {
      await this.waitForTab(slot, tab, this.options.unknownTabWaitMs ?? 1000);
      if (this.slots.get(slot.id) !== slot) {
        throw new Error(ANOTHER_BROWSER_MESSAGE);
      }
      if (!slot.tabs().some((other) => other.tabId === tab)) {
        throw new Error(noSuchTabMessage(tabId));
      }
    }
    slot.agentTabs.add(tab);
    const targetInfo = await slot.bridge.claim(tab);
    if (this.slots.get(slot.id) !== slot) {
      throw new Error(ANOTHER_BROWSER_MESSAGE);
    }
    return await slot.pageForTarget(targetInfo.targetId);
  }

  async cdpSession(tabId: number): Promise<CDPSession> {
    const page = await this.page(tabId);
    return await page.context().newCDPSession(page);
  }

  async release(tabId: number): Promise<void> {
    const found = this.resolve(tabId);
    await found?.slot.bridge.release(found.tab);
  }

  isClaimed(tabId: number): boolean {
    const found = this.resolve(tabId);
    return found?.slot.bridge.isClaimed(found.tab) ?? false;
  }

  on<E extends keyof BackendEvents>(
    event: E,
    listener: (data: BackendEvents[E]) => void,
  ): () => void {
    const listeners = this.listeners[event] as Set<
      (data: BackendEvents[E]) => void
    >;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Disconnects Playwright and the extensions (which reconnect to the next daemon) */
  async close(): Promise<void> {
    this.closing = true;
    // A snapshot: closing a connection takes its slot out of the map
    const slots = [...this.slots.values()];
    for (const slot of slots) {
      await slot.close();
      slot.connection.close(
        RelayCloseCode.shuttingDown,
        "The daemon is exiting",
      );
    }
  }

  // --- Internals ---

  private emit<E extends keyof BackendEvents>(
    event: E,
    data: BackendEvents[E],
  ) {
    for (const listener of this.listeners[event] as Set<
      (data: BackendEvents[E]) => void
    >) {
      try {
        listener(data);
      } catch (error) {
        this.options.log(`Error in a ${event} listener:`, error);
      }
    }
  }

  private emitState() {
    const slots = [...this.slots.values()];
    this.emit("state", {
      tabs: this.tabs(),
      paused: this.paused,
      pairing: slots.some((slot) => slot.connection.state.pairing === "paired")
        ? "paired"
        : "pending",
    });
  }

  /** The engine's ID for one of a browser's tabs, allocated on first sight and kept while that browser keeps its slot */
  private tabIdOf(slot: BrowserSlot, tabId: number): number {
    const key = `${slot.id}:${tabId}`;
    const existing = this.tabIds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextTabId++;
    this.tabIds.set(key, id);
    this.tabRefs.set(id, { slotId: slot.id, tabId });
    return id;
  }

  private forgetTabIds(slotId: string) {
    const prefix = `${slotId}:`;
    for (const [key, id] of this.tabIds) {
      if (key.startsWith(prefix)) {
        this.tabIds.delete(key);
        this.tabRefs.delete(id);
      }
    }
  }

  private resolve(tabId: number): { slot: BrowserSlot; tab: number } | null {
    const ref = this.tabRefs.get(tabId);
    const slot = ref && this.slots.get(ref.slotId);
    return slot ? { slot, tab: ref.tabId } : null;
  }

  /** The browser a tab belongs to, or throws the message the model should see */
  private usableTab(tabId: number): { slot: BrowserSlot; tab: number } {
    const found = this.resolve(tabId);
    if (!found) {
      const reason = this.unavailableReason();
      throw new Error(reason ?? noSuchTabMessage(tabId));
    }
    if (found.slot.connection.state.pairing === "pending") {
      throw new Error(
        pairingRequiredMessage(found.slot.connection.pairingCode ?? undefined),
      );
    }
    if (found.slot.connection.state.paused) {
      throw new Error(PAUSED_MESSAGE);
    }
    return found;
  }

  /** The browser to act on when no tab names one, or throws the message the model should see */
  private usableSlot(browserId?: string): BrowserSlot {
    if (browserId) {
      const slot = this.slots.get(browserId);
      if (!slot) {
        throw new Error(noSuchBrowserMessage(browserId));
      }
      if (slot.connection.state.paused) {
        throw new Error(PAUSED_MESSAGE);
      }
      return slot;
    }
    const reason = this.unavailableReason();
    if (reason) {
      throw new Error(reason);
    }
    const usable = [...this.slots.values()].find(
      (slot) =>
        slot.connection.state.pairing === "paired" &&
        !slot.connection.state.paused,
    );
    if (!usable) {
      throw new Error(this.paused ? PAUSED_MESSAGE : NO_EXTENSION_MESSAGE);
    }
    return usable;
  }

  /** Waits (briefly) until the browser reports the tab, or with `reported: false`, until it no longer does */
  private waitForTab(
    slot: BrowserSlot,
    tabId: number,
    timeoutMs = 3000,
    reported = true,
  ): Promise<void> {
    const settled = () =>
      slot.tabs().some((tab) => tab.tabId === tabId) === reported;
    if (settled()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        off();
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      const off = this.on("state", () => {
        if (settled()) {
          done();
        }
      });
    });
  }
}
