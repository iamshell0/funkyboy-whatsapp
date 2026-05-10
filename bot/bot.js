const fs = require("fs");
const path = require("path");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const LLM_URLS = (process.env.LLM_URL || "http://localhost:8080/v1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LLM_MODEL = process.env.LLM_MODEL || "qwen3.5-9b";
const LLM_API_KEY = process.env.LLM_API_KEY || "sk-local";

const IMG_URL = process.env.IMG_URL || "";
const IMG_MODEL = process.env.IMG_MODEL || "";
const IMG_TRIGGERS = (process.env.IMAGE_TRIGGERS || "/imagen,/img,/draw")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const IMG_POLL_INTERVAL_MS = 4000;
const IMG_MAX_POLLS = 75;

const SEARCH_URL = process.env.SEARCH_URL || "";

const PROMPTS_DIR = process.env.PROMPTS_DIR || "/app/prompts";
const THINKING_MSG = process.env.THINKING_MSG || "Thinking...";
const IMAGE_THINKING_MSG = process.env.IMAGE_THINKING_MSG || "Generando imagen...";

const personaNames = (process.env.PERSONAS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (personaNames.length === 0) {
  console.error("No personas configured. Set PERSONAS in your .env, e.g. PERSONAS=alice,bob");
  process.exit(1);
}

for (const name of personaNames) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    console.error(`Invalid persona name "${name}". Use lowercase letters/digits/underscores, starting with a letter.`);
    process.exit(1);
  }
}

function loadPrompt(name) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  try {
    const fileContent = fs.readFileSync(filePath, "utf8").trim();
    if (fileContent) return fileContent;
  } catch (_) {}
  return process.env[`${name.toUpperCase()}_PROMPT`] || "";
}

const PERSONAS = personaNames.map((name) => ({
  name,
  prompt: loadPrompt(name),
  prefix: process.env[`${name.toUpperCase()}_PREFIX`] || `.${name}`,
  model: process.env[`${name.toUpperCase()}_MODEL`] || LLM_MODEL,
}));

for (const p of PERSONAS) {
  if (!p.prompt) {
    console.warn(
      `[${p.name}] no prompt found at ${PROMPTS_DIR}/${p.name}.md or ${p.name.toUpperCase()}_PROMPT — running with empty system prompt.`
    );
  }
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information, news, facts, or anything you are not certain about.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
};

async function searchWeb(query) {
  const url = `${SEARCH_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || []).slice(0, 5)
    .map((r) => `${r.title}\n${r.url}\n${r.content || ""}`.trim())
    .join("\n\n");
  return results || "No results found.";
}

async function chat(model, systemPrompt, userPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const tools = SEARCH_URL ? [SEARCH_TOOL] : undefined;

  let lastErr;
  outer: for (const baseUrl of LLM_URLS) {
    try {
      for (let round = 0; round < 4; round++) {
        const body = { model, messages };
        if (tools) { body.tools = tools; body.tool_choice = "auto"; }

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LLM_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          if (res.status >= 500) {
            lastErr = new Error(`${baseUrl} HTTP ${res.status}: ${errBody}`);
            console.warn(`LLM ${baseUrl} returned ${res.status}, trying next endpoint`);
            continue outer;
          }
          console.error(`LLM ${baseUrl} HTTP ${res.status}:`, errBody);
          return "Sorry, brain is offline.";
        }

        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        if (!msg) return "No response.";

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          return msg.content?.trim() || "No response.";
        }

        messages.push(msg);
        for (const tc of msg.tool_calls) {
          let result = "Unknown tool.";
          if (tc.function.name === "web_search") {
            try {
              const args = JSON.parse(tc.function.arguments);
              result = await searchWeb(args.query);
              console.log(`[search] "${args.query}" → ${result.length} chars`);
            } catch (e) {
              result = `Search error: ${e.message}`;
            }
          }
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }
      // exhausted rounds — return last assistant message
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      return last?.content?.trim() || "No response.";
    } catch (err) {
      lastErr = err;
      console.warn(`LLM ${baseUrl} failed: ${err.message}`);
    }
  }
  console.error("All LLM endpoints failed:", lastErr?.message);
  return "Sorry, brain is offline.";
}

function parseImageCommand(text) {
  for (const trig of IMG_TRIGGERS) {
    if (text === trig) return "";
    if (text.startsWith(trig + " ")) return text.slice(trig.length).trim();
  }
  return null;
}

async function generateImage(prompt) {
  if (!IMG_URL) throw new Error("IMG_URL not configured");

  const body = { prompt };
  if (IMG_MODEL) body.model = IMG_MODEL;

  const submit = await fetch(`${IMG_URL}/v1/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!submit.ok) {
    const errBody = await submit.text().catch(() => "");
    throw new Error(`submit failed: ${submit.status} ${errBody}`);
  }
  const submitData = await submit.json();
  const jobId = submitData.job_id;
  if (!jobId) throw new Error("no job_id in submit response");

  for (let i = 0; i < IMG_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, IMG_POLL_INTERVAL_MS));
    const poll = await fetch(`${IMG_URL}/v1/jobs/${jobId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!poll.ok) continue;
    const data = await poll.json();
    if (data.status === "done") {
      const filename = data.images?.[0];
      if (!filename) throw new Error("no filename in done response");
      const dl = await fetch(`${IMG_URL}/outputs/${filename}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!dl.ok) throw new Error(`download failed: ${dl.status}`);
      const buffer = Buffer.from(await dl.arrayBuffer());
      return { buffer, filename };
    }
    if (data.status === "failed") {
      throw new Error(`generation failed: ${data.error || "unknown"}`);
    }
  }
  throw new Error("timed out waiting for image");
}

function isGroup(jid) {
  return jid.endsWith("@g.us");
}

async function startPersona(persona) {
  const tag = `[${persona.name}]`;
  const authDir = `/app/auth/${persona.name}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    version: [2, 3000, 1033307183],
    browser: Browsers.ubuntu("Chrome"),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log(`\n========== SCAN QR FOR ${persona.name.toUpperCase()} ==========`);
      qrcode.generate(qr, { small: true });
      console.log("=================================================\n");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(
        `${tag} Connection closed. Status:`,
        statusCode,
        "Error:",
        lastDisconnect?.error?.message || lastDisconnect?.error
      );
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`${tag} Reconnecting in 3s...`);
        setTimeout(() => startPersona(persona), 3000);
      } else {
        console.log(
          `${tag} Logged out. Delete ${authDir} (in the wa-auth volume) and restart to re-authenticate.`
        );
      }
    } else if (connection === "open") {
      console.log(`${tag} WhatsApp connected!`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!rawText) continue;
      if (!rawText.startsWith(persona.prefix)) continue;

      const text = rawText.slice(persona.prefix.length).trim();
      if (!text) continue;

      const jid = msg.key.remoteJid;
      const sender = msg.pushName || jid.split("@")[0];
      const group = isGroup(jid);

      console.log(`${tag}[${group ? "GROUP" : "DM"}][${sender}] ${text}`);

      const imgPrompt = parseImageCommand(text);
      const isImage = imgPrompt !== null && IMG_URL;

      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);

      const thinkingMsg = await sock.sendMessage(jid, {
        text: isImage ? IMAGE_THINKING_MSG : THINKING_MSG,
      });

      try {
        if (isImage) {
          if (!imgPrompt) {
            await sock.sendMessage(jid, {
              text: "¿Qué quieres que dibuje?",
              edit: thinkingMsg.key,
            });
          } else {
            const img = await generateImage(imgPrompt);
            await sock.sendMessage(jid, {
              image: img.buffer,
              caption: imgPrompt,
            });
            await sock.sendMessage(jid, { text: "✓", edit: thinkingMsg.key });
          }
        } else {
          const reply = await chat(persona.model, persona.prompt, text);
          await sock.sendMessage(jid, { text: reply, edit: thinkingMsg.key });
        }
      } catch (err) {
        console.error(`${tag} handler error:`, err.message);
        await sock.sendMessage(jid, {
          text: `Error: ${err.message}`,
          edit: thinkingMsg.key,
        });
      } finally {
        await sock.sendPresenceUpdate("paused", jid);
      }
    }
  });
}

console.log("Starting Funkyboy WhatsApp bot...");
console.log(`LLM endpoints: ${LLM_URLS.join(" → ")} (default model: ${LLM_MODEL})`);
console.log(`Image gen: ${IMG_URL ? IMG_URL : "(disabled)"}`);
console.log(`Image triggers: ${IMG_TRIGGERS.join(", ")}`);
console.log(`Search: ${SEARCH_URL ? SEARCH_URL : "(disabled)"}`);
console.log(`Personas: ${PERSONAS.map((p) => `${p.name} ${p.prefix} → ${p.model}`).join(", ")}`);

for (const persona of PERSONAS) {
  startPersona(persona).catch((err) =>
    console.error(`[${persona.name}] failed to start:`, err)
  );
}
