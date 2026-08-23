import { expect, test } from "@playwright/test";

test.describe("Trash UI", () => {
  test("deleted note is listed and restorable", async ({ page, request }) => {
    const created = await request.post("/api/notes", {
      data: { title: "Trash Me" },
    });
    const note = await created.json();
    await request.delete(`/api/notes/${note.id}`);

    await page.goto("/");
    await page.locator("#trashToggle").click();
    const panel = page.locator("#trashPanel");
    await expect(panel).toBeVisible();
    await expect(page.locator("#trashItems")).toContainText("Trash Me");

    await page.locator('#trashItems [data-restore]').first().click();
    await expect(page.locator("#trashItems")).not.toContainText("Trash Me");

    // Restored note is back in the tree
    await page.reload();
    await expect(page.locator("#note-tree")).toContainText("Trash Me");
  });

  test("empty trash clears the list", async ({ page, request }) => {
    const created = await request.post("/api/notes", {
      data: { title: "Gone Forever" },
    });
    const note = await created.json();
    await request.delete(`/api/notes/${note.id}`);

    await page.goto("/");
    await page.locator("#trashToggle").click();
    await page.locator("#emptyTrashBtn").click();
    await expect(page.locator("#trashItems")).not.toContainText("Gone Forever");
  });
});
