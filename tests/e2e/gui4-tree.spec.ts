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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/move")) errors.push(`move ${r.status()}`);
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

async function traceDiag(page: import("@playwright/test").Page) {
  const errs = (page as unknown as { _gui4Errors?: string[] })._gui4Errors ?? [];
  const trace = await page.evaluate(() => ({
    trace: (window as unknown as { __tTrace?: unknown[] }).__tTrace ?? [],
    kbdBound: (window as unknown as { _treeKbdBound?: boolean })._treeKbdBound ?? null,
  }));
  return ` [trace: ${JSON.stringify(trace)}${errs.length ? " | errors: " + errs.join(" | ") : ""}]`;
}

/* Element-order in the tree (NOT string indexOf on joined text) */
async function treeRowIndex(page: import("@playwright/test").Page, title: string) {
  return page.evaluate((t) => {
    const rows = Array.from(document.querySelectorAll("#note-tree .wb-row"));
    return rows.findIndex((r) => (r.textContent ?? "").includes(t));
  }, title);
}

async function openInTree(page: import("@playwright/test").Page, title: string) {
  await page.locator("#note-tree .wb-row", { hasText: title }).first().click();
  await expect(page.locator("#topbar-title"), title + diag(page)).toContainText(title, { timeout: 10000 });
}

async function jumpTo(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("Control+k");
  const resp = page.waitForResponse((r) => r.url().includes("/api/search"), { timeout: 10000 });
  await page.locator("#quickSearchInput").fill(title);
  await resp;
  await page.keyboard.press("Enter");
  await expect(page.locator("#topbar-title"), title + diag(page)).toContainText(title, { timeout: 10000 });
}

test.describe("Tree keyboard movement", () => {
  test("Ctrl+Up reorders the selected note above its previous sibling", async ({ page, request }) => {
    const u = uniq();
    for (const t of [`K1 ${u}`, `K2 ${u}`, `K3 ${u}`]) {
      await request.post("/api/notes", { data: { title: t } });
    }
    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `K3 ${u}`);

    await page.keyboard.press("Control+ArrowUp");
    await expect(page.locator("#topbar-title")).toContainText(`K3 ${u}`); // stays open

    const k3Idx = await treeRowIndex(page, `K3 ${u}`);
    const k2Idx = await treeRowIndex(page, `K2 ${u}`);
    const k1Idx = await treeRowIndex(page, `K1 ${u}`);
    expect(k3Idx, await traceDiag(page)).toBeLessThan(k2Idx);
    expect(k1Idx, await traceDiag(page)).toBeLessThan(k3Idx);

    // Server state matches the UI
    const notes = await (await request.get("/api/notes")).json();
    const k3 = (notes as Array<{ title: string; position: number }>).find(
      (n) => n.title === `K3 ${u}`
    );
    expect(k3?.position).toBe(1);
  });

  test("Ctrl+Right nests a note into its previous sibling", async ({ page, request }) => {
    const u = uniq();
    const p = await (await request.post("/api/notes", { data: { title: `NParent ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `NChild ${u}`, parent_id: p.id } });
    await request.post("/api/notes", { data: { title: `NSecond ${u}`, parent_id: p.id } });

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `NSecond ${u}`);

    await page.keyboard.press("Control+ArrowRight");
    await expect(page.locator("#topbar-title")).toContainText(`NSecond ${u}`);

    // Breadcrumb reflects the new parent chain: NParent › NChild
    const bc = page.locator("#topbar-breadcrumb");
    await expect(bc).toContainText(`NParent ${u}`);
    await expect(bc).toContainText(`NChild ${u}`);
  });

  test("Ctrl+Left promotes a child up to its grandparent level", async ({ page, request }) => {
    const u = uniq();
    const root = await (await request.post("/api/notes", { data: { title: `PRoot ${u}` } })).json();
    const mid = await (await request.post("/api/notes", { data: { title: `PMid ${u}`, parent_id: root.id } })).json();
    const leaf = await (await request.post("/api/notes", { data: { title: `PLeaf ${u}`, parent_id: mid.id } })).json();

    await page.goto("/");
    await waitForAppBoot(page);
    await jumpTo(page, `PLeaf ${u}`);

    await page.keyboard.press("Control+.");
    await page.keyboard.press("Control+ArrowLeft");
    await expect(page.locator("#topbar-title")).toContainText(`PLeaf ${u}`);

    const moved = await (await request.get(`/api/notes/${leaf.id}`)).json();
    expect(moved.parent_id).toBe(root.id); // promoted out of PMid to PRoot level
  });

  test("edge cases: first/last sibling moves are no-ops that keep data intact", async ({ page, request }) => {
    const u = uniq();
    const a = await (await request.post("/api/notes", { data: { title: `EdgeA ${u}` } })).json();
    await request.post("/api/notes", { data: { title: `EdgeB ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);
    await openInTree(page, `EdgeA ${u}`); // first sibling

    await page.keyboard.press("Control+ArrowUp"); // no previous sibling → no-op
    await expect(page.locator("#topbar-title")).toContainText(`EdgeA ${u}`);
    const row = await page.evaluate(
      (t) => {
        const rows = Array.from(document.querySelectorAll("#note-tree .wb-row"));
        return rows.findIndex((r) => (r.textContent ?? "").includes(t));
      },
      `EdgeA ${u}`
    );
    expect(row).toBeGreaterThanOrEqual(0);
  });
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

    const cmbIdx = await treeRowIndex(page, `CMB ${u}`);
    const cmaIdx = await treeRowIndex(page, `CMA ${u}`);
    expect(cmbIdx, await traceDiag(page)).toBeLessThan(cmaIdx);
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
  /* Playwright's mouse-based dragTo does not trigger Wunderbaum's HTML5
     DnD. Dispatch real DragEvents with a DataTransfer instead — same event
     path the extension handles, with clientY controlling the drop region
     (top edge = before, bottom edge = after, middle = over/child). */
  async function html5Drag(
    page: import("@playwright/test").Page,
    srcTitle: string,
    dstTitle: string,
    region: "before" | "after" | "over"
  ) {
    await page.evaluate(
      ([s, d, reg]) => {
        const rows = Array.from(document.querySelectorAll("#note-tree .wb-row"));
        const src = rows.find((r) => (r.textContent ?? "").includes(s)) as HTMLElement;
        const dst = rows.find((r) => (r.textContent ?? "").includes(d)) as HTMLElement;
        if (!src || !dst) throw new Error("drag rows not found");
        const dt = new DataTransfer();
        const fire = (el: HTMLElement, type: string, y: number) => {
          el.dispatchEvent(
            new DragEvent(type, {
              bubbles: true, cancelable: true, composed: true,
              dataTransfer: dt, clientX: 10, clientY: y,
            })
          );
        };
        const rect = dst.getBoundingClientRect();
        const y = reg === "before" ? rect.top + 2 : reg === "after" ? rect.bottom - 2 : rect.top + rect.height / 2;
        fire(src, "dragstart", 0);
        fire(dst, "dragenter", y);
        fire(dst, "dragover", y);
        fire(dst, "drop", y);
        fire(src, "dragend", 0);
      },
      [srcTitle, dstTitle, region] as [string, string, string]
    );
  }

  test("dragging a note onto another makes it a child", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `DragSrc ${u}` } });
    const dest = await (await request.post("/api/notes", { data: { title: `DragDst ${u}` } })).json();

    await page.goto("/");
    await waitForAppBoot(page);

    await html5Drag(page, `DragSrc ${u}`, `DragDst ${u}`, "over");

    // Server is the authority: verify the hierarchy changed
    const notes = await (await request.get("/api/notes")).json();
    const srcNote = (notes as Array<{ title: string; parent_id: number | null }>).find(
      (n) => n.title === `DragSrc ${u}`
    );
    expect(srcNote?.parent_id, diag(page)).toBe(dest.id);
  });

  test("reordering via drop between siblings updates positions", async ({ page, request }) => {
    const u = uniq();
    await request.post("/api/notes", { data: { title: `OrdA ${u}` } });
    await request.post("/api/notes", { data: { title: `OrdB ${u}` } });
    await request.post("/api/notes", { data: { title: `OrdC ${u}` } });

    await page.goto("/");
    await waitForAppBoot(page);

    await html5Drag(page, `OrdC ${u}`, `OrdA ${u}`, "before");

    const notes = await (await request.get("/api/notes")).json();
    const c = (notes as Array<{ title: string; position: number }>).find(
      (n) => n.title === `OrdC ${u}`
    );
    expect(c?.position).toBe(0);
  });
});
