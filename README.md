# Funkyboy WhatsApp

WhatsApp chatbot that talks to a local OpenAI-compatible LLM, with optional async image generation. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) — no Chromium, no API keys, no WhatsApp Business approval.

A single container can run any number of concurrent **personas**, each linked to its own WhatsApp account, each with its own system prompt and (optionally) its own model.

## Setup

```bash
cp .env.example .env
mkdir -p prompts
# Edit .env: set LLM_URL, list your personas in PERSONAS=
# Create prompts/<name>.md for each persona you listed
```

Set `LLM_URL` to your OpenAI-compatible server (llama.cpp, vLLM, llama-swap, Ollama with `/v1`, etc.). Anything that serves `${LLM_URL}/chat/completions` works.

`LLM_URL` accepts a comma-separated list for failover — the bot tries each URL in order on connection error or 5xx. Example:
```env
LLM_URL=https://primary/v1,https://fallback/v1
```

## Defining personas

Personas are configured entirely via env vars and prompt files. List the names in `PERSONAS=`, then create a system prompt at `prompts/<name>.md`.

| Config | Required | Description |
|---|---|---|
| `prompts/<name>.md` | Yes (or env fallback) | Multi-line system prompt for this persona |
| `{NAME}_PROMPT` | Fallback | Used only if `prompts/<name>.md` is missing |
| `{NAME}_PREFIX` | No | Trigger prefix (default `.{name}`) |
| `{NAME}_MODEL` | No | Per-persona model override (default `LLM_MODEL`) |

Names must be lowercase, `[a-z][a-z0-9_]*`.

```env
PERSONAS=alice,bob
BOB_MODEL=glm-4.7-flash
```

```
prompts/alice.md   ← Alice's system prompt
prompts/bob.md     ← Bob's system prompt
```

`.alice ...` in WhatsApp goes to Alice; `.bob ...` goes to Bob.

## Image generation

Optional — set `IMG_URL` to enable. When set, any persona will accept image-trigger prefixes inside its message:

```
.alice /imagen un atardecer en la playa
.alice /draw cyberpunk city, neon
```

Triggers (configurable via `IMAGE_TRIGGERS=`) default to `/imagen`, `/img`, `/draw`. The bot:

1. POSTs `{prompt}` to `${IMG_URL}/v1/generate`
2. Polls `${IMG_URL}/v1/jobs/{id}` every 4s (max 5 minutes)
3. Downloads the PNG from `${IMG_URL}/outputs/{filename}`
4. Sends it to WhatsApp as an image with the prompt as caption

Works with any backend matching that contract. Set `IMG_MODEL=` to pin a checkpoint.

## Commands

```bash
# Start (docker compose or podman-compose)
docker compose up -d --build
# or
podman-compose up -d --build

# Watch logs — one QR per persona, labeled
docker compose logs -f bot

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build bot
```

## How it works

- Each persona has its own WhatsApp account, its own auth folder under the `wa-auth` volume (`/app/auth/<name>`), and its own system prompt.
- A persona only responds to messages starting with its prefix.
- Sessions persist in the `wa-auth` volume — only scan each QR once.
- Prompt files (`prompts/<name>.md`) are read at startup. Restart the container to pick up changes.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LLM_URL` | No | OpenAI-compatible base URL(s); comma-separated for failover (default `http://localhost:8080/v1`) |
| `LLM_MODEL` | No | Default model (default `qwen3.5-9b`) |
| `LLM_API_KEY` | No | Bearer token (default `sk-local`; many local servers ignore it) |
| `IMG_URL` | No | Image-gen base URL; leave empty to disable |
| `IMG_MODEL` | No | Default image checkpoint |
| `IMAGE_TRIGGERS` | No | Comma-separated triggers (default `/imagen,/img,/draw`) |
| `THINKING_MSG` | No | Loading message for chat |
| `IMAGE_THINKING_MSG` | No | Loading message for image gen |
| `PERSONAS` | Yes | Comma-separated persona names |
| `{NAME}_PREFIX` | No | Trigger prefix (default `.{name}`) |
| `{NAME}_MODEL` | No | Per-persona model override |
| `{NAME}_PROMPT` | No | Fallback if `prompts/<name>.md` is missing |

## Llama-swap caveat

If your backend is `llama-swap` (or anything that hot-loads one model at a time), giving each persona a different `{NAME}_MODEL` will trigger a model swap whenever traffic alternates. For smooth multi-persona use, give them all the same model.

## Troubleshooting

- **Bot won't connect (405 error)**: The WhatsApp Web version in `bot/bot.js` may have expired. Update from [wppconnect.io/whatsapp-versions](https://wppconnect.io/whatsapp-versions/).
- **Re-scan one persona's QR**: `docker compose exec bot rm -rf /app/auth/<name>` and restart.
- **Reset all sessions**: `docker volume rm funkyboy-whatsapp_wa-auth` and restart.
- **Podman + SELinux**: the prompts mount uses `:ro,Z` to relabel. If your podman is old enough not to grok the `Z` flag, drop it and run `chcon -Rt container_file_t prompts/` manually.
