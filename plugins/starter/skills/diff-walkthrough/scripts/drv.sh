#!/usr/bin/env bash
# diff-walkthrough pipeline:
#   drv.sh page    board.json    storyboard -> <name>.html, then open it (arrow keys step through)
#   drv.sh build   board.json    storyboard -> <name>.html
#   drv.sh stills  board.json    build, then one PNG per scene and 2x2 contact sheets in <name>.stills/
# Outputs sit next to the storyboard. Needs uv, node/npx (stills only), git.
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
PY=(uv run -q --no-project --with pygments --with pillow python)
[ -f "$HOME/.config/jev/ca-bundle.pem" ] && export SSL_CERT_FILE="$HOME/.config/jev/ca-bundle.pem" UV_SYSTEM_CERTS=1

cmd="${1:-}"
[ -n "${2:-}" ] || { sed -n '2,6p' "$0"; exit 1; }
BOARD="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
NAME="${BOARD%.json}"; NAME="${NAME%.storyboard}"
HTML="$NAME.html"

build()  { "${PY[@]}" "$SKILL/scripts/build_deck.py" "$BOARD" "$HTML"; }
# the visual-explainer renderer plays every scene to its last sentence and screenshots it
stills() { npx -y -p visual-explainer -p playwright-core visual-explainer-video "$HTML" --stills | tail -1
           "${PY[@]}" "$SKILL/scripts/sheets.py" "$NAME.stills"; }

case "$cmd" in
  build) build ;;
  page) build; open "$HTML" 2>/dev/null || true; echo "page: $HTML" ;;
  stills) build; stills ;;
  *) sed -n '2,6p' "$0"; exit 1 ;;
esac
