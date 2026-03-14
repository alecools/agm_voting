#!/bin/bash
set -euo pipefail

# Resolve the repo root regardless of the caller's working directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Normalise DATABASE_URL_UNPOOLED for asyncpg / alembic
DB=$(python3 - <<'PYEOF'
import os
u = os.environ["DATABASE_URL_UNPOOLED"]
u = u.replace("postgres://", "postgresql+asyncpg://", 1) \
     .replace("postgresql://", "postgresql+asyncpg://", 1) \
     .replace("sslmode=require", "ssl=require") \
     .replace("&channel_binding=require", "") \
     .replace("channel_binding=require&", "") \
     .replace("channel_binding=require", "")
print(u)
PYEOF
)

cd "$REPO_ROOT/backend"
python -m alembic -x dburl="$DB" upgrade head
