/* connections.js — provider key/base-URL management page. */

const $ = (id) => document.getElementById(id);

function maskHint(entry) {
  if (entry.api_key_masked) return `Saved: ${entry.api_key_masked}`;
  if (!entry.needs_key && entry.base_url) return `Base URL: ${entry.base_url}`;
  if (!entry.needs_key) return "No key needed (local)";
  return entry.env_var ? `Falls back to env var ${entry.env_var}` : "";
}

function render(providers) {
  const grid = $("providerGrid");
  const tpl = $("providerCardTpl");
  grid.innerHTML = "";
  for (const p of providers) {
    const card = tpl.content.cloneNode(true);
    const root = card.querySelector(".conn-card");
    root.dataset.provider = p.id;
    card.querySelector(".conn-card__name").textContent = p.label;

    const status = card.querySelector(".conn-status");
    status.textContent = p.configured ? "● connected" : "○ not connected";
    status.classList.add(p.configured ? "ok" : "off");

    const keyInput = card.querySelector(".conn-key");
    keyInput.placeholder = p.api_key_masked || "sk-…";
    if (!p.needs_key) keyInput.closest("label").style.display = "none";

    const urlInput = card.querySelector(".conn-url");
    urlInput.value = p.base_url || "";

    const result = card.querySelector(".conn-result");
    const hint = maskHint(p);
    if (hint) result.textContent = hint;

    card.querySelector(".conn-save").onclick = () => save(root, p.id, result);
    card.querySelector(".conn-test").onclick = () => test(root, p.id, result);
    grid.appendChild(card);
  }
}

async function refresh() {
  try {
    const r = await fetch("/api/connections");
    if (!r.ok) throw new Error(`HTTP ${r.status} from /api/connections`);
    render(await r.json());
  } catch (e) {
    $("providerGrid").innerHTML =
      `<p class='conn-sub'>Failed to load connections: ${e.message}. Is the server running?</p>`;
  }
}

async function save(card, pid, result) {
  const body = {};
  const key = card.querySelector(".conn-key").value.trim();
  const url = card.querySelector(".conn-url").value.trim();
  if (key) body.api_key = key;
  if (url) body.base_url = url;
  result.textContent = "Saving…";
  try {
    const r = await fetch(`/api/connections/${pid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || r.status);
    result.textContent = "✔ Saved";
    refreshSoon();
  } catch (e) {
    result.textContent = `✖ ${e.message}`;
  }
}

async function test(card, pid, result) {
  result.textContent = "Testing…";
  try {
    const r = await fetch(`/api/connections/${pid}/test`, { method: "POST" });
    const data = await r.json();
    result.textContent = data.ok
      ? `✔ OK (${data.latency_ms} ms)`
      : `✖ ${data.error || "failed"}`;
  } catch (e) {
    result.textContent = `✖ ${e.message}`;
  }
}

async function removeConn(card, pid, result) {
  if (!confirm(`Remove saved credentials for ${pid}?`)) return;
  try {
    await fetch(`/api/connections/${pid}`, { method: "DELETE" });
    result.textContent = "Deleted";
    refreshSoon();
  } catch (e) {
    result.textContent = `✖ ${e.message}`;
  }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 600);
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  // Wire delete buttons via delegation (template cloning keeps it simple)
  $("providerGrid").addEventListener("click", (e) => {
    const btn = e.target.closest(".conn-del");
    if (!btn) return;
    const card = btn.closest(".conn-card");
    removeConn(card, card.dataset.provider, card.querySelector(".conn-result"));
  });
});
