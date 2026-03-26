#!/bin/bash
set -euo pipefail
# Prevent shell trace mode (set -x) from echoing DATABASE_URL or other secrets
# into build logs. set +x is a no-op when trace mode is not active, so this is
# safe to include unconditionally.
set +x

# Resolve the repo root regardless of the caller's working directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Normalise DATABASE_URL_UNPOOLED for asyncpg / alembic using urllib.parse
# so that individual query-string parameters are handled correctly regardless
# of their order, without fragile substring replacement.
DB=$(python3 - "$DATABASE_URL_UNPOOLED" << 'PYEOF_INNER'
import sys
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
url = sys.argv[1]
p = urlparse(url)
qs = {k: v[0] for k, v in parse_qs(p.query, keep_blank_values=True).items()}
qs.pop('channel_binding', None)
qs.pop('sslmode', None)
qs['ssl'] = 'require'
print(urlunparse(p._replace(scheme='postgresql+asyncpg', query=urlencode(qs))))
PYEOF_INNER
)

cd "$REPO_ROOT/backend"
python -m alembic -x dburl="$DB" upgrade head
