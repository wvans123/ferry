#!/bin/sh
# Keep ferry-server running on this Mac: starts at login, restarts if it stops.
#   sh autostart.sh            install (uses the API keys set in this terminal)
#   sh autostart.sh --remove   uninstall
# Logs: ~/.ferry-server/server.log
set -e
LABEL=com.ferry.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed"
  exit 0
fi

BIN=$(command -v ferry-server || true)
[ -n "$BIN" ] || { echo "ferry-server not found: pipx install \"git+https://github.com/wvans123/ferry.git#subdirectory=server\""; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ferry-server"

ENV=""
for k in DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY FERRY_MODEL FERRY_SUMMARY_MODEL FERRY_REDACT HTTPS_PROXY; do
  v=$(printenv "$k" || true)
  [ -n "$v" ] && ENV="$ENV<key>$k</key><string>$v</string>"
done
[ -n "$ENV" ] || { echo "no API key in this terminal: export DEEPSEEK_API_KEY=... first"; exit 1; }
# remote clients reconnect after a restart without re-uploading: keep sessions on disk
ENV="$ENV<key>FERRY_SESSION_STORE</key><string>${FERRY_SESSION_STORE:-disk}</string>"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key><dict>$ENV</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.ferry-server/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/.ferry-server/server.log</string>
</dict></plist>
PL
chmod 600 "$PLIST"   # it holds your API key
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if curl -fsS http://127.0.0.1:8787/health >/dev/null; then
  echo "ferry-server is running and will start again at every login."
  echo "token: $(cat "$HOME/.ferry-server/token")"
else
  echo "ferry-server did not answer yet; see ~/.ferry-server/server.log"
fi
