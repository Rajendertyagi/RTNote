import { expect, test } from "@playwright/test";

/* GUI-1 shell verification: honest launcher, grouped topbar, save-state
   feedback in the status bar. No sleeps — retrying assertions + API waiters. */

async function waitForAppBoot(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof App !== "undefined" && App.bootDone === true, undefined, {
    timeout: 30000,
  });
}

async function createTextNote(page: import("@playwright/test").Page) {
  await page.locator("#newNoteBtn").click();
  await page.locator('#newNoteMenu .context-menu-item[data-type="text"]').click();
  await expect(page.locator("#topbar-title")).toContainText(/untitled/i, { timeout: 10000 });
}

test.describe("Launcher rail", () => {
  test("contains only real destinations — no dead placeholders", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);

    // Exactly three icons: Notes (current view), Search, Calendar.
    const icons = page.locator(".launcher .ic");
    await expect(icons).toHaveCount(3);
    await expect(page.locator("#launcherNotes")).toBeVisible();
    await expect(page.locator("#launcherSearch")).toBeVisible();
    await expect(page.locator("#launcherCalendar")).toBeVisible();
  });

  test("search icon opens quick search, calendar icon opens calendar", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);

    await page.locator("#launcherSearch").click();
    await expect(page.locator("#quickSearchOverlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#quickSearchOverlay")).toBeHidden();

    await page.locator("#launcherCalendar").click();
    await expect(page.locator("#calendarOverlay")).toBeVisible();
  });
});

test.describe("Topbar hierarchy", () => {
  test("note actions work; app controls live in their own group", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);
    await createTextNote(page);

    // Note actions group holds the per-note buttons
    const noteActions = page.locator(".topbar__note-actions");
    await expect(noteActions.locator("#bookmarkBtn")).toBeVisible();
    await expect(noteActions.locator("#uploadFileBtn")).toBeVisible();
    await expect(noteActions.locator("#newNoteBtn")).toBeVisible();

    // App-shell group holds theme + sidebar toggle
    const appActions = page.locator(".topbar__app-actions");
    await expect(appActions.locator("#themeSelect")).toBeVisible();

    // Bookmark still works: strip appears with the note
    await page.locator("#bookmarkBtn").click();
    await expect(page.locator("#bookmarksStrip")).toBeVisible({ timeout: 10000 });

    // ⋯ note menu duplicates the current note
    await page.getByTestId("note-menu-btn").click();
    const menu = page.locator("#noteMenu");
    await expect(menu).toBeVisible();
    await menu.locator('[data-action="duplicate"]').click();
    await expect(page.locator("#toastContainer")).toContainText(/duplicated/i, { timeout: 10000 });
  });
});

test.describe("Save-state feedback", () => {
  test("typing shows Unsaved changes, then Saved with a timestamp", async ({ page }) => {
    await page.goto("/");
    await waitForAppBoot(page);
    await createTextNote(page);

    const status = page.locator("#status-left");

    // Arm the PUT waiter before typing so autosave can't slip past
    const savePromise = page.waitForResponse(
      (r) => r.request().method() === "PUT" && /\/api\/notes\/\d+$/.test(r.url()),
      { timeout: 15000 }
    );

    const editable = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await editable.click();
    // First keystroke flips the state to dirty; assert inside the 800ms
    // debounce window before autosave can transition it.
    await editable.pressSequentially("s");
    await expect(status).toHaveText("Unsaved changes");
    await editable.pressSequentially("hell save-state probe");

    const res = await savePromise;
    expect(res.status()).toBe(200);

    await expect(status).toHaveText(/Saved \d{2}:\d{2}/, { timeout: 10000 });
  });

  test("save failure shows an error state that retries successfully", async ({ page }) => {
    let failing = true;
    await page.route(/\/api\/notes\/\d+$/, async (route) => {
      if (failing && route.request().method() === "PUT") return route.abort("connectionrefused");
      return route.continue();
    });

    await page.goto("/");
    await waitForAppBoot(page);
    await createTextNote(page);

    const editable = page.locator(".editor-wrap .se-wrapper-wysiwyg");
    await editable.click();
    await editable.pressSequentially("this save will fail first");

    const status = page.locator("#status-left");
    await expect(status).toHaveText(/Save failed/, { timeout: 15000 });

    // Recovery path: stop failing, use the clickable retry affordance
    failing = false;
    await status.click();
    await expect(status).toHaveText(/Saved \d{2}:\d{2}/, { timeout: 15000 });
  });
});
