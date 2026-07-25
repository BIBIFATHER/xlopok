#!/usr/bin/env bash
# Записывает BITRIX24_WEBHOOK_URL в .env, проверяя форму.
# Секрет не печатается. Использование:
#   ./scripts/set-webhook.sh 'https://<portal>.bitrix24.ru/rest/<user_id>/<secret>/'
set -euo pipefail

URL="${1:-}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

if [[ -z "$URL" ]]; then
  echo "Ошибка: передай строку вебхука в кавычках." >&2
  exit 1
fi

# Убираем query-строку, если скопировали URL с параметрами (?auth=...).
URL="${URL%%\?*}"

# Если в конце имя метода (…/rest/1/secret/profile) — отрезаем до секрета.
if [[ "$URL" =~ ^(https://[^/]+/rest/[0-9]+/[A-Za-z0-9]+)/[A-Za-z0-9_.]+/?$ ]]; then
  URL="${BASH_REMATCH[1]}/"
fi

# Нормализуем: добавим завершающий слэш, если его нет.
[[ "$URL" == */ ]] || URL="$URL/"

if [[ ! "$URL" =~ ^https://[^/]+/rest/[0-9]+/[A-Za-z0-9]+/$ ]]; then
  echo "Ошибка: это не похоже на вебхук." >&2
  echo "Нужен вид: https://<portal>.bitrix24.ru/rest/<user_id>/<secret>/" >&2
  echo "Получено (длина ${#URL}): host=$(printf '%s' "$URL" | sed -E 's#^https://([^/]+)/.*#\1#'), путь не совпал." >&2
  exit 2
fi

# Генерируем MCP_AUTH_TOKEN, если .env ещё нет.
TOKEN="$(openssl rand -hex 32)"

if [[ -f "$ENV_FILE" ]] && grep -q '^MCP_AUTH_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(grep '^MCP_AUTH_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  # Не переиспользуем плейсхолдер как токен.
  [[ "$TOKEN" == *'<'* || ${#TOKEN} -lt 32 ]] && TOKEN="$(openssl rand -hex 32)"
fi

cat > "$ENV_FILE" <<EOF
BITRIX24_WEBHOOK_URL=$URL
MCP_AUTH_TOKEN=$TOKEN
WRITE_ENABLED=false
AGENT_ID=claude_sales_agent
DATA_DIR=data/test
LOG_LEVEL=info
TASKS_API_MODE=legacy
EOF

echo "OK: форма вебхука верная, .env записан."
echo "host: $(printf '%s' "$URL" | sed -E 's#^https://([^/]+)/.*#\1#')"
echo "WRITE_ENABLED=false — режим только чтение."
