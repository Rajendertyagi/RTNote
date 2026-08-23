import { expect, test } from "@playwright/test";

/* GUI-2 navigation: history (back/forward + invalidation + dead-entry skip),
   clickable breadcrumbs, jump-to-note via Ctrl+K, tree reveal, Ctrl+. and
   Backspace-to-parent. No sleeps — retrying assertions + boot contract. */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

async function jumpTo(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("Control+k");
  await page.locator("#quickSearchInput").fill(title);
  const first = page.locator("#quickSearchResults .qs-result").first();
  await expect(first).toContainText(title, { timeout: 10000 }); // title boost ranks it first
  const diag = await page.evaluate(() => ({
    results: (typeof quickSearchResults !== "undefined" ? quickSearchResults : []).map(
      (r: { id: number; title: string }) => `${r.id}:${r.title}`
    ),
  }));
  await page.keyboard.press("Enter");
  await expect(
    page.locator("#topbar-title"),
    `after Enter on ${JSON.stringify(diag)}`
  ).toContainText(title, { timeout: 10000 });
}

async function openFromTree(page: import("@playwright/test").Page, title: string) {
  await page.locator("#note-tree .wb-row", { hasText: title }).first().click();
  const diag = await page.evaluate(() => {
    const t = mar10.Wunderbaum.getTree("note-tree");
    return {
      active: t && t.getActiveNode ? String(t.getActiveNode()?.key ?? "null") : "no-tree",
      guard: typeof _treeReloadGuard !== "undefined" ? String(_treeReloadGuard) : "?",
      rows: Array.from(document.querySelectorAll("#note-tree .wb-row"))
        .slice(0, 8)
        .map((r) => r.textContent?.trim()),
    };
  });
  await expect(
    page.locator("#topbar-title"),
    `tree diag after click: ${JSON.stringify(diag)}`
  ).toContainText(title, { timeout: 10000 });
}

test.describe("Navigation history", () => {
  test("A → B → C, back, back, forward; new nav invalidates forward", async ({ page, request }) => {
    const a = await (await request.post("/api/notes", { data: { title: "Nav Alpha" } })).json();
    await request.post("/api/notes", { data: { title: "Nav Bravo", parent_id: a.id } });
    await request.post("/api/notes", { data: { title: "Nav Delta" } });

    await page.goto("/");
    await waitForAppBoot(page);

    await openFromTree(page, "Nav Alpha");
    await jumpTo(page, "Nav Bravo");
    await jumpTo(page, "Nav Delta");

    await expect(page.getByTestId("nav-forward")).toBeDisabled();
    await expect(page.getByTestId("nav-back")).toBeEnabled();

    await page.keyboard.press("Alt+ArrowLeft"); // Delta → Bravo
    await expect(page.locator("#topbar-title")).toContainText("Nav Bravo");
    await page.keyboard.press("Alt+ArrowLeft"); // Bravo → Alpha
    await expect(page.locator("#topbar-title")).toContainText("Nav Alpha");
    await expect(page.getByTestId("nav-back")).toBeDisabled();

    await page.keyboard.press("Alt+ArrowRight"); // Alpha → Bravo
    await expect(page.locator("#topbar-title")).toContainText("Nav Bravo");

    // Fresh navigation from the middle kills the forward stack
    await jumpTo(page, "Nav Delta");
    await expect(page.getByTestId("nav-forward")).toBeDisabled();
  });

  test("back skips a deleted note and lands on the nearest live one", async ({ page, request }) => {
    const a = await (await request.post("/api/notes", { data: { title: "Skip Alpha" } })).json();
    const b = await (await request.post("/api/notes", { data: { title: "Skip Bravo", parent_id: a.id } })).json();
    await request.post("/api/notes", { data: { title: "Skip Charlie", parent_id: b.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    await openFromTree(page, "Skip Alpha");
    await jumpTo(page, "Skip Bravo");
    await jumpTo(page, "Skip Charlie");

    // Delete the middle note, then go back: Bravo must be skipped
    await request.delete(`/api/notes/${b.id}`);
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.locator("#topbar-title")).toContainText("Skip Alpha");

    // And forward skips it too, landing on the still-live leaf
    await page.keyboard.press("Alt+ArrowRight");
    await page.keyboard.press("Alt+ArrowRight");
    await expect(page.locator("#topbar-title")).toContainText("Skip Charlie");
  });
});

test.describe("Breadcrumbs", () => {
  test("ancestors are clickable; root notes hide the breadcrumb", async ({ page, request }) => {
    const a = await (await request.post("/api/notes", { data: { title: "Crumb Root" } })).json();
    const b = await (await request.post("/api/notes", { data: { title: "Crumb Mid", parent_id: a.id } })).json();
    await request.post("/api/notes", { data: { title: "Crumb Leaf", parent_id: b.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    await jumpTo(page, "Crumb Leaf");
    const bc = page.locator("#topbar-breadcrumb");
    await expect(bc).toContainText("Crumb Root");
    await expect(bc).toContainText("Crumb Mid");

    await bc.locator(".crumb", { hasText: "Crumb Mid" }).click();
    await expect(page.locator("#topbar-title")).toContainText("Crumb Mid");

    // Ensure the crumb's async open chain fully settled before jumping again
    await page.waitForFunction(() => App.bootDone === true);

    await jumpTo(page, "Crumb Leaf");
    await expect(page.locator("#topbar-title")).toContainText("Crumb Leaf");
    await bc.locator(".crumb", { hasText: "Crumb Root" }).click();
    await expect(page.locator("#topbar-title")).toContainText("Crumb Root");

    // Root notes have no ancestors → breadcrumb hidden
    await jumpTo(page, "Crumb Root");
    await expect(bc).toBeHidden();
  });
});

test.describe("Tree reveal & keyboard", () => {
  test("jumping to a deep note reveals it in the tree", async ({ page, request }) => {
    const a = await (await request.post("/api/notes", { data: { title: "Reveal Root" } })).json();
    const b = await (await request.post("/api/notes", { data: { title: "Reveal Mid", parent_id: a.id } })).json();
    await request.post("/api/notes", { data: { title: "Reveal Leaf", parent_id: b.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    await jumpTo(page, "Reveal Leaf");
    const row = page.locator("#note-tree .wb-row", { hasText: "Reveal Leaf" }).first();
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
    const a = await (await request.post("/api/notes", { data: { title: "Parent Jump Root" } })).json();
    await request.post("/api/notes", { data: { title: "Parent Jump Child", parent_id: a.id } });

    await page.goto("/");
    await waitForAppBoot(page);

    // Root-level note: Backspace must NOT navigate anywhere
    await openFromTree(page, "Parent Jump Root");
    await page.keyboard.press("Backspace");
    await expect(page.locator("#topbar-title")).toContainText("Parent Jump Root");

    // Child note: Backspace activates the parent
    await page.locator("#note-tree .wb-row", { hasText: "Parent Jump Root" }).locator(".wb-expander").click();
    await openFromTree(page, "Parent Jump Child");
    await page.keyboard.press("Backspace");
    await expect(page.locator("#topbar-title")).toContainText("Parent Jump Root");
  });
});
