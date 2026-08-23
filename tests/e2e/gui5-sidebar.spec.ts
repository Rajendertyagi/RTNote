import { expect, test } from "@playwright/test";

/* GUI-5 right sidebar: Info / Outline / Files / Chat tabs.
   Covers tab switching, info breadcrumbs, outline extraction and its
   limitations for unsupported/heading-less notes, attachment upload/delete,
   chat panel DOM stability across tab switches, and persistence of the
   active tab + collapsed state across reloads.
   The E2E server DB accumulates across tests/runs: every test starts by
   purging all notes so panels stay deterministic. */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

test.beforeEach(async ({ request }) => {
  // Fresh workspace: soft-delete everything, then hard-purge the trash.
  const notes = await (await request.get("/api/notes")).json();
  for (const n of notes as Array<{ id: number }>) {
    await request.delete(`/api/notes/${n.id}`).catch(() => {});
  }
  await request.post("/api/trash/empty");
});

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

async function switchTab(page: import("@playwright/test").Page, name: string) {
  await page.locator(`.right-sidebar .tab[data-tab="${name}"]`).click();
}

test.describe("GUI-5 sidebar", () => {
  test("info panel shows child note with breadcrumb link to parent", async ({ page, request }) => {
    const u = uniq();
    const pTitle = `Parent ${u}`;
    const cTitle = `Child ${u}`;
    const p = await (await request.post("/api/notes", { data: { title: pTitle } })).json();
    await request.post("/api/notes", { data: { title: cTitle, parent_id: p.id } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, cTitle);
    await switchTab(page, "info");

    await expect(page.locator("[data-testid=info-title]")).toContainText(cTitle);
    await expect(page.locator("[data-testid=info-path]")).toContainText(pTitle);

    await page.locator(`.crumb-link[data-id="${p.id}"]`).click();
    await expect(page.locator("#topbar-title")).toContainText(pTitle);
  });

  test("info panel refreshes when the active note changes", async ({ page, request }) => {
    const u = uniq();
    const aTitle = `InfoA ${u}`;
    const bTitle = `InfoB ${u}`;
    await request.post("/api/notes", { data: { title: aTitle } });
    await request.post("/api/notes", { data: { title: bTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, aTitle);
    await switchTab(page, "info");
    await expect(page.locator("[data-testid=info-title]")).toContainText(aTitle);

    await jumpTo(page, bTitle);
    await switchTab(page, "info");
    await expect(page.locator("[data-testid=info-title]")).toContainText(bTitle);
    await expect(page.locator("[data-testid=info-title]")).not.toContainText(aTitle);
  });

  test("outline lists H1-H3 headings and clicking an item does not navigate", async ({ page, request }) => {
    const u = uniq();
    const oTitle = `Outline ${u}`;
    await request.post("/api/notes", {
      data: {
        title: oTitle,
        content: "<h1>H One</h1><h2>H Two</h2><h3>H Three</h3>",
      },
    });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, oTitle);
    await switchTab(page, "outline");

    const items = page.locator("#outline-list [data-testid=outline-item]");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("H One");
    await expect(items.nth(1)).toContainText("H Two");
    await expect(items.nth(2)).toContainText("H Three");

    await items.filter({ hasText: "H Two" }).click();
    // Outline navigation scrolls the editor; it must NOT change the active note
    await expect(page.locator("#topbar-title")).toContainText(oTitle);
    await expect(page.locator(".editor-wrap .se-wrapper-wysiwyg")).toBeFocused();
  });

  test("outline shows empty state for a heading-less text note", async ({ page, request }) => {
    const u = uniq();
    const eTitle = `NoHeads ${u}`;
    await request.post("/api/notes", { data: { title: eTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, eTitle);
    await switchTab(page, "outline");

    await expect(page.locator("#outline-list")).toContainText("No headings in this note.");
  });

  test("outline shows unavailable message for a code note", async ({ page, request }) => {
    const u = uniq();
    const cTitle = `CodeNote ${u}`;
    await request.post("/api/notes", {
      data: { title: cTitle, type: "code", content: "print('hi')" },
    });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, cTitle);
    await switchTab(page, "outline");

    await expect(page.locator("#outline-list")).toContainText("Outline unavailable for this note type.");
  });

  test("attachments: empty state, upload appears, delete removes", async ({ page, request }) => {
    const u = uniq();
    const fName = `attachment-${u}.txt`;
    const aTitle = `Files ${u}`;
    await request.post("/api/notes", { data: { title: aTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, aTitle);
    await switchTab(page, "files");
    await expect(page.locator("#files-list")).toContainText("No attachments");

    await page.locator("#fileInput").setInputFiles({
      name: fName,
      mimeType: "text/plain",
      buffer: Buffer.from("attachment body"),
    });

    const item = page.locator(".file-item", { hasText: fName });
    await expect(item).toBeVisible();

    await item.locator("[data-del]").click();
    await expect(page.locator("#files-list .file-item")).toHaveCount(0);
    await expect(page.locator("#files-list")).toContainText("No attachments");
  });

  test("chat panel DOM survives switching tabs away and back; memories strip toggles", async ({ page, request }) => {
    const u = uniq();
    const cTitle = `Chat ${u}`;
    await request.post("/api/notes", { data: { title: cTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, cTitle);
    await switchTab(page, "chat");

    await switchTab(page, "info");
    await switchTab(page, "chat");

    const composer = page.getByTestId("mini-composer");
    await expect(composer).toBeVisible();
    await composer.fill("still here");
    await expect(composer).toHaveValue("still here");
    await expect(page.getByTestId("mini-chat-stream")).toBeInTheDocument();

    await page.locator("#memoriesToggleMini").click();
    await expect(page.locator("#memories-strip")).toBeVisible();
  });

  test("active tab and collapsed state persist across reload", async ({ page, request }) => {
    const u = uniq();
    const sTitle = `Persist ${u}`;
    await request.post("/api/notes", { data: { title: sTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, sTitle);

    await switchTab(page, "info");
    await expect(page.getByTestId("panel-info")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("sidebarTab")), { timeout: 10000 })
      .toBe("info");

    await page.reload();
    await waitForAppBoot(page);
    await expect(page.getByTestId("panel-info")).not.toHaveClass(/hidden/);
    await expect(page.locator('.right-sidebar .tab[data-tab="info"]')).toHaveClass(/active/);
    await expect(page.locator('.right-sidebar .tab[data-tab="info"]')).toHaveAttribute("aria-selected", "true");

    // Collapse the sidebar, wait for persistence, then reload
    await page.locator('[title="Toggle Right Sidebar"]').click();
    await expect(page.locator("#rightSidebar")).toHaveClass(/hidden/);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("sidebarCollapsed")), { timeout: 10000 })
      .toBeTruthy();

    await page.reload();
    await waitForAppBoot(page);
    await expect(page.locator("#rightSidebar")).toHaveClass(/hidden/);

    await page.locator('[title="Toggle Right Sidebar"]').click();
    await expect(page.locator("#rightSidebar")).toBeVisible();
    // Last active tab survived the collapse/reload cycle
    await expect(page.locator('.right-sidebar .tab[data-tab="info"]')).toHaveClass(/active/);
    await expect(page.getByTestId("panel-info")).toBeVisible();
  });

  test("files panel reflects the newly active note, not the previous one", async ({ page, request }) => {
    const u = uniq();
    const fName = `onlyA-${u}.txt`;
    const aTitle = `ConsistA ${u}`;
    const bTitle = `ConsistB ${u}`;
    await request.post("/api/notes", { data: { title: aTitle } });
    await request.post("/api/notes", { data: { title: bTitle } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, aTitle);

    await switchTab(page, "files");
    await page.locator("#fileInput").setInputFiles({
      name: fName,
      mimeType: "text/plain",
      buffer: Buffer.from("belongs to A"),
    });
    await expect(page.locator(".file-item", { hasText: fName })).toBeVisible();

    await jumpTo(page, bTitle);
    await switchTab(page, "files");
    await expect(page.locator("#files-list")).not.toContainText(fName);
    await expect(page.locator("#files-list")).toContainText("No attachments");
  });
});
