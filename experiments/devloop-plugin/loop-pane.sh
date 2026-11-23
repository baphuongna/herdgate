#!/bin/bash
# Start (or restart) the DEV-LOOP pane: workspace ⚙ dev-loop, one agent tab
# running pi with the AUTO.md prompt. Waits for any already-running cycle
# first, records the pane id for the event hook, then hands over.
set -eu
cd /home/bom/source/herdgate
STATE="$HOME/.local/state/herdgate-dev-loop.pane"

# Handoff: a cycle fired by the retired systemd path may still be running.
while [ "$(systemctl --user show -p ActiveState --value herdgate-dev-loop.service 2>/dev/null || true)" = "activating" ]; do
  echo "waiting: the old oneshot cycle is still running"
  sleep 30
done

api() { printf '%s\n' "$1" | timeout 8 herdr --session default remote-api-bridge 2>/dev/null | head -1; }
LISTED=$(api '{"id":"w1","method":"workspace.list","params":{}}')
WS=$(printf '%s' "$LISTED" | python3 -c "
import json,sys
m=json.loads(sys.stdin.readline())
for w in (m.get('result',{}).get('workspaces') or []):
    if w.get('label')=='⚙ dev-loop': print(w['workspace_id']); break")
if [ -z "$WS" ]; then
  WS=$(api '{"id":"w2","method":"workspace.create","params":{}}' | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['result']['workspace']['workspace_id'])")
  api "{\"id\":\"w3\",\"method\":\"workspace.rename\",\"params\":{\"workspace_id\":\"$WS\",\"label\":\"⚙ dev-loop\"}}" >/dev/null
fi
TAB=$(api "{\"id\":\"t1\",\"method\":\"tab.create\",\"params\":{\"workspace_id\":\"$WS\",\"label\":\"dev-loop\"}}")
PANE=$(printf '%s' "$TAB" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['result']['root_pane']['pane_id'])")
echo "{\"paneId\": \"$PANE\", \"startedAt\": $(date +%s)}" > "$STATE"
python3 - "$PANE" <<'PY'
import json, subprocess, sys
req = json.dumps({"id": "s1", "method": "pane.send_text", "params": {"pane_id": sys.argv[1], "text": 'cd /home/bom/source/herdgate && pi "$(cat docs/DEV-LOOP/AUTO.md)"\r'}})
out = subprocess.run(["herdr", "--session", "default", "remote-api-bridge"], input=req + "\n", capture_output=True, text=True, timeout=8)
print(out.stdout.splitlines()[0] if out.stdout else "send_text FAILED: " + out.stderr[:120])
PY
echo "loop pane: $PANE (workspace $WS)"
