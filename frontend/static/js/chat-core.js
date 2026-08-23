/* chat-core.js — shared chat layer used by BOTH chat surfaces:
 *
 *   Full page (/chat, chat.js)  → SSE streaming transport
 *   Mini panel (index page, ui.js) → blocking /api/chat/send transport
 *
 * Owns: API contracts, request payloads, model/effort persistence,
 * attachment handling, and canonical message rendering.
 * Transport differences live in the adapters, not here.
 */
const ChatCore = (() => {
  "use strict";

  /* ── Constants ── */
  const LS = {
    model: "chatModel",
    custom: "chatCustomModel",
    effort: "chatEffort",
    sys: "chatSystemPrompt",
  };
  // Canonical default everywhere; persisted per browser on the full page.
  const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
  // Intentional difference: the mini panel has no prompt editor and always
  // sends this persona because it lives inside the notes context.
  const MINI_SYSTEM_PROMPT = "You are a helpful assistant for a note-taking app.";
  const TEXT_EXT = /\.(txt|md|markdown|csv|json|py|js|ts|html|css|xml|yml|yaml|log|sql|sh|toml|ini)$/i;
  const MAX_ATTACHMENT_CHARS = 200000;

  /* ── API client (the one known location for chat endpoints) ── */
  async function listModels() {
    const r = await fetch("/api/chat/models", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function listSessions() {
    const r = await fetch("/api/chat/sessions");
    return r.json();
  }

  async function getHistory(sessionId) {
    const r = await fetch(`/api/chat/history/${sessionId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function deleteSession(sessionId) {
    await fetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
  }

  async function listMemories() {
    const r = await fetch("/api/chat/memories");
    return r.json(); // {user_id, memories}
  }

  async function send(payload) {
    const r = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json(); // {session_id, reply, error?}
  }

  /* SSE reader. handlers: {onMeta, onDelta, onError}; abort via signal. */
  async function stream(payload, handlers, signal) {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === "meta" && handlers.onMeta) handlers.onMeta(data.session_id);
        else if (data.type === "delta" && handlers.onDelta) handlers.onDelta(data.text);
        else if (data.type === "error" && handlers.onError) handlers.onError(data.text);
      }
    }
  }

  /* ── State ── */
  function createChatState() {
    return {
      sessionId: null,
      generating: false,
      models: [],
      attachments: [], // {filename, content}
      abortController: null,
    };
  }

  /* ── Payloads ── */
  function buildPayload(state, message, opts) {
    const payload = {
      message,
      session_id: state.sessionId,
      model: opts.modelId,
      system_prompt: opts.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      attachments: state.attachments,
    };
    if (opts.effort) payload.reasoning_effort = opts.effort;
    return payload;
  }

  /* ── Models & reasoning effort ── */
  async function loadModels() {
    try {
      return await listModels();
    } catch {
      return [{ id: "gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI", efforts: [] }];
    }
  }

  /* Populates a <select>; persists choice under LS.model. Returns selection. */
  function populateModelSelect(selectEl, models) {
    selectEl.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} · ${m.provider}`;
      selectEl.appendChild(opt);
    }
    const saved = localStorage.getItem(LS.model);
    if (saved && models.some((m) => m.id === saved)) selectEl.value = saved;
    selectEl.addEventListener("change", () => localStorage.setItem(LS.model, selectEl.value));
    return selectEl.value;
  }

  /* Segmented effort control (full page). Hides group when unsupported. */
  function renderEffortSegments(groupEl, segEl, models, modelId) {
    const model = models.find((m) => m.id === modelId);
    segEl.innerHTML = "";
    if (!model || !model.efforts || !model.efforts.length) {
      groupEl.hidden = true;
      return;
    }
    groupEl.hidden = false;
    const current = localStorage.getItem(LS.effort);
    for (const e of model.efforts) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = e.charAt(0).toUpperCase() + e.slice(1);
      if (e === current) b.classList.add("active");
      b.onclick = () => {
        localStorage.setItem(LS.effort, e);
        renderEffortSegments(groupEl, segEl, models, modelId);
      };
      segEl.appendChild(b);
    }
  }

  function activeEffort(model) {
    const effort = localStorage.getItem(LS.effort);
    return effort && model && model.efforts && model.efforts.includes(effort) ? effort : null;
  }

  /* ── Attachments ── */
  function addAttachment(state, filename, content) {
    if (state.attachments.some((a) => a.filename === filename)) return false;
    state.attachments.push({ filename, content: content.slice(0, MAX_ATTACHMENT_CHARS) });
    return true;
  }

  async function addFiles(state, files) {
    for (const f of files) {
      if (!TEXT_EXT.test(f.name)) continue;
      addAttachment(state, f.name, await f.text());
    }
  }

  function renderAttachmentChips(bar, state) {
    bar.innerHTML = "";
    bar.classList.toggle("hidden", !state.attachments.length);
    for (const a of state.attachments) {
      const chip = document.createElement("span");
      chip.className = "att-chip";
      const name = document.createElement("span");
      name.textContent = a.filename;
      name.title = a.filename;
      const x = document.createElement("button");
      x.setAttribute("aria-label", `Remove ${a.filename}`);
      x.innerHTML = "<i class='bx bx-x'></i>";
      x.onclick = () => {
        state.attachments = state.attachments.filter((v) => v !== a);
        renderAttachmentChips(bar, state);
      };
      chip.append(name, x);
      bar.appendChild(chip);
    }
  }

  function clearAttachments(state, bar) {
    state.attachments = [];
    renderAttachmentChips(bar, state);
  }

  /* ── Message rendering (canonical: .msg > .avatar + .bubble) ── */
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* Assistant messages render markdown when marked + DOMPurify are loaded;
     everything is sanitized and we fall back to escaped plain text. */
  function setBubbleContent(bubble, raw, role) {
    bubble.dataset.raw = raw;
    if (role === "assistant" && window.marked && window.DOMPurify) {
      bubble.classList.add("md");
      bubble.innerHTML = DOMPurify.sanitize(marked.parse(raw));
    } else {
      bubble.classList.remove("md");
      bubble.textContent = raw;
    }
  }

  function addCopyButton(bubble) {
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.title = "Copy";
    btn.setAttribute("aria-label", "Copy message");
    btn.innerHTML = "<i class='bx bx-copy'></i>";
    btn.onclick = () => navigator.clipboard.writeText(bubble.dataset.raw ?? bubble.textContent);
    bubble.appendChild(btn);
  }

  /* opts: {noCopy, typing, error} */
  function appendMessage(container, role, text, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}` + (opts.error ? " msg-error" : "");
    wrap.setAttribute("data-testid", `msg-${role}`);
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = role === "user" ? "<i class='bx bx-user'></i>" : "<i class='bx bx-bot'></i>";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (opts.typing) {
      bubble.classList.add("typing");
    } else {
      setBubbleContent(bubble, text, role);
    }
    if (!opts.noCopy && !opts.typing && role === "assistant") addCopyButton(bubble);
    wrap.append(avatar, bubble);
    container.appendChild(wrap);
    scrollToBottom(container);
    return bubble;
  }

  function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }

  /* rAF-batched stream buffer: avoids O(n²) DOM churn on long replies. */
  function createStreamBuffer(container, bubble) {
    let full = "";
    let scheduled = false;
    function flush() {
      scheduled = false;
      bubble.classList.remove("typing");
      setBubbleContent(bubble, full, "assistant");
      scrollToBottom(container);
    }
    return {
      append(text) {
        full += text;
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(flush);
        }
      },
      finish() {
        if (scheduled) cancelAnimationFrame(scheduled);
        flush();
      },
      text() {
        return full;
      },
    };
  }

  /* Empty-state placeholder for a fresh conversation. */
  function showEmptyState(container, text) {
    container.innerHTML =
      "<div class='msg assistant'><div class='avatar'><i class='bx bx-bot'></i></div>" +
      `<div class='bubble'>${escapeHtml(text)}</div></div>`;
  }

  return {
    LS,
    DEFAULT_SYSTEM_PROMPT,
    MINI_SYSTEM_PROMPT,
    TEXT_EXT,
    listModels,
    listSessions,
    getHistory,
    deleteSession,
    listMemories,
    send,
    stream,
    createChatState,
    buildPayload,
    loadModels,
    populateModelSelect,
    renderEffortSegments,
    activeEffort,
    addAttachment,
    addFiles,
    renderAttachmentChips,
    clearAttachments,
    escapeHtml,
    setBubbleContent,
    appendMessage,
    addCopyButton,
    scrollToBottom,
    createStreamBuffer,
    showEmptyState,
  };
})();
