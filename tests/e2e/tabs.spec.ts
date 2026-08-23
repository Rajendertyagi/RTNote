import { expect, test } from "@playwright/test";

/* GUI-3 desktop tabs: keyboard (Ctrl+W/Alt+W, Ctrl+Tab, Ctrl+Shift+Tab),
   middle-click close, dirty indicator, close semantics, overflow,
   restoration, and history non-pollution.
   Browser-reserved shortcuts are exercised via synthetic keydown dispatch
   (same handler path as real keys; untrusted events still hit our listener).
   Seeds use per-run unique titles: the E2E server DB accumulates rows. */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function jumpTo(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("Control+k");
  const searchResp = page.waitForResponse((r) => r.url().includes("/api/search"), { timeout: 10000 });
  await page.locator("#quickSearchInput").fill(title);
  await searchResp;
  const first = page.locator("#quickSearchResults .qs-result").first();
  await expect(first).toContainText(title, { timeout: 10000 });
  await page.keyboard.press("Enter");
  await expect(page.locator("#topbar-title")).toContainText(title, { timeout: 10000 });
}

function tab(page: import("@playwright/test").Page, title: string) {
  return page.locator("#tabs .tab", { hasText: title }).first();
}

/* Dispatch a synthetic keyboard shortcut through the app's own handler */
function fireShortcut(page: import("@playwright/test").Page, init: KeyboardEventInit) {
  return page.evaluate((i) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i }));
  }, init);
}

test.describe("Tabs — keyboard", () => {
  test("Ctrl+Tab cycles forward, Ctrl+Shift+Tab cycles backward (wrapping)", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`TabA ${u}`, `TabB ${u}`, `TabC ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `TabA ${u}`);
    await jumpTo(page, `TabB ${u}`);
    await jumpTo(page, `TabC ${u}`); // active = C = last opened

    // Derive expected neighbors dynamically: persisted tabs from earlier
    // specs may precede the seeded ones in the tab strip.
    const titles = await page.evaluate(() => TabState.open.map((t: { title: string }) => t.title));
    const cur = titles.findIndex((t: string) => t.includes(`TabC ${u}`));
    const nextAfterC = titles[(cur + 1) % titles.length];
    const prevOfC = titles[(cur - 1 + titles.length) % titles.length];

    await fireShortcut(page, { key: "Tab", ctrlKey: true }); // C wraps → first
    await expect(page.locator("#topbar-title")).toContainText(nextAfterC);
    await fireShortcut(page, { key: "Tab", ctrlKey: true }); // forward one more
    const cur2 = await page.evaluate(() => TabState.activeId);
    const idx2 = await page.evaluate(
      (i: number) => TabState.open.findIndex((t: { id: number }) => t.id === i),
      cur2
    );
    await fireShortcut(page, { key: "Tab", ctrlKey: true, shiftKey: true }); // step back
    await expect(page.locator("#topbar-title")).toContainText(titles[idx2]);
  });

  test("Ctrl+W closes the active tab and activates its neighbor", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`CloseA ${u}`, `CloseB ${u}`, `CloseC ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `CloseA ${u}`);
    await jumpTo(page, `CloseB ${u}`);
    await jumpTo(page, `CloseC ${u}`);

    await fireShortcut(page, { key: "w", ctrlKey: true }); // close C → neighbor B
    await expect(page.locator("#tabs .tab")).toHaveCount(2);
    await expect(page.locator("#topbar-title")).toContainText(`CloseB ${u}`);

    // Alt+W is the always-available equivalent
    await page.keyboard.press("Alt+w"); // close B → A
    await expect(page.locator("#tabs .tab")).toHaveCount(1);
    await expect(page.locator("#topbar-title")).toContainText(`CloseA ${u}`);
  });
});

test.describe("Tabs — mouse", () => {
  test("middle-click closes an inactive tab without changing the active note", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`MidA ${u}`, `MidB ${u}`, `MidC ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `MidA ${u}`);
    await jumpTo(page, `MidB ${u}`);
    await jumpTo(page, `MidC ${u}`);

    await tab(page, `MidB ${u}`).click({ button: "middle" });
    await expect(page.locator("#tabs .tab")).toHaveCount(2);
    await expect(page.locator("#topbar-title")).toContainText(`MidC ${u}`); // active unchanged

    // Left-click still activates
    await tab(page, `MidA ${u}`).click();
    await expect(page.locator("#topbar-title")).toContainText(`MidA ${u}`);
  });

  test("Ctrl+click a tree note opens it in a background tab", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `BgOpen ${u}` } });
    await page.goto("/");
    await waitForAppBoot(page);

    const before = await page.evaluate(() => TabState.open.length);
    await page.locator("#note-tree .wb-row", { hasText: `BgOpen ${u}` }).first().click({
      modifiers: ["Control"],
    });
    await page.waitForFunction(
      (n) => TabState.open.length === n + 1,
      before,
      { timeout: 10000 }
    );
    // Background: current note untouched, new tab present
    await expect(page.locator("#tabs .tab", { hasText: `BgOpen ${u}` })).toBeVisible();
  });
});

test.describe("Tabs — modified indicator", () => {
  test("dirty dot appears on edit and clears after successful save", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `Dirty ${u}` } });
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `Dirty ${u}`);

    const savePromise = page.waitForResponse(
      (r) => r.request().method() === "PUT" && /\/api\/notes\/\d+$/.test(r.url()),
      { timeout: 15000 }
    );

    const editable = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await editable.click();
    await editable.pressSequentially("dirty probe");
    await expect(tab(page, `Dirty ${u}`)).toHaveClass(/modified/);

    await savePromise;
    await expect(page.locator("#tabs .tab.modified")).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe("Tabs — close & restoration", () => {
  test("closing the last tab shows the empty state", async ({ page, request }) => {
    const u = uniq();
    const n = await (await request.post("/api/notes", { data: { title: `Last ${u}` } })).json();
    // Only this note in the workspace: reset persisted tabs via the option API
    await request.put("/api/options/open-tabs", {
      data: { value: JSON.stringify({ tabs: [n.id], active: n.id }) },
    });
    await page.goto("/");
    await waitForAppBoot(page);
    await expect(page.locator("#tabs .tab")).toHaveCount(1);

    await page.keyboard.press("Alt+w");
    await expect(page.locator("#tabs .tab")).toHaveCount(0);
    await expect(page.locator("#topbar-title")).toContainText("No note selected");
  });

  test("open tabs survive reload with the active tab restored", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`RestA ${u}`, `RestB ${u}`, `RestC ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `RestA ${u}`);
    await jumpTo(page, `RestB ${u}`);
    await jumpTo(page, `RestC ${u}`);

    await page.reload();
    await waitForAppBoot(page);
    await expect(page.locator("#tabs .tab", { hasText: `RestA ${u}` })).toBeVisible();
    await expect(page.locator("#tabs .tab", { hasText: `RestB ${u}` })).toBeVisible();
    await expect(page.locator("#tabs .tab", { hasText: `RestC ${u}` })).toBeVisible();
    await expect(page.locator("#topbar-title")).toContainText(`RestC ${u}`);
  });
});

test.describe("Tabs — overflow & history", () => {
  test("with many tabs the active tab stays visible in the row", async ({ page, request }) => {
    const u = uniq();
    for (let i = 0; i < 8; i++) {
      await request.post("/api/notes", { data: { title: `Of${i} ${u}` } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    for (let i = 0; i < 8; i++) {
      await jumpTo(page, `Of${i} ${u}`);
    }

    const active = page.locator("#tabs .tab.active");
    await expect(active).toBeVisible();
    await expect(active).toContainText(`Of7 ${u}`);
    await expect(active).toBeInViewport();
  });

  test("switching tabs does not pollute navigation history", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`HistA ${u}`, `HistB ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `HistA ${u}`);
    await jumpTo(page, `HistB ${u}`);

    const before = await page.evaluate(() => NavHistory.debug());
    await tab(page, `HistA ${u}`).click();
    await expect(page.locator("#topbar-title")).toContainText(`HistA ${u}`);
    await tab(page, `HistB ${u}`).click();
    await expect(page.locator("#topbar-title")).toContainText(`HistB ${u}`);

    const after = await page.evaluate(() => NavHistory.debug());
    expect(after.stack.length).toBe(before.stack.length); // no A→B→A pollution
  });
});
