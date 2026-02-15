# Funkyboy WhatsApp

WhatsApp chatbot that connects to a Funkyboy AI backend. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) (no Chromium, no API keys, no WhatsApp Business approval needed).

## Setup

```bash
cp .env.example .env
# Edit .env if you want to customize settings
```

## Commands

```bash
# Start with Funkyboy (default, requires funkyboy-local-model running first)
docker compose up -d --build

# Start with Ollama
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build

# See QR code and scan with WhatsApp > Settings > Linked Devices
docker compose logs -f bot

# Stop
docker compose down

# Logs
docker logs -f funkyboy-whatsapp

# Rebuild after code changes
docker compose up -d --build bot
```

## Ollama Support

The bot can use [Ollama](https://ollama.com) as an alternative backend. Ollama runs on the host machine (not inside Docker).

1. Install and run Ollama on your server
2. Pull your model: `ollama pull <model-name>`
3. Configure Ollama to accept connections from Docker. By default Ollama only listens on `127.0.0.1`, which blocks Docker containers from connecting:
   ```bash
   sudo systemctl edit ollama
   ```
   Add the following and save:
   ```
   [Service]
   Environment="OLLAMA_HOST=0.0.0.0"
   ```
   Then restart Ollama:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart ollama
   ```
   Verify it's listening on all interfaces:
   ```bash
   ss -tlnp | grep 11434
   # Should show *:11434 instead of 127.0.0.1:11434
   ```
   **Security note:** This exposes Ollama on all interfaces. Use a firewall to restrict access to Docker only:
   ```bash
   sudo ufw allow from 172.16.0.0/12 to any port 11434
   sudo ufw deny from any to any port 11434
   ```
4. Add to your `.env`:
   ```
   BACKEND=ollama
   OLLAMA_MODEL=<model-name>
   ```
5. Start with the Ollama override:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build
   ```

The override replaces the external Funkyboy network with a local one, while `extra_hosts` in the base compose file lets the container reach Ollama on the host via `host.docker.internal`.

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
| `BACKEND` | No | `funkyboy` (default) or `ollama` |
| `OLLAMA_URL` | No | Ollama API URL (default: `http://host.docker.internal:11434`) |
| `OLLAMA_MODEL` | No | Ollama model name (default: `llama3`) |

## Troubleshooting

- **Bot won't connect (405 error)**: The WhatsApp Web version in `bot/bot.js` may have expired. Update it from [wppconnect.io/whatsapp-versions](https://wppconnect.io/whatsapp-versions/)
- **Need to re-scan QR**: `docker volume rm funkyboy-whatsapp_wa-auth` and restart the bot
