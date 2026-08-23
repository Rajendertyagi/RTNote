import { expect, test } from "@playwright/test";

test.describe("View router exclusivity", () => {
  // Regression: table-view used to live outside the TYPE_VIEWS router, so
  // opening another note while it was on left BOTH panes visible.
  test("table view closes when another note opens", async ({ page, request }) => {
    const a = await (await request.post("/api/notes", { data: { title: "Router A" } })).json();
    await request.post("/api/notes", { data: { title: "Router B" } });

    await page.goto("/");
    await page.locator("#searchInput").fill("Router A");
    const result = page.locator(".qs-result").first();
    await expect(result).toContainText("Router A", { timeout: 10000 });
    await result.click();
    await expect(page.locator("#topbar-title")).toContainText("Router A");

    // Table view on: table visible, editor hidden
    await page.locator("#tableViewBtn").click();
    await expect(page.locator("#table-view")).toBeVisible();
    await expect(page.locator("#editor-wrap")).toBeHidden();

    // Open a different note — the router must close the table
    await page.locator("#searchInput").fill("Router B");
    const resultB = page.locator(".qs-result").first();
    await expect(resultB).toContainText("Router B", { timeout: 10000 });
    await resultB.click();
    await expect(page.locator("#topbar-title")).toContainText("Router B");

    await expect(page.locator("#table-view")).toBeHidden();
    await expect(page.locator("#editor-wrap")).toBeVisible();

    // Toggling again still works from the clean state
    await page.locator("#tableViewBtn").click();
    await expect(page.locator("#table-view")).toBeVisible();
    await expect(page.locator("#editor-wrap")).toBeHidden();
  });
});
