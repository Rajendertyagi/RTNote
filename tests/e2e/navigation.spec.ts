import { expect, test } from "@playwright/test";

/* GUI-2 navigation: history (back/forward + invalidation + dead-entry skip),
   clickable breadcrumbs, jump-to-note via Ctrl+K, tree reveal, Ctrl+. and
   Backspace-to-parent. No sleeps — retrying assertions + boot contract.
   Seeds use per-run unique titles: the E2E server DB accumulates rows. */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function jumpTo(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("Control+k");
  // Arm the search-response waiter BEFORE typing — Enter must never race
  // the 150ms debounced fetch.
  const searchResp = page.waitForResponse((r) => r.url().includes("/api/search"), {
    timeout: 10000,
  });
  await page.locator("#quickSearchInput").fill(title);
  await searchResp;
  const first = page.locator("#quickSearchResults .qs-result").first();
  await expect(first).toContainText(title, { timeout: 10000 }); // title boost ranks it first
  await page.keyboard.press("Enter");
  await expect(page.locator("#topbar-title")).toContainText(title, { timeout: 10000 });
}

async function openFromTree(page: import("@playwright/test").Page, title: string) {
  await page.locator("#note-tree .wb-row", { hasText: title }).first().click();
  await expect(page.locator("#topbar-title")).toContainText(title, { timeout: 10000 });
}

test.describe("Navigation history", () => {
  test("A → B → C, back, back, forward; new nav invalidates forward", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `Alpha ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `Bravo ${u}`, parent_id: a.id } });
    await request.post("/api/notes", { data: { title: `Delta ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);

    // Isolation: a previous spec's persisted tabs would restore at boot and
    // record one history entry ahead of Alpha. Start from a clean slate so
    // Alpha is provably the oldest entry.
    await request.put("/api/options/open-tabs", { data: { value: "" } });
    await page.reload();
    await waitForAppBoot(page);

    await openFromTree(page, `Alpha ${u}`);
    await jumpTo(page, `Bravo ${u}`);
    await jumpTo(page, `Delta ${u}`);

    await expect(page.getByTestId("nav-forward")).toBeDisabled();
    await expect(page.getByTestId("nav-back")).toBeEnabled();

    await page.keyboard.press("Alt+ArrowLeft"); // Delta → Bravo
    await expect(page.locator("#topbar-title")).toContainText(`Bravo ${u}`);
    await page.keyboard.press("Alt+ArrowLeft"); // Bravo → Alpha
    await expect(page.locator("#topbar-title")).toContainText(`Alpha ${u}`);

    // Whether a further back-step remains depends on whether a restored
    // boot tab occupies a slot behind Alpha — upstream suites vary that.
    // State-truth assertion: index 0 means Alpha is the oldest entry.
    const hist = await page.evaluate(() => NavHistory.debug());
    expect(hist.index, `history after two backs: ${JSON.stringify(hist)}`).toBe(0);
    await expect(page.locator("#topbar-title")).toContainText(`Alpha ${u}`);

    await page.keyboard.press("Alt+ArrowRight"); // Alpha → Bravo
    await expect(page.locator("#topbar-title")).toContainText(`Bravo ${u}`);

    // Fresh navigation from the middle kills the forward stack
    await jumpTo(page, `Delta ${u}`);
    await expect(page.getByTestId("nav-forward")).toBeDisabled();
  });

  test("back skips a deleted note and lands on the nearest live one", async ({ page, request }) => {
    const u = uniq();
    // FLAT siblings: soft-deleting a note trashes its whole subtree, so a
    // chain would trash C too. Flat notes isolate the skip behavior.
    const a = await (await request.post("/api/notes", { data: { title: `SkipA ${u}` } })).json();
    const b = await (await request.post("/api/notes", { data: { title: `SkipB ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `SkipC ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);

    await openFromTree(page, `SkipA ${u}`);
    await jumpTo(page, `SkipB ${u}`);
    await jumpTo(page, `SkipC ${u}`);

    // Delete the middle note, then go back: SkipB must be skipped
    await request.delete(`/api/notes/${b.id}`);
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.locator("#topbar-title")).toContainText(`SkipA ${u}`);

    // And forward skips it too, landing on the still-live leaf
    await page.keyboard.press("Alt+ArrowRight");
    await expect(page.locator("#topbar-title")).toContainText(`SkipC ${u}`);
  });
});

test.describe("Breadcrumbs", () => {
  test("ancestors are clickable; root notes hide the breadcrumb", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `CrumbRoot ${u}` } })).json();
    const b = await (await request.post("/api/notes", { data: { title: `CrumbMid ${u}`, parent_id: a.id } })).json();
    await request.post("/api/notes", { data: { title: `CrumbLeaf ${u}`, parent_id: b.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    await jumpTo(page, `CrumbLeaf ${u}`);
    const bc = page.locator("#topbar-breadcrumb");
    await expect(bc).toContainText(`CrumbRoot ${u}`);
    await expect(bc).toContainText(`CrumbMid ${u}`);

    await bc.locator(".crumb", { hasText: `CrumbMid ${u}` }).click();
    await expect(page.locator("#topbar-title")).toContainText(`CrumbMid ${u}`);

    await jumpTo(page, `CrumbLeaf ${u}`);
    await bc.locator(".crumb", { hasText: `CrumbRoot ${u}` }).click();
    await expect(page.locator("#topbar-title")).toContainText(`CrumbRoot ${u}`);

    // Root notes have no ancestors → breadcrumb hidden
    await jumpTo(page, `CrumbRoot ${u}`);
    await expect(bc).toBeHidden();
  });
});

test.describe("Tree reveal & keyboard", () => {
  test("jumping to a deep note reveals it in the tree", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `RevealRoot ${u}` } })).json();
    const b = await (await request.post("/api/notes", { data: { title: `RevealMid ${u}`, parent_id: a.id } })).json();
    await request.post("/api/notes", { data: { title: `RevealLeaf ${u}`, parent_id: b.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    await jumpTo(page, `RevealLeaf ${u}`);
    const row = page.locator("#note-tree .wb-row", { hasText: `RevealLeaf ${u}` }).first();
    await expect(row).toBeVisible();
    await expect(row).toBeInViewport();
  });

  test("Ctrl+. focuses the tree", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);
    await page.locator("#newNoteBtn").click();
    await page.locator('#newNoteMenu .context-menu-item[data-type="text"]').click();
    await expect(page.locator("#topbar-title")).toContainText(/untitled/i, { timeout: 10000 });

    await page.keyboard.press("Control+.");
    await expect(page.locator("#note-tree")).toBeFocused();
  });

  test("Backspace in tree jumps to parent; root-level is a no-op", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `PJRoot ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `PJChild ${u}`, parent_id: a.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    // Root-level note: Backspace must NOT navigate anywhere
    await openFromTree(page, `PJRoot ${u}`);
    await page.keyboard.press("Backspace");
    await expect(page.locator("#topbar-title")).toContainText(`PJRoot ${u}`);

    // Child note: reveal it via jump (expands ancestors), click its row to
    // give the tree focus + active node, then Backspace activates the parent.
    await jumpTo(page, `PJChild ${u}`);
    await page.locator("#note-tree .wb-row", { hasText: `PJChild ${u}` }).first().click();
    await expect(page.locator("#topbar-title")).toContainText(`PJChild ${u}`);
    await page.keyboard.press("Backspace");
    await expect(page.locator("#topbar-title")).toContainText(`PJRoot ${u}`);
  });
});
