#!/bin/bash
# Stop all bot instances from .env.* files

for f in .env.*; do
  [ "$f" = ".env.example" ] && continue
  name="${f#.env.}"
  echo "Stopping $name..."
  docker compose -p "$name" \
    -f docker-compose.yml -f docker-compose.ollama.yml down
done

echo "All agents stopped."
