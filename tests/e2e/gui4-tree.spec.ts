import { expect, test } from "@playwright/test";

/* GUI-4 tree manipulation: keyboard move/reparent, context menu, Move-to
   dialog, drag & drop, persistence. The workspace is purged before each
   test (shared server DB accumulates). */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

test.beforeEach(async ({ page, request }) => {
  // Surface silent failures: uncaught page errors and failed /move calls
  // are attached to every assertion message via this shared state.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/move") && !r.ok()) errors.push(`move ${r.status()}`);
  });
  (page as unknown as { _gui4Errors: string[] })._gui4Errors = errors;

  const notes = await (await request.get("/api/notes")).json();
  for (const n of notes as Array<{ id: number }>) {
    await request.delete(`/api/notes/${n.id}`).catch(() => {});
  }
  await request.post("/api/trash/empty");
});

function diag(page: import("@playwright/test").Page) {
  const errs = (page as unknown as { _gui4Errors?: string[] })._gui4Errors ?? [];
  return errs.length ? ` [errors: ${errs.join(" | ")}]` : "";
}

function treeOrder(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#note-tree .wb-row"))
      .map((r) => r.textContent?.trim())
      .filter((t) => typeof t === "string")
  );
}

async function openInTree(page: import("@playwright/test").Page, title: string) {
  await page.locator("#note-tree .wb-row", { hasText: title }).first().click();
  await expect(page.locator("#topbar-title")).toContainText(title, { timeout: 10000 });
}

async function jumpTo(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("Control+k");
  const resp = page.waitForResponse((r) => r.url().includes("/api/search"), { timeout: 10000 });
  await page.locator("#quickSearchInput").fill(title);
  await resp;
  await page.keyboard.press("Enter");
  await expect(page.locator("#topbar-title")).toContainText(title, { timeout: 10000 });
}

test.describe("Tree keyboard movement", () => {
  test("Ctrl+Up reorders the selected note above its previous sibling", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `K1 ${u}` } })).json();
    const b = await (await request.post("/api/notes", { data: { title: `K2 ${u}` } })).json();
    const c = await (await request.post("/api/notes", { data: { title: `K3 ${u}` } })).json();

    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `K3 ${u}`);

    await page.keyboard.press("Control+ArrowUp");
    await expect(page.locator("#topbar-title")).toContainText(`K3 ${u}`); // stays open

    const navDiag = await page.evaluate(() => ({
      hist: NavHistory.debug(),
      active: document.activeElement?.tagName,
      inTree: document.getElementById("note-tree").contains(document.activeElement),
      kbdFired: (window as unknown as { __treeMoveLast?: unknown }).__treeMoveLast ?? "never",
      moveErrs: (page as unknown as { _gui4Errors?: string[] })._gui4Errors ?? [],
      rows: Array.from(document.querySelectorAll("#note-tree .wb-row")).map((r) => r.textContent?.trim()),
      cache: (typeof _notesCache !== "undefined" ? _notesCache : []).map((n: { title: string; parent_id: number | null; position: number | null }) => `${n.title}:p${n.parent_id},pos${n.position}`),
    }));
    // Order assertions carry full diagnostics for any residual failure
    const order = (await treeOrder(page)).join("|");
    const msg = `kbd diag: ${JSON.stringify(navDiag)} | dom order: ${order}`;
    expect(order.indexOf(`K3 ${u}`) > -1, msg).toBe(true);
    expect(order.indexOf(`K3 ${u}`), msg).toBeLessThan(order.indexOf(`K2 ${u}`));
    expect(order.indexOf(`K1 ${u}`), msg).toBeLessThan(order.indexOf(`K3 ${u}`));

    // Server state matches the UI
    const moved = await (await request.get(`/api/notes/${c.id}`)).json();
    expect(moved.position).toBe(1);
    void b;
  });

  test("Ctrl+Right nests a note into its previous sibling", async ({ page, request }) => {
    const u = uniq();
    const root = await (await request.post("/api/notes", { data: { title: `NRoot ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `NChild ${u}`, parent_id: root.id } });
    const target = await (await request.post("/api/notes", { data: { title: `NTarget ${u}` } })).json();

    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `NTarget ${u}`);

    await page.keyboard.press("Control+ArrowRight");
    await expect(page.locator("#topbar-title")).toContainText(`NTarget ${u}`);

    // Breadcrumb reflects the new parent
    await expect(page.locator("#topbar-breadcrumb")).toContainText(`NChild ${u}`);
    const moved = await (await request.get(`/api/notes/${target.id}`)).json();
    expect(moved.parent_id).not.toBeNull();
  });

  test("Ctrl+Left promotes a child up to its grandparent level", async ({ page, request }) => {
    const u = uniq();
    const root = await (await request.post("/api/notes", { data: { title: `PRoot ${u}` } })).json();
    const mid = await (await request.post("/api/notes", { data: { title: `PMid ${u}`, parent_id: root.id } })).json();
    const leaf = await (await request.post("/api/notes", { data: { title: `PLeaf ${u}`, parent_id: mid.id } })).json();

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpToLeaf(page, `PLeaf ${u}`);

    await page.keyboard.press("Control+.");
    await page.keyboard.press("Control+ArrowLeft");
    await expect(page.locator("#topbar-title")).toContainText(`PLeaf ${u}`);

    const moved = await (await request.get(`/api/notes/${leaf.id}`)).json();
    expect(moved.parent_id).toBe(root.id); // promoted out of PMid to PRoot level
  });

  async function jumpToLeaf(page: import("@playwright/test").Page, title: string) {
    await page.keyboard.press("Control+k");
    const resp = page.waitForResponse((r) => r.url().includes("/api/search"), { timeout: 10000 });
    await page.locator("#quickSearchInput").fill(title);
    await resp;
    await page.keyboard.press("Enter");
    await expect(page.locator("#topbar-title"), title + diag(page)).toContainText(title, { timeout: 10000 });
  }
});

test.describe("Tree context menu & dialog", () => {
  test("context menu Move up reorders siblings", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `CMA ${u}` } });
    await request.post("/api/notes", { data: { title: `CMB ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `CMB ${u}`);

    await page.locator("#note-tree .wb-row", { hasText: `CMB ${u}` }).first().click({ button: "right" });
    await page.locator('#ctxMenu .context-menu-item[data-action="move-up"]').click();
    await expect(page.locator("#topbar-title")).toContainText(`CMB ${u}`);

    const order = (await treeOrder(page)).join("|");
    expect(order.indexOf(`CMB ${u}`)).toBeLessThan(order.indexOf(`CMA ${u}`));
  });

  test("Move to… dialog reparents and persists across reload", async ({ page, request }) => {
    const u = uniq();
    const dest = await (await request.post("/api/notes", { data: { title: `DestP ${u}` } })).json();
    const mover = await (await request.post("/api/notes", { data: { title: `Mover ${u}` } })).json();

    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `Mover ${u}`);

    await page.locator("#note-tree .wb-row", { hasText: `Mover ${u}` }).first().click({ button: "right" });
    await page.locator('#ctxMenu .context-menu-item[data-action="move-to"]').click();
    const modal = page.getByTestId("move-modal");
    await expect(modal).toBeVisible();
    // Destination list must exclude the moved note itself
    await expect(modal.locator("select option", { hasText: `Mover ${u}` })).toHaveCount(0);
    await page.getByTestId("move-dest").selectOption({ label: `DestP ${u}` });
    await page.getByTestId("move-confirm").click();

    await expect(page.locator("#topbar-breadcrumb")).toContainText(`DestP ${u}`);

    // Persistence across reload
    await page.reload();
    await waitForAppBoot(page);
    await jumpTo(page, `Mover ${u}`);
    await expect(page.locator("#topbar-breadcrumb")).toContainText(`DestP ${u}`);
    const moved = await (await request.get(`/api/notes/${mover.id}`)).json();
    expect(moved.parent_id).toBe(dest.id);
  });
});

test.describe("Tree drag & drop", () => {
  test("dragging a note onto another makes it a child", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `DragSrc ${u}` } });
    const dest = await (await request.post("/api/notes", { data: { title: `DragDst ${u}` } })).json();

    await page.goto("/");
    await waitForAppBoot(page);

    const src = page.locator("#note-tree .wb-row", { hasText: `DragSrc ${u}` }).first();
    const dst = page.locator("#note-tree .wb-row", { hasText: `DragDst ${u}` }).first();
    await src.dragTo(dst);

    // Server is the authority: verify the hierarchy changed
    const notes = await (await request.get("/api/notes")).json();
    const srcNote = (notes as Array<{ title: string; parent_id: number | null }>).find(
      (n) => n.title === `DragSrc ${u}`
    );
    expect(srcNote?.parent_id).toBe(dest.id);
  });

  test("reordering via drop between siblings updates positions", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `OrdA ${u}` } });
    await request.post("/api/notes", { data: { title: `OrdB ${u}` } });
    await request.post("/api/notes", { data: { title: `OrdC ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);

    const src = page.locator("#note-tree .wb-row", { hasText: `OrdC ${u}` }).first();
    const dst = page.locator("#note-tree .wb-row", { hasText: `OrdA ${u}` }).first();
    await src.dragTo(dst);

    const notes = await (await request.get("/api/notes")).json();
    const c = (notes as Array<{ title: string; position: number }>).find(
      (n) => n.title === `OrdC ${u}`
    );
    expect(c?.position).toBe(0);
  });
});
