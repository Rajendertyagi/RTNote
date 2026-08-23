import { expect, test } from "@playwright/test";

test.describe("Bookmarks UI", () => {
  test("bookmarking the open note shows it in the strip", async ({ page, request }) => {
    const created = await request.post("/api/notes", {
      data: { title: "Pinned Note" },
    });
    const note = await created.json();

    await page.goto("/");
    // Open the note via quick search result click
    await page.locator("#searchInput").fill("Pinned");
    await page.locator("#searchResults .qs-result").first().click();

    await page.locator("#bookmarkBtn").click();
    await expect(page.locator("#bookmarksStrip")).toContainText("Pinned Note", {
      timeout: 10000,
    });
  });
});
