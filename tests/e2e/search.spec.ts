import { expect, test } from "@playwright/test";

test.describe("Search UI", () => {
  test("sidebar search finds seeded note by content", async ({ page, request }) => {
    await request.post("/api/notes", {
      data: {
        title: "Searchable Target",
        content: "xylophone quartet rehearsal",
      },
    });
    await page.goto("/");

    const input = page.locator("#searchInput");
    await input.fill("xylophone");

    const results = page.locator("#searchResults");
    await expect(results).toBeVisible();
    await expect(results.locator(".qs-result").first()).toContainText(
      "Searchable Target",
      { timeout: 10000 }
    );
  });

  test("empty query restores the tree view", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("#searchInput");
    await input.fill("temp");
    await expect(page.locator("#searchResults")).toBeVisible();
    await input.fill("");
    await expect(page.locator("#note-tree")).toBeVisible();
  });
});
