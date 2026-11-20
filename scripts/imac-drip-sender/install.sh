#!/bin/bash
# Installs the DLTA drip sender on the office iMac for one agent (default Tom).
# Usage: bash install.sh [AgentName]
set -e
AGENT="${1:-Tom}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/dlta-drip-sender"
LABEL="com.dlta.drip-sender"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3)"

mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$SRC/dlta_drip_sender.py" "$DEST/"
chmod +x "$DEST/dlta_drip_sender.py"

if ! security find-generic-password -s dlta-dialer -a "$AGENT" >/dev/null 2>&1; then
  echo
  echo "Enter $AGENT's 4-digit dialer PIN. It is saved in the Mac Keychain, not in any file."
  security add-generic-password -s dlta-dialer -a "$AGENT" -w
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DEST/dlta_drip_sender.py</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>DLTA_AGENT</key><string>$AGENT</string></dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/dlta-drip-sender.out</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/dlta-drip-sender.out</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo
echo "Installed for $AGENT. First run in 30 minutes, then every 30 minutes, 9am to 8pm, max 75 texts a day."
echo "Log: ~/Library/Logs/dlta-drip-sender.log"
