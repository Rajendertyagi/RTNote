import { expect, test } from "@playwright/test";

/* Wait until the app finished booting (incl. tab restore). Prevents racing
   the async boot chain on slow/CDN-latency runners. */
async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => (window as any).App?.bootDone === true, undefined, {
    timeout: 30000,
  });
}

test.describe("Core journey", () => {
  // THE critical workflow: type into the real editor, let autosave fire,
  // reload, reopen, and see the content survive.
  test("create → type → autosave → reload → content persists", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);

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
    await waitForAppBoot(page);
    const restored = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await expect(restored).toContainText("Journey persists this sentence", {
      timeout: 10000,
    });
  });
});
