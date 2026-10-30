import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";

import { CdpBridge } from "@/relay/bridge";
import type { ExtensionConnection } from "@/relay/extension-connection";
import { TAB_DETACHED_MESSAGE } from "@/relay/messages";
import type { Logger } from "@/utils/log";

export type BrowserSlotOptions = {
  log: Logger;
  /** Where Playwright connects for this browser: the relay's `/cdp?token=…&browser=<id>`, known once the relay listens */
  cdpUrl: () => string | null;
  /** A claimed tab of this browser went away by something other than `release()` */
  onReleased(tabId: number, reason: string): void;
  reattachDelayMs?: number;
  /** How long `page()` waits for Playwright to see a claimed tab */
  pageTimeoutMs?: number;
};

/**
 * One connected browser: its extension connection, its own CDP bridge and its own Playwright `connectOverCDP`.
 *
 * A bridge serves exactly one browser. Its state is keyed by `chrome.debugger` tab IDs, which only mean something within a browser; `Browser.getVersion` answers for one browser; and browser-level CDP commands (`bridge.ts`, the fallback at the end of `onRootCommand`) go through an arbitrary claimed tab, with nothing at the CDP root to say which browser was meant. So each connection gets a bridge, a Playwright `Browser` and a page map of its own.
 */
export class BrowserSlot {
  readonly bridge: CdpBridge;
  /** Tabs agents used in this browser (opened, selected, claimed, or dragged into an app's group) and that are still open */
  agentTabs = new Set<number>();
  /** Tab IDs agents used in a browser this one replaced: here the same IDs are other tabs, so they're refused until an agent selects them again */
  foreignTabs = new Set<number>();
  /** The connection has sent `state` since `hello` (whose state is always `pending`, before the daemon proves its key) */
  stateReceived = false;

  private browserPromise: Promise<Browser> | null = null;
  private pages = new Map<string, Page>();
  private pageWaiters = new Map<string, Set<(page: Page) => void>>();
  /** Cleared when the connection closes, so the bridge refuses commands as it does for a browser that went away */
  private live = true;

  constructor(
    readonly id: string,
    readonly connection: ExtensionConnection,
    private readonly options: BrowserSlotOptions,
  ) {
    this.bridge = new CdpBridge({
      log: options.log,
      extension: () => (this.live ? this.connection : null),
      onReleased: options.onReleased,
      reattachDelayMs: options.reattachDelayMs,
    });
  }

  get open(): boolean {
    return this.live && this.connection.open;
  }

  /** The tabs the extension reports */
  tabs() {
    return this.connection.state.tabs;
  }

  /** Whether an agent is using this browser: a tab is claimed, or a tab agents used is still open */
  inUse(countAgentTabs: boolean): boolean {
    if (this.bridge.claimedTabs().length > 0) {
      return true;
    }
    if (!countAgentTabs) {
      return false;
    }
    const open = new Set(this.tabs().map((tab) => tab.tabId));
    return [...this.agentTabs].some((tabId) => open.has(tabId));
  }

  /** Forgets tab IDs that are no longer open, once the extension reports a paired state */
  pruneClosedTabs(openTabIds: Iterable<number>) {
    const open = new Set(openTabIds);
    for (const tabs of [this.agentTabs, this.foreignTabs]) {
      for (const tabId of tabs) {
        if (!open.has(tabId)) {
          tabs.delete(tabId);
        }
      }
    }
  }

  /**
   * The Page of a claimed tab's target, connecting Playwright to this browser's bridge if it isn't yet.
   *
   * `stillClaimed` says whether the bridge still has the target. A page whose debugger detaches while Playwright is opening it (another extension's frame that comes back, say) leaves a Page that's already disposed, so the target ID is never read and no Page ever arrives: without this the wait would time out on every command from then on
   */
  async pageForTarget(
    targetId: string,
    stillClaimed: () => boolean = () => true,
  ): Promise<Page> {
    await this.browser();
    return await this.waitForPage(targetId, stillClaimed);
  }

  /** Disconnects Playwright from this browser. The extension connection is closed by the backend */
  async close(): Promise<void> {
    this.live = false;
    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => {});
    this.pages.clear();
  }

  private browser(): Promise<Browser> {
    if (!this.browserPromise) {
      const url = this.options.cdpUrl();
      if (!url) {
        return Promise.reject(new Error("The relay isn't listening yet"));
      }
      // `noDefaults`: Playwright's default overrides (focus emulation, media emulation, downloads) stay off the user's tabs; the engine turns focus emulation on itself for the tabs it claims (`hiddenTabs`)
      const promise = chromium
        .connectOverCDP(url, { noDefaults: true })
        .then((browser) => {
          browser.on("disconnected", () => {
            if (this.browserPromise === promise) {
              this.browserPromise = null;
            }
            this.pages.clear();
          });
          for (const context of browser.contexts()) {
            this.watchContext(context);
          }
          return browser;
        });
      promise.catch(() => {
        if (this.browserPromise === promise) {
          this.browserPromise = null;
        }
      });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  private watchContext(context: BrowserContext) {
    context.on("page", (page) => void this.identify(page));
    for (const page of context.pages()) {
      void this.identify(page);
    }
  }

  /** Reads a new Page's target ID (the bridge answers `Target.getTargetInfo` itself) */
  private async identify(page: Page) {
    let targetId: string;
    try {
      targetId = await this.targetIdOf(page);
    } catch (error) {
      if (!page.isClosed()) {
        this.options.log("Couldn't identify a page:", error);
      }
      return;
    }
    if (page.isClosed()) {
      return;
    }
    this.pages.set(targetId, page);
    page.on("close", () => {
      if (this.pages.get(targetId) === page) {
        this.pages.delete(targetId);
      }
    });
    for (const resolve of this.pageWaiters.get(targetId) ?? []) {
      resolve(page);
    }
    this.pageWaiters.delete(targetId);
  }

  /** A new Page's target ID, read through a short-lived CDP session (the bridge answers `Target.getTargetInfo`) */
  private async targetIdOf(page: Page): Promise<string> {
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private waitForPage(
    targetId: string,
    stillClaimed: () => boolean,
  ): Promise<Page> {
    const page = this.pages.get(targetId);
    if (page && !page.isClosed()) {
      return Promise.resolve(page);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.pageWaiters.get(targetId) ?? new Set();
      this.pageWaiters.set(targetId, waiters);
      const done = () => {
        clearTimeout(timeout);
        clearInterval(dropped);
        waiters.delete(waiter);
        if (waiters.size === 0 && this.pageWaiters.get(targetId) === waiters) {
          this.pageWaiters.delete(targetId);
        }
      };
      const waiter = (page: Page) => {
        done();
        resolve(page);
      };
      const timeout = setTimeout(() => {
        done();
        reject(new Error("The tab didn't become ready in time"));
      }, this.options.pageTimeoutMs ?? 15_000);
      // The debugger detached again before Playwright finished opening the page: waiting the whole timeout would only repeat on the next command
      const dropped = setInterval(() => {
        if (!stillClaimed()) {
          done();
          reject(new Error(TAB_DETACHED_MESSAGE));
        }
      }, 100);
      waiters.add(waiter);
    });
  }
}
