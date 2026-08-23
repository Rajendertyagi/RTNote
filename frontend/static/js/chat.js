/* chat.js — full-page chat adapter.
 *
 * A thin UI layer over ChatCore: sessions sidebar, model/effort controls,
 * custom-model input, system-prompt editor, note/file attachments, and the
 * SSE streaming transport. All shared behavior lives in chat-core.js.
 */

const $ = (id) => document.getElementById(id);

const state = ChatCore.createChatState();

/* ── Models & reasoning ── */
function currentModel() {
  const custom = $("customModel").value.trim();
  if (custom) return { id: custom, efforts: [] };
  return state.models.find((m) => m.id === $("modelSelect").value) || { id: "gpt-4o-mini", efforts: [] };
}

function refreshEfforts() {
  ChatCore.renderEffortSegments($("effortGroup"), $("effortSegments"), state.models, currentModel().id);
}

async function initModels() {
  state.models = await ChatCore.loadModels();
  ChatCore.populateModelSelect($("modelSelect"), state.models);
  const savedCustom = localStorage.getItem(ChatCore.LS.custom);
  if (savedCustom) $("customModel").value = savedCustom;
  $("modelSelect").addEventListener("change", () => {
    localStorage.removeItem(ChatCore.LS.custom);
    $("customModel").value = "";
    refreshEfforts();
  });
  $("customModel").addEventListener("input", (e) => {
    localStorage.setItem(ChatCore.LS.custom, e.target.value);
    refreshEfforts();
  });
  refreshEfforts();
}

/* ── Sessions ── */
async function loadSessions() {
  const list = $("sessionList");
  let sessions = [];
  try {
    sessions = await ChatCore.listSessions();
  } catch {
    /* offline: keep whatever is rendered */
  }
  list.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.sessionId ? " active" : "");
    item.setAttribute("data-testid", "session-item");
    const title = document.createElement("span");
    title.textContent = s.title || `Chat ${s.id}`;
    title.onclick = () => openSession(s.id);
    const del = document.createElement("button");
    del.className = "del";
    del.setAttribute("aria-label", `Delete session ${s.title || s.id}`);
    del.innerHTML = "<i class='bx bx-trash'></i>";
    del.title = "Delete session";
    del.onclick = async (e) => {
      e.stopPropagation();
      await ChatCore.deleteSession(s.id);
      if (s.id === state.sessionId) newChat();
      else loadSessions();
    };
    item.append(title, del);
    list.appendChild(item);
  }
}

async function openSession(id) {
  state.sessionId = id;
  const stream = $("chatStream");
  stream.innerHTML = "";
  try {
    const body = await ChatCore.getHistory(id);
    for (const m of body.messages) {
      if (m.role === "system") continue;
      ChatCore.appendMessage(stream, m.role, m.content, { noCopy: m.role !== "assistant" });
    }
  } catch {
    ChatCore.appendMessage(stream, "assistant", "Could not load this conversation.", { error: true, noCopy: true });
  }
  loadSessions();
}

function newChat() {
  state.sessionId = null;
  ChatCore.clearAttachments(state, $("attachmentsBar"));
  ChatCore.showEmptyState($("chatStream"), "New conversation — ask me anything.");
  loadSessions();
}

/* ── Send / stream ── */
async function send() {
  if (state.generating) return;
  const input = $("chatComposer");
  const message = input.value.trim();
  if (!message) return;

  const streamEl = $("chatStream");
  ChatCore.appendMessage(streamEl, "user", message, { noCopy: true });
  input.value = "";
  input.style.height = "auto";
  ChatCore.clearAttachments(state, $("attachmentsBar"));

  const bubble = ChatCore.appendMessage(streamEl, "assistant", "", { typing: true, noCopy: true });
  const buffer = ChatCore.createStreamBuffer(streamEl, bubble);
  let streamError = null;

  state.generating = true;
  $("stopBtn").hidden = false;
  $("sendBtn").disabled = true;
  state.abortController = new AbortController();

  try {
    const model = currentModel();
    await ChatCore.stream(
      ChatCore.buildPayload(state, message, {
        modelId: model.id,
        effort: ChatCore.activeEffort(model),
        systemPrompt: $("systemPrompt").value.trim() || ChatCore.DEFAULT_SYSTEM_PROMPT,
      }),
      {
        onMeta: (id) => {
          state.sessionId = id;
          loadSessions();
        },
        onDelta: (text) => buffer.append(text),
        onError: (text) => {
          streamError = text;
        },
      },
      state.abortController.signal
    );
  } catch (err) {
    if (err.name !== "AbortError") streamError = `Connection lost: ${err.message}`;
  } finally {
    buffer.finish();
    if (streamError) {
      // Replace the partial content with a distinct error bubble; the
      // backend never persists errors as assistant messages.
      bubble.closest(".msg").classList.add("msg-error");
      const prefix = buffer.text() ? `${buffer.text()}\n\n` : "";
      ChatCore.setBubbleContent(bubble, `${prefix}⚠ ${streamError}`, "assistant");
    } else if (!buffer.text()) {
      ChatCore.setBubbleContent(bubble, "(stopped)", "assistant");
    }
    ChatCore.addCopyButton(bubble);
    state.generating = false;
    $("stopBtn").hidden = true;
    $("sendBtn").disabled = false;
    state.abortController = null;
    loadSessions();
  }
}

/* ── Attachments ── */
async function openNoteAttachModal() {
  try {
    const r = await fetch("/api/notes");
    const notes = await r.json();
    const sel = $("noteSelect");
    sel.innerHTML = "";
    notes.forEach((n) => {
      const o = document.createElement("option");
      o.value = n.id;
      o.textContent = n.title;
      sel.appendChild(o);
    });
    if (!notes.length) return;
    await loadNoteAttachments(notes[0].id);
    sel.onchange = () => loadNoteAttachments(sel.value);
    $("noteAttachModal").classList.remove("hidden");
  } catch {
    showToastMini("Could not load notes for attachment.");
  }
}

function showToastMini(text) {
  ChatCore.appendMessage($("chatStream"), "assistant", text, { error: true, noCopy: true });
}

async function loadNoteAttachments(noteId) {
  const sel = $("noteAttSelect");
  sel.innerHTML = "";
  try {
    const r = await fetch(`/api/notes/${noteId}/attachments`);
    const atts = (await r.json()).filter((a) => ChatCore.TEXT_EXT.test(a.filename));
    for (const a of atts) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.filename;
      sel.appendChild(o);
    }
  } catch {
    /* leave dropdown empty */
  }
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  initModels();
  loadSessions();
  newChat();

  $("systemPrompt").value = localStorage.getItem(ChatCore.LS.sys) || ChatCore.DEFAULT_SYSTEM_PROMPT;
  $("systemPrompt").addEventListener("input", (e) => localStorage.setItem(ChatCore.LS.sys, e.target.value));
  $("sysPromptToggle").onclick = () => $("sysPromptEditor").classList.toggle("hidden");

  $("newChatBtn").onclick = newChat;
  $("sendBtn").onclick = send;
  $("stopBtn").onclick = () => state.abortController && state.abortController.abort();

  const composer = $("chatComposer");
  composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  composer.addEventListener("input", () => {
    composer.style.height = "auto";
    composer.style.height = Math.min(composer.scrollHeight, 160) + "px";
  });

  $("attachFileBtn").onclick = () => $("chatFileInput").click();
  $("chatFileInput").addEventListener("change", async (e) => {
    await ChatCore.addFiles(state, [...e.target.files]);
    ChatCore.renderAttachmentChips($("attachmentsBar"), state);
    e.target.value = "";
  });

  $("attachNoteBtn").onclick = openNoteAttachModal;
  $("noteAttCancel").onclick = () => $("noteAttachModal").classList.add("hidden");
  $("noteAttachModal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("noteAttachModal").classList.add("hidden");
  });
  $("noteAttAdd").onclick = async () => {
    const attId = $("noteAttSelect").value;
    if (!attId) return;
    try {
      const r = await fetch(`/api/attachments/${attId}/download`);
      const text = await r.text();
      const name = decodeURIComponent(
        (r.headers.get("content-disposition") || 'filename="file"').match(/filename="(.*)"/)[1]
      );
      ChatCore.addAttachment(state, name, text);
      ChatCore.renderAttachmentChips($("attachmentsBar"), state);
    } catch {
      showToastMini("Attachment download failed.");
    }
    $("noteAttachModal").classList.add("hidden");
  };
});
