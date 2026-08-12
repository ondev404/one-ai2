const BASE = "https://notrack.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

async function getCookie() {
  const r = await fetch(BASE + "/chat", {
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" },
    redirect: "follow"
  });
  const setCookie = r.headers.get("set-cookie") || "";
  return setCookie
    .split(/,(?=[^;,]+=)/)
    .map(s => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function sendJson(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(obj));
}

async function ask(message) {
  const cookie = await getCookie();

  const body = {
    user_input: message,
    mode: "usual",
    model: "C",
    persona: "normal",
    max_turns: 6,
    chat_id: null,
    attachments: [],
    regenerate: false,
    edit: false,
    edit_mid: null
  };

  const headers = {
    "User-Agent": UA,
    "Accept": "text/event-stream, application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": BASE,
    "Referer": BASE + "/chat"
  };
  if (cookie) headers.Cookie = cookie;

  const r = await fetch(BASE + "/api/dispatch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "follow"
  });

  const contentType = r.headers.get("content-type") || "";
  const raw = await r.text();

  if (!r.ok) {
    throw new Error("NoTrack HTTP " + r.status + ": " + raw.slice(0, 500));
  }

  // Some upstream errors are returned as HTML/text instead of SSE.
  if (!contentType.includes("text/event-stream") && !contentType.includes("application/json")) {
    const preview = raw.replace(/\s+/g, " ").slice(0, 300);
    throw new Error("Respons upstream bukan SSE/JSON: " + preview);
  }

  let full = "";
  let chatId = null;
  let mode = null;

  // Handle JSON response too, in case upstream changes format.
  if (contentType.includes("application/json")) {
    try {
      const data = JSON.parse(raw);
      full = data.response || data.content || data.message || "";
      return { response: full, chat_id: data.chat_id || null, mode: data.mode || null };
    } catch {
      throw new Error("Respons JSON upstream tidak valid: " + raw.slice(0, 300));
    }
  }

  // Parse SSE.
  for (const block of raw.split(/\n\n+/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;

      try {
        const ev = JSON.parse(payload);
        if (ev.type === "chat_meta") {
          chatId = ev.chat_id || chatId;
          mode = ev.mode || mode;
        }
        if (ev.type === "delta") full += ev.chunk || "";
        if (ev.type === "message" && ev.content) full = ev.content;
      } catch {
        // Ignore malformed SSE events.
      }
    }
  }

  if (!full) {
    throw new Error("NoTrack tidak mengirim jawaban. Respons: " + raw.slice(0, 500));
  }

  return { response: full, chat_id: chatId, mode };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method tidak diizinkan" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const message = body && typeof body.message === "string"
      ? body.message.trim()
      : "";

    if (!message) {
      return sendJson(res, 400, { ok: false, error: "Pesan kosong" });
    }

    if (message.length > 8000) {
      return sendJson(res, 400, { ok: false, error: "Pesan terlalu panjang (maksimal 8000 karakter)" });
    }

    const result = await ask(message);
    return sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error("oneAi API error:", e);
    return sendJson(res, 500, {
      ok: false,
      error: e && e.message ? e.message : "Server error"
    });
  }
};