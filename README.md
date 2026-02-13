# Funkyboy WhatsApp

WhatsApp chatbot that connects to a Funkyboy AI backend. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) (no Chromium, no API keys, no WhatsApp Business approval needed).

## Setup

```bash
cp .env.example .env
# Edit .env if you want to customize settings
```

## Commands

```bash
# Start (requires funkyboy-local-model running first)
docker compose up -d --build

# See QR code and scan with WhatsApp > Settings > Linked Devices
docker compose logs -f bot

# Stop
docker compose down

# Logs
docker logs -f funkyboy-whatsapp

# Rebuild after code changes
docker compose up -d --build bot
```

## How it works

- Only responds to messages starting with the prefix
  - Example: `.alpacino what is the meaning of life`
- Session persists in a Docker volume (`wa-auth`) — only scan QR once

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `THINKING_MSG` | No | Loading message (default: `"un momento..."`) |
| `PREFIX` | No | Required prefix on all messages (default: `.alpacino`) |
| `FUNKYBOY_LOCAL_MODEL_HOST` | No | Funkyboy instance name (default: funkyboy-local-model) |
| `FUNKYBOY_LOCAL_MODEL_PORT` | No | Funkyboy API port (default: 8080) |

## Troubleshooting

- **Bot won't connect (405 error)**: The WhatsApp Web version in `bot/bot.js` may have expired. Update it from [wppconnect.io/whatsapp-versions](https://wppconnect.io/whatsapp-versions/)
- **Need to re-scan QR**: `docker volume rm funkyboy-whatsapp_wa-auth` and restart the bot
