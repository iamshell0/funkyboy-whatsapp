# Dolphin WhatsApp Bot

Uncensored WhatsApp chatbot powered by Dolphin LLama3 8B running locally via Ollama + GPU. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) (no Chromium, no API keys, no WhatsApp Business approval needed).

## Setup

```bash
cp .env.example .env
# Edit .env if you want to customize settings
```

## Commands

```bash
# Start Ollama
docker compose up -d dolphin

# Pull the base model (first time only, ~4.7GB)
docker exec dolphin-wa ollama pull dolphin-llama3:8b

# Create the custom model from Modelfile
docker cp Modelfile dolphin-wa:/tmp/Modelfile
docker exec dolphin-wa ollama create dolphin-unleashed -f /tmp/Modelfile

# Start the bot
docker compose up -d bot

# See QR code and scan with WhatsApp > Settings > Linked Devices
docker compose logs -f bot

# Stop everything
docker compose down

# Logs
docker logs -f dolphin-wa-bot

# Rebuild after code changes
docker compose up -d --build bot
```

## How it works

- **DMs**: Responds to all messages
- **Groups**: Only responds to messages starting with `/alpacino420`
  - Example: `/alpacino420 what is the meaning of life`
- Session persists in a Docker volume (`wa-auth`) — only scan QR once

## Environment Variables

| Variable       | Required | Description                                  |
|----------------|----------|----------------------------------------------|
| `THINKING_MSG` | No       | Loading message (default: `"un momento..."`) |
| `GROUP_PREFIX` | No       | Group trigger command (default: `/alpacino420`) |

## Troubleshooting

- **Bot won't connect (405 error)**: The WhatsApp Web version in `bot/bot.js` (line 41) may have expired. Update it from [wppconnect.io/whatsapp-versions](https://wppconnect.io/whatsapp-versions/)
- **Need to re-scan QR**: `docker volume rm dolpin-whatsapp-docker_wa-auth` and restart the bot
- **"No response"**: Make sure the `dolphin-unleashed` model exists: `docker exec dolphin-wa ollama list`
