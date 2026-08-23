import { expect, test } from "@playwright/test";

test.describe("Attachments UI", () => {
  test("uploaded file appears in the files panel", async ({ page, request }) => {
    const created = await request.post("/api/notes", {
      data: { title: "Attach Here" },
    });
    const note = await created.json();

    await page.goto("/");
    // Open the note
    await page.locator("#searchInput").fill("Attach Here");
    await page.locator("#searchResults .qs-result").first().click();

    // Switch right sidebar to the Files tab and upload through the hidden input
    await page.locator('.right-sidebar .tab[data-tab="files"]').click();
    await page.locator("#fileInput").setInputFiles({
      name: "hello.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment body"),
    });

    const files = page.locator("#files-list");
    await expect(files).toContainText("hello.txt", { timeout: 10000 });
  });
});
