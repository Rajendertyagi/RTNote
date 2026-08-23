import { expect, test } from "@playwright/test";

/**
 * Chat E2E — full page (/chat) and mini panel (index).
 * The server runs with CHAT_FAKE_LLM=canned (see playwright.config.ts),
 * so the "assistant" streams a deterministic canned reply with markdown.
 *
 * The E2E server DB persists across tests (workers=1), so every test
 * starts from a clean slate: wipe chat sessions via the API first.
 */

test.beforeEach(async ({ request }) => {
  const sessions = await (await request.get("/api/chat/sessions")).json();
  for (const s of sessions as Array<{ id: number }>) {
    await request.delete(`/api/chat/sessions/${s.id}`);
  }
});

test.describe("Full chat", () => {
  test("send message → streamed markdown reply → session appears", async ({ page }) => {
    await page.goto("/chat");

    const stream = page.getByTestId("chat-stream");
    await expect(stream).toContainText("New conversation");

    await page.getByTestId("composer").fill("hello bot");
    await page.getByTestId("send-btn").click();

    // user bubble + streamed assistant reply
    await expect(stream).toContainText("hello bot");
    await expect(stream).toContainText("Hello from the");
    // markdown actually rendered (bold text, not raw asterisks)
    await expect(stream.locator(".bubble strong").first()).toHaveText(/fake/);

    // session shows up in the sidebar
    await expect(page.getByTestId("session-list").locator("[data-testid='session-item']")).toHaveCount(1);
  });

  test("continues the same session and switches sessions", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("composer").fill("first message");
    await page.getByTestId("send-btn").click();
    await expect(page.getByTestId("chat-stream")).toContainText("Hello from the");

    // new chat resets the stream, old session remains in the sidebar
    await page.locator("#newChatBtn").click();
    await expect(page.getByTestId("chat-stream")).toContainText("New conversation");
    const items = page.getByTestId("session-list").locator("[data-testid='session-item']");
    await expect(items).toHaveCount(1);

    // open it again → history restored
    items.first().click();
    await expect(page.getByTestId("chat-stream")).toContainText("first message");
  });

  test("delete session clears the sidebar", async ({ page, request }) => {
    // seed via API (setup only; the behavior under test is the UI delete)
    await request.post("/api/chat/send", { data: { message: "seeded" } });

    await page.goto("/chat");
    const items = page.getByTestId("session-list").locator("[data-testid='session-item']");
    await expect(items).toHaveCount(1);
    await items.first().hover();
    await items.first().locator(".del").click();
    await expect(items).toHaveCount(0);
  });

  test("attachment chips can be added and removed", async ({ page }) => {
    await page.goto("/chat");
    await page.setInputFiles("#chatFileInput", {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attached content"),
    });
    const bar = page.getByTestId("attachments-bar");
    await expect(bar).toContainText("notes.txt");
    await bar.locator(".att-chip button").click();
    await expect(bar).toBeHidden();
  });
});

test.describe("Mini chat", () => {
  test("sends a message and renders the canned reply", async ({ page }) => {
    await page.goto("/");
    const panel = page.getByTestId("mini-chat-stream");

    await page.getByTestId("mini-composer").fill("mini hello");
    await page.getByTestId("mini-send-btn").click();

    await expect(panel).toContainText("mini hello");
    await expect(panel).toContainText("Hello from the");
  });
});

test.describe("Markdown security", () => {
  test("hostile markdown is sanitized but normal markdown still renders", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("composer").fill("security-test please");
    await page.getByTestId("send-btn").click();

    const stream = page.getByTestId("chat-stream");
    const bubble = stream.locator(".msg.assistant .bubble").last();
    await expect(bubble).toContainText("Security probe");

    // executable markup never survives
    await expect(bubble.locator("script")).toHaveCount(0);
    await expect(bubble.locator("[onclick]")).toHaveCount(0);
    await expect(bubble.locator("img[onerror]")).toHaveCount(0);
    const anchors = bubble.locator("a");
    const anchorCount = await anchors.count();
    for (let i = 0; i < anchorCount; i++) {
      const href = await anchors.nth(i).getAttribute("href");
      expect(href === null || !href.toLowerCase().startsWith("javascript:")).toBe(true);
    }

    // normal markdown still renders
    await expect(bubble.locator("strong").first()).toHaveText("bold stays");

    // raw source preserved for Copy
    const raw = await bubble.getAttribute("data-raw");
    expect(raw).toContain("<script>alert(1)</script>");
  });
});

test.describe("CDN failure fallback", () => {
  test("chat works with marked/DOMPurify unavailable (escaped plain text)", async ({ page }) => {
    await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort());
    await page.goto("/chat");

    await page.getByTestId("composer").fill("offline markdown **test**");
    await page.getByTestId("send-btn").click();

    // generation must reach its terminal state before we inspect the bubble
    await expect(page.getByTestId("stop-btn")).toBeHidden();
    await expect(page.getByTestId("send-btn")).toBeEnabled();

    const bubble = page.getByTestId("chat-stream").locator(".msg.assistant .bubble").last();
    await expect(bubble).toContainText("Hello from the");
    // no markdown rendering happened — raw asterisks visible as plain text
    await expect(bubble.locator("strong")).toHaveCount(0);
    // copy still wired and uses the raw source
    await expect(bubble.locator(".copy-btn")).toHaveCount(1);
  });
});

test.describe("Error handling & stop", () => {
  test("failing model shows a distinct error bubble, not fake content", async ({ page }) => {
    await page.goto("/chat");
    await page.locator("#customModel").fill("ollama/fail-e2e");
    await page.getByTestId("composer").fill("this will fail");
    await page.getByTestId("send-btn").click();

    const errBubble = page.getByTestId("chat-stream").locator(".msg.msg-error .bubble").last();
    await expect(errBubble).toContainText("simulated provider failure");
  });

  test("stop button appears during generation and cancels cleanly", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/chat/stream", async (route) => {
      await gate; // hold the response until the test releases it
      await route.abort("timedout").catch(() => {}); // request may already be aborted
    });

    await page.goto("/chat");
    await page.getByTestId("composer").fill("interrupt me");
    await page.getByTestId("send-btn").click();

    const stopBtn = page.getByTestId("stop-btn");
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();
    release();

    // generation state clears; user message stays; no crash
    await expect(stopBtn).toBeHidden();
    await expect(page.getByTestId("send-btn")).toBeEnabled();
    await expect(page.getByTestId("chat-stream")).toContainText("interrupt me");
  });
});

test.describe("Cross-page persistence", () => {
  test("selected model persists across reload and into the mini panel", async ({ page }) => {
    await page.goto("/chat");
    await page.getByTestId("model-select").selectOption({ index: 1 });
    const chosen = await page.getByTestId("model-select").inputValue();
    await page.reload();
    await expect(page.getByTestId("model-select")).toHaveValue(chosen);

    // mini panel shares the same localStorage key
    await page.goto("/");
    await expect(page.getByTestId("mini-model-select")).toHaveValue(chosen);
  });
});
