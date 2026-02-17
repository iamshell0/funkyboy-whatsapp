const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const BACKEND = (process.env.BACKEND || "funkyboy").toLowerCase();
const FUNKYBOY_URL = process.env.FUNKYBOY_URL;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://host.docker.internal:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const THINKING_MSG = process.env.THINKING_MSG || "Thinking...";
const PREFIX = process.env.PREFIX || ".alpacino";

async function askFunkyboy(prompt) {
  try {
    const res = await fetch(`${FUNKYBOY_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    return data.response || "No response.";
  } catch (err) {
    console.error("Funkyboy error:", err.message);
    return "Sorry, brain is offline.";
  }
}

async function askOllama(prompt) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    return data.response || "No response.";
  } catch (err) {
    console.error("Ollama error:", err.message);
    return "Sorry, brain is offline.";
  }
}

async function askAI(prompt) {
  if (BACKEND === "ollama") return askOllama(prompt);
  return askFunkyboy(prompt);
}

function isGroup(jid) {
  return jid.endsWith("@g.us");
}

let activeSock = null;

async function start() {
  // Clean up previous socket listeners to prevent duplicate message handling
  if (activeSock) {
    activeSock.ev.removeAllListeners();
    activeSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState("/app/auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    version: [2, 3000, 1033307183],
    browser: Browsers.ubuntu("Chrome"),
  });
  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("\n========== SCAN THIS QR CODE ==========");
      qrcode.generate(qr, { small: true });
      console.log("=======================================\n");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("Connection closed. Status code:", statusCode, "Error:", lastDisconnect?.error?.message || lastDisconnect?.error);
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Reconnecting in 3s...");
        setTimeout(start, 3000);
      } else {
        console.log(
          "Logged out. Delete the auth volume and restart to re-authenticate."
        );
      }
    } else if (connection === "open") {
      console.log("WhatsApp connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const rawText =
        msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!rawText) continue;

      const jid = msg.key.remoteJid;
      const sender = msg.pushName || jid.split("@")[0];
      const group = isGroup(jid);

      let text;
      if (group) {
        if (!rawText.startsWith(PREFIX)) continue;
        text = rawText.slice(PREFIX.length).trim();
      } else {
        text = rawText.trim();
      }
      if (!text) continue;

      console.log(`[${group ? "GROUP" : "DM"}][${sender}] ${text}`);

      // Show typing indicator
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);

      // Send thinking message
      const thinkingMsg = await sock.sendMessage(jid, { text: THINKING_MSG });

      const reply = await askAI(text);

      // Stop typing
      await sock.sendPresenceUpdate("paused", jid);

      // Edit thinking message with the actual reply
      await sock.sendMessage(jid, {
        text: reply,
        edit: thinkingMsg.key,
      });
    }
  });
}

console.log("Starting Funkyboy WhatsApp bot...");
console.log(`Backend: ${BACKEND}`);
if (BACKEND === "ollama") {
  console.log(`Ollama: ${OLLAMA_URL} (model: ${OLLAMA_MODEL})`);
} else {
  console.log(`Funkyboy: ${FUNKYBOY_URL}`);
}
start();
