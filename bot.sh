#!/bin/bash
# Gold bot run: download prices + US news, work out signals, send new messages to Telegram.
# Runs on the Mac (osascript) or in the cloud (node). Telegram token: $TELEGRAM_TOKEN or ~/Downloads/telegram.key
cd "$(dirname "$0")"; mkdir -p data out
B=https://data-api.binance.vision
curl -s --max-time 10 "$B/api/v3/ping" | grep -q '{}' || B=https://api.binance.com
: > data/bot_1h.tmp; END=""
for i in 1 2 3; do
  R=$(curl -s --max-time 20 "$B/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=1000$END")
  echo "$R" | grep -q '^\[\[' || break
  echo "$R" >> data/bot_1h.tmp
  END="&endTime=$(( $(echo "$R" | cut -c3-15) - 1 ))"
done
[ "$(wc -l < data/bot_1h.tmp)" -ge 2 ] && mv data/bot_1h.tmp data/bot_1h.txt; rm -f data/bot_1h.tmp
curl -s --max-time 10 https://api.gold-api.com/price/XAU > data/spot.tmp && grep -q '"price"' data/spot.tmp && mv data/spot.tmp data/spot.json
curl -s --max-time 10 "$B/api/v3/ticker/price?symbol=PAXGUSDT" > data/paxg.tmp && grep -q '"price"' data/paxg.tmp && mv data/paxg.tmp data/paxg.json
# news calendar: the site rate-limits, so refresh at most once an hour and keep the last good copy
NOWS=$(date +%s); LAST=$(cat data/cal_ts 2>/dev/null || echo 0)
if [ $((NOWS - LAST)) -gt 3500 ]; then
  curl -s --max-time 20 https://nfs.faireconomy.media/ff_calendar_thisweek.json > data/cal.tmp && grep -q '"title"' data/cal.tmp && mv data/cal.tmp data/calendar.json && echo $NOWS > data/cal_ts
  curl -s --max-time 20 https://nfs.faireconomy.media/ff_calendar_nextweek.json > data/cal.tmp && grep -q '"title"' data/cal.tmp && mv data/cal.tmp data/calendar_next.json
fi
rm -f data/*.tmp out/msg_*.txt
# keep the old state: if the messages can't be delivered, restore it so they go out next run
cp bot_state.json data/state_before.json 2>/dev/null || echo '{"lastEv":0,"alerted":{},"brief":""}' > data/state_before.json
JS="${TMPDIR:-/tmp}/gold_bot.js"; cat engine.js intraday.js bot_core.js bot.js > "$JS"
if command -v node >/dev/null; then node "$JS" "$PWD"; else osascript -l JavaScript "$JS" "$PWD"; fi
[ "$NO_SEND" = 1 ] && exit 0

# ---- Telegram
TOKEN="${TELEGRAM_TOKEN:-$(cat ~/Downloads/telegram.key 2>/dev/null)}"; TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')
[ -z "$TOKEN" ] && { echo "no Telegram token: messages not sent"; cp data/state_before.json bot_state.json; exit 0; }
ME=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe")
echo "This token belongs to the bot: @$(echo "$ME" | grep -o '"username":"[^"]*' | cut -d\" -f4)"
echo "$ME" | grep -q '"ok":true' || { echo "TELEGRAM TOKEN IS WRONG: copy it again from @BotFather and update the TELEGRAM_TOKEN secret"; cp data/state_before.json bot_state.json; exit 1; }
CHAT=$(cat data/chat_id.txt 2>/dev/null)
if [ -z "$CHAT" ]; then
  # first run: pick up the chat of whoever sent /start to the bot
  CHAT=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | grep -o '"chat":{"id":-\{0,1\}[0-9]*' | head -1 | grep -o -- '-\{0,1\}[0-9]*$')
  [ -z "$CHAT" ] && { echo "TOKEN OK, but nobody pressed START on the bot yet: open your bot in Telegram, press START, send hi, then run again"; cp data/state_before.json bot_state.json; exit 0; }
  echo "$CHAT" > data/chat_id.txt
  curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=‚úÖ Gold bot connected. You'll get BUY/SELL entries with SL, TP1 and CLOSE alerts, US news warnings, and a brief every weekday morning." > /dev/null
fi
for f in out/msg_*.txt; do
  [ -f "$f" ] || continue
  curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text@$f" | grep -q '"ok":true' && echo "sent $f" || echo "FAILED $f"
done
