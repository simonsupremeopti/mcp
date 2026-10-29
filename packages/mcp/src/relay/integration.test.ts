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

import { NO_EXTENSION_MESSAGE } from "@browsermcp/protocol";

import { createCommandEngine } from "@/commands/engine";
import type { BackendEvents } from "@/contracts";
import { PAUSED_MESSAGE } from "@/relay/messages";
import { FakeChromium, FakeExtension } from "@/testing/fake-extension";
import { startFixtureServer } from "@/testing/fixture-server";
import {
  backendTabId,
  extensionTabId,
  startTestBackend,
} from "@/testing/test-backend";

// Real Playwright through the bridge, with real headless Chromium standing in for the extension
let chromium: FakeChromium;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>>;
let relay: Awaited<ReturnType<typeof startTestBackend>>;
let extension: FakeExtension;
let released: BackendEvents["released"][];

beforeAll(async () => {
  chromium = await FakeChromium.launch();
  fixtures = await startFixtureServer({
    "/": `<title>Home</title><h1>Home</h1><a href="/form">Form</a>`,
    "/form": `<title>Form</title>
      <label>Name <input id="name"></label>
      <button onclick="document.querySelector('#out').textContent = 'Hi ' + document.querySelector('#name').value">Greet</button>
      <p id="out"></p>
      <img src="/missing.png">`,
    "/frame": `<title>Frame</title><button onclick="this.textContent = 'clicked'">Inside</button>`,
  });
  fixtures.url("/");
}, 60_000);

afterAll(async () => {
  await fixtures?.close();
  await chromium?.close();
});

beforeEach(async () => {
  relay = await startTestBackend({ reattachDelayMs: 50 });
  released = [];
  relay.backend.on("released", (event) => released.push(event));
  extension = await FakeExtension.connect({ port: relay.port, chromium });
});

afterEach(async () => {
  await extension?.close();
  await relay?.close();
});

describe("the bridge with Playwright", () => {
  it("drives a tab: goto, fill, click, evaluate", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const page = await relay.backend.page(tabId);
    expect(relay.backend.isClaimed(tabId)).toBe(true);
    expect(await page.title()).toBe("Home");

    await page.goto(fixtures.url("/form"));
    await page.getByLabel("Name").fill("Jane");
    await page.getByRole("button", { name: "Greet" }).click();
    expect(await page.locator("#out").textContent()).toBe("Hi Jane");
    expect(await page.evaluate(() => 6 * 7)).toBe(42);
    // The same Page while the tab stays claimed
    expect(await relay.backend.page(tabId)).toBe(page);
    // Only claimed tabs are targets
    expect(page.context().pages()).toHaveLength(1);
  });

  it("works in cross-site (out-of-process) iframes", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const page = await relay.backend.page(tabId);
    await page.setContent(
      `<iframe src="${fixtures.crossSiteUrl("/frame")}"></iframe>`,
    );
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "Inside" }).click();
    await expect
      .poll(() => frame.getByRole("button").textContent())
      .toBe("clicked");
  });

  it("opens agents' tabs with createTab and closes them", async () => {
    const tabId = await relay.backend.createTab({
      url: fixtures.url("/form"),
      app: { id: "claude-code", name: "Claude Code" },
    });
    expect(
      extension.tabs.get(extensionTabId(relay.backend, tabId))?.appId,
    ).toBe("claude-code");
    // createTab doesn't attach the debugger
    expect(relay.backend.isClaimed(tabId)).toBe(false);
    expect(
      extension.requests.some((request) => request.method === "attach"),
    ).toBe(false);

    const page = await relay.backend.page(tabId);
    await expect.poll(() => page.title()).toBe("Form");
    await relay.backend.closeTab(tabId);
    const closed = extensionTabId(relay.backend, tabId);
    await vi.waitUntil(() => !extension.tabs.has(closed));
    expect(page.isClosed()).toBe(true);
  });

  it("releases and re-claims a tab", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const first = await relay.backend.page(tabId);
    await relay.backend.release(tabId);
    expect(relay.backend.isClaimed(tabId)).toBe(false);
    await vi.waitUntil(() => first.isClosed());
    expect(
      extension.tabs.get(extensionTabId(relay.backend, tabId))?.sessionId,
    ).toBeUndefined();
    expect(released).toEqual([]);

    const second = await relay.backend.page(tabId);
    expect(second).not.toBe(first);
    expect(await second.title()).toBe("Home");
  });

  it("keeps Playwright's network events when a raw CDP session disables Network", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const page = await relay.backend.page(tabId);
    const session = await relay.backend.cdpSession(tabId);
    await session.send("Network.enable");
    await session.send("Runtime.enable");
    await session.send("Network.disable");
    await session.send("Runtime.disable");

    const response = page.waitForResponse((response) =>
      response.url().endsWith("/form"),
    );
    await page.goto(fixtures.url("/form"));
    expect((await response).status()).toBe(200);
    expect(await page.evaluate(() => document.title)).toBe("Form");

    // The raw session works too, and detaching it leaves Playwright's alone
    const { result } = await session.send("Runtime.evaluate", {
      expression: "1 + 1",
    });
    expect(result.value).toBe(2);
    await session.detach();
    expect(await page.title()).toBe("Form");
  });

  it("re-attaches after the debugger detaches for another reason", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const first = await relay.backend.page(tabId);
    // As Chrome does when a navigation swaps the renderer
    const tab = extension.tabs.get(extensionTabId(relay.backend, tabId))!;
    await chromium.send("Target.detachFromTarget", {
      sessionId: tab.sessionId,
    });
    await vi.waitUntil(() => first.isClosed());
    const second = await relay.backend.page(tabId);
    expect(await second.title()).toBe("Home");
    expect(released).toEqual([]);
  });

  it("stops on Cancel (canceled_by_user) and while paused", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const page = await relay.backend.page(tabId);
    await extension.cancel();
    await vi.waitUntil(() => relay.backend.paused);
    expect(released).toContainEqual({ tabId, reason: "canceled_by_user" });
    await vi.waitUntil(() => page.isClosed());
    await expect(relay.backend.page(tabId)).rejects.toThrow(PAUSED_MESSAGE);

    await extension.pause(false);
    await vi.waitUntil(() => !relay.backend.paused);
    const again = await relay.backend.page(tabId);
    expect(await again.title()).toBe("Home");
  });

  it("releases every tab when the extension disconnects", async () => {
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    const page = await relay.backend.page(tabId);
    await extension.disconnect();
    await vi.waitUntil(() => !relay.backend.connected);
    expect(released).toContainEqual({ tabId, reason: "disconnected" });
    expect(relay.backend.unavailableReason()).toBe(NO_EXTENSION_MESSAGE);
    await vi.waitUntil(() => page.isClosed());

    // Reconnecting (e.g. after a service-worker restart) works again
    extension = await FakeExtension.connect({ port: relay.port, chromium });
    const again = await relay.backend.page(tabId);
    expect(await again.title()).toBe("Home");
  });

  it("reports tab state and pages that open tabs", async () => {
    const states: BackendEvents["state"][] = [];
    const opened: BackendEvents["tabOpened"][] = [];
    relay.backend.on("state", (state) => states.push(state));
    relay.backend.on("tabOpened", (event) => opened.push(event));
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    await vi.waitUntil(() =>
      relay.backend.tabs().some((tab) => tab.tabId === tabId),
    );
    const page = await relay.backend.page(tabId);
    await page.evaluate((url) => window.open(url), fixtures.url("/form"));
    await vi.waitUntil(() => opened.length > 0);
    expect(opened[0]).toMatchObject({ openerTabId: tabId });
    expect(states.at(-1)?.pairing).toBe("paired");
  });
});

describe("the engine through the relay", () => {
  it("keeps a session's tab while the extension reconnects (its service worker restarting)", async () => {
    const engine = createCommandEngine({ backend: relay.backend });
    const io = {
      readFile: () => Promise.reject(new Error("no files")),
      writeFile: () => Promise.reject(new Error("no files")),
    };
    engine.openSession({
      id: "s1",
      app: { id: "claude-code", name: "Claude Code" },
      capabilities: [],
      io,
    });
    const run = async (commands: string) => {
      const result = await engine.callTool("s1", "browser", { commands });
      return result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
    };
    const tabId = await backendTabId(
      relay.backend,
      await extension.openTab(fixtures.url("/")),
    );
    expect(await run(`tab select ${tabId}\nget title`)).toContain("Home");

    await extension.disconnect();
    await vi.waitUntil(() => !relay.backend.connected);
    extension = await FakeExtension.connect({ port: relay.port, chromium });
    expect(await run("get url")).toContain(fixtures.url("/"));
    (engine as unknown as { dispose(): void }).dispose();
  });

  it("lists both browsers, names their tabs apart and opens new tabs in the selected one", async () => {
    const second = await FakeExtension.connect({
      port: relay.port,
      chromium,
      userAgent: "Another browser",
    });
    const engine = createCommandEngine({ backend: relay.backend });
    const io = {
      readFile: () => Promise.reject(new Error("no files")),
      writeFile: () => Promise.reject(new Error("no files")),
    };
    engine.openSession({
      id: "s1",
      app: { id: "claude-code", name: "Claude Code" },
      capabilities: [],
      io,
    });
    const run = async (commands: string) => {
      const result = await engine.callTool("s1", "browser", { commands });
      return result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
    };
    try {
      const first = await backendTabId(
        relay.backend,
        await extension.openTab(fixtures.url("/")),
      );
      const other = await backendTabId(
        relay.backend,
        await second.openTab(fixtures.url("/form")),
        "b2",
      );
      expect(first).not.toBe(other);

      const browsers = await run("browser list");
      expect(browsers).toContain("b1");
      expect(browsers).toContain("b2");
      // With several connected, `tab list` says which browser each tab is in
      const tabs = await run("tab list");
      expect(tabs).toMatch(new RegExp(`${first}\\b.*\\(b1`));
      expect(tabs).toMatch(new RegExp(`${other}\\b.*\\(b2`));

      // Tab IDs reach their own browser whichever is selected
      expect(await run(`tab select ${other}\nget title`)).toContain("Form");

      await run("browser select b2");
      const opened = await run("tab new");
      const openedId = Number(opened.match(/tab (\d+)/)?.[1]);
      expect(
        relay.backend.tabs().find((tab) => tab.tabId === openedId)?.browser,
      ).toBe("b2");
    } finally {
      (engine as unknown as { dispose(): void }).dispose();
      await second.close();
    }
  });
});
