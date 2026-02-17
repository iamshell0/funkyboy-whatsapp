#!/bin/bash
# Start all bot instances from .env.* files

for f in .env.*; do
  [ "$f" = ".env.example" ] && continue
  name="${f#.env.}"
  echo "Starting $name..."
  docker compose -p "$name" --env-file "$f" \
    -f docker-compose.yml -f docker-compose.ollama.yml up -d --build
done

echo "All agents started."
