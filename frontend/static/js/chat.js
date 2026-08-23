/* chat.js — full-page chat: sessions, model picker, reasoning effort,
   text attachments (upload + from-note), system prompt, SSE streaming. */

const LS = {
  model: "chatModel",
  custom: "chatCustomModel",
  effort: "chatEffort",
  sys: "chatSystemPrompt",
};

let MODELS = [];
let attachments = []; // {filename, content}
let currentSessionId = null;
let streaming = false;
let abortController = null;

const $ = (id) => document.getElementById(id);

/* ── Models & reasoning ── */
async function loadModels() {
  try {
    const r = await fetch("/api/chat/models");
    MODELS = await r.json();
  } catch {
    MODELS = [{ id: "gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI", efforts: [] }];
  }
  const sel = $("modelSelect");
  sel.innerHTML = "";
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.name} · ${m.provider}`;
    sel.appendChild(opt);
  }
  const saved = localStorage.getItem(LS.model);
  if (saved && MODELS.some((m) => m.id === saved)) sel.value = saved;
  sel.addEventListener("change", () => {
    localStorage.setItem(LS.model, sel.value);
    localStorage.removeItem(LS.custom);
    $("customModel").value = "";
    renderEfforts();
  });
  renderEfforts();
}

function activeModel() {
  const custom = $("customModel").value.trim();
  if (custom) return { id: custom, efforts: [] };
  return MODELS.find((m) => m.id === $("modelSelect").value) || { id: "gpt-4o-mini", efforts: [] };
}

function activeEffort() {
  return localStorage.getItem(LS.effort) || null;
}

function renderEfforts() {
  const model = activeModel();
  const group = $("effortGroup");
  const seg = $("effortSegments");
  seg.innerHTML = "";
  if (!model.efforts || !model.efforts.length) {
    group.hidden = true; // sticky: keep saved choice, just hide control
    return;
  }
  group.hidden = false;
  const current = activeEffort();
  for (const e of model.efforts) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e.charAt(0).toUpperCase() + e.slice(1);
    if (e === current) b.classList.add("active");
    b.onclick = () => {
      localStorage.setItem(LS.effort, e);
      renderEfforts();
    };
    seg.appendChild(b);
  }
}

/* ── Sessions ── */
async function loadSessions() {
  const list = $("sessionList");
  let sessions = [];
  try {
    const r = await fetch("/api/chat/sessions");
    sessions = await r.json();
  } catch {}
  list.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === currentSessionId ? " active" : "");
    const title = document.createElement("span");
    title.textContent = s.title || `Chat ${s.id}`;
    title.onclick = () => openSession(s.id);
    const del = document.createElement("button");
    del.className = "del";
    del.innerHTML = "<i class='bx bx-trash'></i>";
    del.title = "Delete session";
    del.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/chat/sessions/${s.id}`, { method: "DELETE" });
      if (s.id === currentSessionId) newChat();
      loadSessions();
    };
    item.append(title, del);
    list.appendChild(item);
  }
}

async function openSession(id) {
  currentSessionId = id;
  $("chatStream").innerHTML = "";
  try {
    const r = await fetch(`/api/chat/history/${id}`);
    if (r.ok) {
      const body = await r.json();
      for (const m of body.messages) {
        if (m.role === "system") continue;
        addMessage(m.role, m.content);
      }
    }
  } catch {}
  loadSessions();
}

function newChat() {
  currentSessionId = null;
  attachments = [];
  renderAttachments();
  $("chatStream").innerHTML =
    "<div class='msg assistant'><div class='avatar'><i class='bx bx-bot'></i></div>" +
    "<div class='bubble'>New conversation — ask me anything.</div></div>";
  loadSessions();
}

/* ── Messages ── */
function addMessage(role, text, opts = {}) {
  const stream = $("chatStream");
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.innerHTML = role === "user" ? "<i class='bx bx-user'></i>" : "<i class='bx bx-bot'></i>";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  if (!opts.noCopy && role === "assistant") addCopyButton(bubble);
  if (opts.typing) bubble.classList.add("typing");
  wrap.append(avatar, bubble);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;
  return bubble;
}

function addCopyButton(bubble) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.title = "Copy";
  btn.innerHTML = "<i class='bx bx-copy'></i>";
  btn.onclick = () => navigator.clipboard.writeText(bubble.textContent);
  bubble.appendChild(btn);
}

/* ── Attachments ── */
const TEXT_EXT = /\.(txt|md|markdown|csv|json|py|js|ts|html|css|xml|yml|yaml|log|sql|sh|toml|ini)$/i;

function addAttachment(filename, content) {
  if (attachments.some((a) => a.filename === filename)) return;
  attachments.push({ filename, content });
  renderAttachments();
}

function renderAttachments() {
  const bar = $("attachmentsBar");
  bar.innerHTML = "";
  bar.classList.toggle("hidden", !attachments.length);
  for (const a of attachments) {
    const chip = document.createElement("span");
    chip.className = "att-chip";
    const name = document.createElement("span");
    name.textContent = a.filename;
    const x = document.createElement("button");
    x.innerHTML = "<i class='bx bx-x'></i>";
    x.onclick = () => {
      attachments = attachments.filter((v) => v !== a);
      renderAttachments();
    };
    chip.append(name, x);
    bar.appendChild(chip);
  }
}

async function handleFiles(files) {
  for (const f of files) {
    if (!TEXT_EXT.test(f.name)) continue;
    const text = await f.text();
    addAttachment(f.name, text.slice(0, 200_000));
  }
}

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
  } catch {}
}

async function loadNoteAttachments(noteId) {
  const sel = $("noteAttSelect");
  sel.innerHTML = "";
  try {
    const r = await fetch(`/api/notes/${noteId}/attachments`);
    const atts = (await r.json()).filter((a) => TEXT_EXT.test(a.filename));
    for (const a of atts) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.filename;
      sel.appendChild(o);
    }
  } catch {}
}

/* ── Send / stream ── */
function buildPayload(message) {
  const model = activeModel();
  const payload = {
    message,
    session_id: currentSessionId,
    model: model.id,
    system_prompt: $("systemPrompt").value.trim() || "You are a helpful assistant.",
    attachments,
  };
  const effort = activeEffort();
  if (effort && model.efforts && model.efforts.includes(effort)) {
    payload.reasoning_effort = effort;
  }
  return payload;
}

async function send() {
  if (streaming) return;
  const input = $("chatComposer");
  const message = input.value.trim();
  if (!message) return;

  input.value = "";
  input.style.height = "auto";
  addMessage("user", message);
  attachments = [];
  renderAttachments();

  const bubble = addMessage("assistant", "", { typing: true, noCopy: true });
  streaming = true;
  $("stopBtn").hidden = false;
  abortController = new AbortController();

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(message)),
      signal: abortController.signal,
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
        if (data.type === "meta") {
          currentSessionId = data.session_id;
          loadSessions();
        } else if (data.type === "delta") {
          bubble.textContent += data.text;
          bubble.classList.remove("typing");
          $("chatStream").scrollTop = $("chatStream").scrollHeight;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      bubble.textContent += `\n[error: ${err.message}]`;
    }
  } finally {
    bubble.classList.remove("typing");
    if (!bubble.textContent) bubble.textContent = "(stopped)";
    addCopyButton(bubble);
    streaming = false;
    $("stopBtn").hidden = true;
    abortController = null;
    loadSessions();
  }
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  loadModels();
  loadSessions();

  $("systemPrompt").value = localStorage.getItem(LS.sys) || "You are a helpful assistant.";
  $("systemPrompt").addEventListener("input", (e) =>
    localStorage.setItem(LS.sys, e.target.value)
  );
  $("sysPromptToggle").onclick = () => $("sysPromptEditor").classList.toggle("hidden");

  const savedCustom = localStorage.getItem(LS.custom);
  if (savedCustom) $("customModel").value = savedCustom;
  $("customModel").addEventListener("input", (e) => {
    localStorage.setItem(LS.custom, e.target.value);
    renderEfforts();
  });

  $("newChatBtn").onclick = newChat;
  $("sendBtn").onclick = send;
  $("stopBtn").onclick = () => abortController && abortController.abort();

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
  $("chatFileInput").addEventListener("change", (e) => {
    handleFiles([...e.target.files]);
    e.target.value = "";
  });

  $("attachNoteBtn").onclick = openNoteAttachModal;
  $("noteAttCancel").onclick = () => $("noteAttachModal").classList.add("hidden");
  $("noteAttAdd").onclick = async () => {
    const attId = $("noteAttSelect").value;
    if (!attId) return;
    try {
      const r = await fetch(`/api/attachments/${attId}/download`);
      const text = await r.text();
      const name = decodeURIComponent(
        (r.headers.get("content-disposition") || 'filename="file"').match(/filename="(.*)"/)[1]
      );
      addAttachment(name, text);
    } catch {}
    $("noteAttachModal").classList.add("hidden");
  };
});
