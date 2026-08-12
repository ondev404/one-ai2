
const BASE = "https://notrack.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function getSessionCookie() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const r = await fetch(BASE + "/chat", {
      headers: {
        "User-Agent": UA,
        "Cache-Control": "no-cache"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const sc = r.headers.get("set-cookie") || "";

    return sc
      .split(/,(?=[^;,]+=)/)
      .map(x => x.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  } finally {
    clearTimeout(timer);
  }
}

async function dispatch(message) {
  const cookie = await getSessionCookie();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const headers = {
      "User-Agent": UA,
      "Accept": "text/event-stream",
      "Content-Type": "application/json",
      "Origin": BASE,
      "Referer": BASE + "/chat"
    };

    if (cookie) headers.Cookie = cookie;

    const body = JSON.stringify({
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
    });

    const r = await fetch(BASE + "/api/dispatch", {
      method: "POST",
      headers,
      body,
      redirect: "follow",
      signal: controller.signal
    });

    const contentType = r.headers.get("content-type") || "";

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error("NoTrack HTTP " + r.status + ": " + text.slice(0, 300));
    }

    if (!r.body) throw new Error("NoTrack tidak mengirim response body");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let chatId = null;
    let mode = null;
    let finished = false;

    while (!finished) {
      const part = await reader.read();
      if (part.done) break;

      buffer += decoder.decode(part.value, { stream: true });

      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (!payload) continue;

          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }

          if (ev.type === "chat_meta") {
            chatId = ev.chat_id || chatId;
            mode = ev.mode || mode;
          }

          if (ev.type === "delta") {
            full += ev.chunk || "";
          }

          if (ev.type === "message") {
            if (ev.content) full = ev.content;
          }

          if (ev.type === "done") {
            finished = true;
            break;
          }

          if (ev.type === "error") {
            throw new Error(ev.message || ev.error || "NoTrack mengirim error");
          }
        }

        if (finished) break;
      }
    }

    try { await reader.cancel(); } catch {}

    if (!full.trim()) {
      throw new Error(
        "NoTrack tidak mengirim teks jawaban. Content-Type: " + contentType
      );
    }

    return {
      response: full,
      chat_id: chatId,
      mode
    };
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("Request ke NoTrack timeout (45 detik)");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method tidak diizinkan"
    });
  }

  try {
    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return json(res, 400, {
          ok: false,
          error: "Body request bukan JSON valid"
        });
      }
    }

    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : "";

    if (!message) {
      return json(res, 400, {
        ok: false,
        error: "Pesan kosong"
      });
    }

    if (message.length > 8000) {
      return json(res, 400, {
        ok: false,
        error: "Pesan terlalu panjang. Maksimal 8000 karakter."
      });
    }

    const result = await dispatch(message);

    return json(res, 200, {
      ok: true,
      ...result
    });
  } catch (e) {
    console.error("oneAi error:", e);

    return json(res, 500, {
      ok: false,
      error: e && e.message
        ? e.message
        : "Gagal menghubungi server AI"
    });
  }
};
