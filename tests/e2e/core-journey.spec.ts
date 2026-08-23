import { expect, test } from "@playwright/test";

test.describe("Core journey", () => {
  // THE critical workflow: type into the real editor, let autosave fire,
  // reload, reopen, and see the content survive.
  test("create → type → autosave → reload → content persists", async ({ page }) => {
    await page.goto("/");

    // Create a fresh text note through the UI
    await page.locator("#newNoteBtn").click();
    await page.locator('#newNoteMenu .context-menu-item[data-type="text"]').click();
    await expect(page.locator("#topbar-title")).toContainText(/untitled/i, {
      timeout: 10000,
    });

    // Autosave fires ~800ms after typing stops — arm the PUT waiter before
    // typing so the request can't slip past us (no arbitrary sleeps).
    const savePromise = page.waitForResponse(
      (r) => r.request().method() === "PUT" && /\/api\/notes\/\d+$/.test(r.url()),
      { timeout: 10000 }
    );

    // Type into the real SunEditor surface
    const editable = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await editable.click();
    await editable.pressSequentially("Journey persists this sentence");

    const saveResponse = await savePromise;
    expect(saveResponse.status()).toBe(200);

    // Reload — persisted tabs reopen the same note
    await page.reload();
    const restored = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await expect(restored).toContainText("Journey persists this sentence", {
      timeout: 10000,
    });
  });
});
