import { expect, test } from "@playwright/test";

test.describe("Notes UI", () => {
  test("app loads with tree pane", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/./);
    await expect(page.locator("#note-tree")).toBeVisible();
    await expect(page.locator("#newNoteBtn")).toBeVisible();
  });

  test("create a text note via toolbar", async ({ page }) => {
    await page.goto("/");
    await page.locator("#newNoteBtn").click();
    await page.locator('#newNoteMenu .context-menu-item[data-type="text"]').click();

    // New note opens in a tab and becomes the active editor content
    await expect(page.locator("#topbar-title")).toContainText(/untitled/i, {
      timeout: 10000,
    });
  });

  test("created note appears in tree after reload", async ({ page, request }) => {
    await request.post("/api/notes", {
      data: { title: "E2E Visible Note" },
    });
    await page.goto("/");
    await expect(page.locator("#note-tree")).toContainText("E2E Visible Note");
  });
});
