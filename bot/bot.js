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
const IMG_POLL_INTERVAL_MS = 4000;
const IMG_MAX_POLLS = 75;

// Image variants: default comes from IMAGE_TRIGGERS / IMG_MODEL.
// Additional variants from IMAGE_TRIGGERS_<KEY> / IMG_MODEL_<KEY>.
function loadImageVariants() {
  const variants = [];
  const defaultTriggers = (process.env.IMAGE_TRIGGERS || "/imagen,/img,/draw")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (defaultTriggers.length) {
    variants.push({ name: "default", triggers: defaultTriggers, model: process.env.IMG_MODEL || "" });
  }
  const keys = new Set();
  for (const k of Object.keys(process.env)) {
    let m;
    if ((m = k.match(/^IMAGE_TRIGGERS_(.+)$/))) keys.add(m[1]);
    if ((m = k.match(/^IMG_MODEL_(.+)$/))) keys.add(m[1]);
  }
  for (const key of keys) {
    const triggers = (process.env[`IMAGE_TRIGGERS_${key}`] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const model = process.env[`IMG_MODEL_${key}`] || "";
    if (!triggers.length) continue;
    variants.push({ name: key.toLowerCase(), triggers, model });
  }
  return variants;
}
const IMG_VARIANTS = loadImageVariants();

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
  groupTrigger: (process.env[`${name.toUpperCase()}_GROUP_TRIGGER`] || `@${name}`).toLowerCase(),
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
          signal: AbortSignal.timeout(180000),
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
  for (const v of IMG_VARIANTS) {
    for (const trig of v.triggers) {
      if (text === trig) return { variant: v, prompt: "" };
      if (text.startsWith(trig + " ")) return { variant: v, prompt: text.slice(trig.length).trim() };
    }
  }
  return null;
}

async function generateImage(prompt, model) {
  if (!IMG_URL) throw new Error("IMG_URL not configured");
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  const body = { prompt };
  if (model) body.model = model;

  let submit;
  try {
    submit = await fetch(`${IMG_URL}/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw new Error(`submit failed after ${elapsed()}s: ${err.message}`);
  }
  if (!submit.ok) {
    const errBody = await submit.text().catch(() => "");
    throw new Error(`submit HTTP ${submit.status} after ${elapsed()}s: ${errBody}`);
  }
  const submitData = await submit.json();
  const jobId = submitData.job_id;
  if (!jobId) throw new Error(`no job_id in submit response after ${elapsed()}s`);

  for (let i = 0; i < IMG_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, IMG_POLL_INTERVAL_MS));
    let poll;
    try {
      poll = await fetch(`${IMG_URL}/v1/jobs/${jobId}`, {
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      console.warn(`[img ${jobId}] poll error at ${elapsed()}s: ${err.message}`);
      continue;
    }
    if (!poll.ok) continue;
    const data = await poll.json();
    if (data.status === "done") {
      const filename = data.images?.[0];
      if (!filename) throw new Error(`no filename in done response after ${elapsed()}s`);
      let dl;
      try {
        dl = await fetch(`${IMG_URL}/outputs/${filename}`, {
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        throw new Error(`download failed after ${elapsed()}s: ${err.message}`);
      }
      if (!dl.ok) throw new Error(`download HTTP ${dl.status} after ${elapsed()}s`);
      const buffer = Buffer.from(await dl.arrayBuffer());
      return { buffer, filename, elapsedSec: elapsed() };
    }
    if (data.status === "failed") {
      throw new Error(`generation failed after ${elapsed()}s: ${data.error || "unknown"}`);
    }
  }
  throw new Error(`timed out after ${elapsed()}s waiting for image (job ${jobId})`);
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
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const rawText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption;
      if (!rawText) continue;

      const jid = msg.key.remoteJid;
      const sender = msg.pushName || (msg.key.participant || jid).split("@")[0];
      const group = isGroup(jid);

      let text;
      if (group) {
        const lowerRaw = rawText.toLowerCase();
        const idx = lowerRaw.indexOf(persona.groupTrigger);
        if (idx === -1) {
          console.log(`${tag}[GROUP-skip][${sender}] ${rawText.slice(0, 80)}`);
          continue;
        }
        text = (rawText.slice(0, idx) + rawText.slice(idx + persona.groupTrigger.length)).trim();
      } else {
        text = rawText.trim();
      }
      if (!text) continue;

      console.log(`${tag}[${group ? "GROUP" : "DM"}][${sender}] ${text}`);

      const imgCmd = parseImageCommand(text);
      const isImage = imgCmd !== null && IMG_URL;

      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);

      const thinkingMsg = await sock.sendMessage(jid, {
        text: isImage ? IMAGE_THINKING_MSG : THINKING_MSG,
      });

      try {
        if (isImage) {
          if (!imgCmd.prompt) {
            await sock.sendMessage(jid, {
              text: "¿Qué quieres que dibuje?",
              edit: thinkingMsg.key,
            });
          } else {
            console.log(`${tag}[img:${imgCmd.variant.name}] ${imgCmd.prompt}`);
            const img = await generateImage(imgCmd.prompt, imgCmd.variant.model);
            await sock.sendMessage(jid, {
              image: img.buffer,
              caption: imgCmd.prompt,
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
for (const v of IMG_VARIANTS) {
  console.log(`  variant ${v.name}: ${v.triggers.join(", ")} → ${v.model || "(server default)"}`);
}
console.log(`Search: ${SEARCH_URL ? SEARCH_URL : "(disabled)"}`);
console.log(`Personas: ${PERSONAS.map((p) => `${p.name} (DM=any, group="${p.groupTrigger}") → ${p.model}`).join(", ")}`);

for (const persona of PERSONAS) {
  startPersona(persona).catch((err) =>
    console.error(`[${persona.name}] failed to start:`, err)
  );
}
