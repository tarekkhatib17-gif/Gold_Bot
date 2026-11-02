// One bot run: new trade events + news warnings + a morning brief -> out/msg_N.txt (bot.sh sends them to Telegram).
// State (what was already sent) lives in bot_state.json.
{
  const now = Date.now();
  const st = JSON.parse(readFile('bot_state.json') || '{"lastEv":0,"alerted":{},"brief":""}');
  const hb = loadGoldHourly('data/bot_1h.txt').filter(k => k.ts + HOUR <= now); // completed candles only
  let cal = [];
  ['data/calendar.json', 'data/calendar_next.json'].forEach(f => { try { cal = cal.concat(JSON.parse(readFile(f) || '[]')); } catch (e) {} });
  const events = usdEvents(cal), high = events.filter(e => e.impact === 'High');
  const blocked = t => high.find(e => Math.abs(new Date(e.time) - t) <= BOT.newsMin * 60000) || null;
  let off = 0;
  try { const s = +JSON.parse(readFile('data/spot.json')).price, p = +JSON.parse(readFile('data/paxg.json')).price;
    if (s > 0 && p > 0 && Math.abs(p / s - 1) < 0.03) off = p - s; } catch (e) {}

  const R = botReplay(hb, blocked), msgs = [], kinds = [];
  const say = (kind, text) => { msgs.push(text); kinds.push(kind); };
  if (hb.length < 1100) say('error', `⚠️ Bot data problem: only ${hb.length} hourly candles downloaded. Signals paused until it recovers.`);
  else {
    // trade events since the last run (never older than 3 hours, so a restart doesn't replay history)
    R.ev.filter(e => e.t > st.lastEv && e.t >= now - 3 * HOUR).forEach(e => say('trade', botText(e, off)));
    if (R.ev.length) st.lastEv = Math.max(st.lastEv, R.ev[R.ev.length - 1].t);
  }
  const last = hb[hb.length - 1], px = last.c - off, P = v => usd(v - off);
  const openTxt = () => { const p = R.pos; if (!p) return 'No open trade.';
    const r = p.dir * (last.c - p.entry) / p.risk;
    return `Open ${p.dir > 0 ? 'BUY' : 'SELL'} from ${P(p.entry)}, now ${r >= 0 ? '+' : ''}${r.toFixed(1)}R. SL ${P(p.stop)}${p.half ? ' (breakeven, half closed)' : `, TP1 ${P(p.tp1)}`}.`; };

  // high-impact news coming within 60 min
  high.forEach(e => {
    const mins = (new Date(e.time) - now) / 60000;
    if (mins > 0 && mins <= 60 && !st.alerted[e.id]) {
      say('news', `📰 NEWS in ${Math.round(mins)} min (${beirut(e.time)} Beirut): ${e.title}` +
        (e.forecast ? `\nForecast ${e.forecast}, previous ${e.previous}` : '') + `\n${e.reaction}\nNo new trades 30 min before/after. ${openTxt()} Keep your SL in place.`);
      st.alerted[e.id] = 1;
    }
  });

  // morning brief, first run after 08:00 Beirut on weekdays
  const bh = +new Date(now).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false });
  const day = beirutDay(now), dow = new Date(now).getUTCDay();
  if (bh >= 8 && st.brief !== day && dow >= 1 && dow <= 5 && hb.length >= 1100) {
    const x = R.x, n = R.n;
    const today = events.filter(e => beirutDay(e.time) === day);
    say('brief', `☀️ Gold brief ${day}: ~${usd(px)}\n6-week trend: ${R.trend.toUpperCase()} → only ${R.trend === 'up' ? 'BUY' : 'SELL'} signals can fire.\n` +
      (R.trend === 'up' ? `BUY if an hourly candle closes above ~${P(x.hi24[n])} (and above ${P(x.ema200[n])}).`
        : `SELL if an hourly candle closes below ~${P(x.lo24[n])} (and below ${P(x.ema200[n])}).`) +
      `\n${openTxt()}\n` +
      (!cal.length ? '⚠️ News calendar could not be downloaded: check Forex Factory yourself before trading.' : today.length ? 'US news today (Beirut):\n' + today.map(e => `• ${beirut(e.time)} ${e.impact === 'High' ? '🔴' : '🟠'} ${e.title}`).join('\n') : 'No big US news today.'));
    st.brief = day;
  }

  // forget alerts older than 2 weeks
  Object.keys(st.alerted).forEach(k => { if (now - new Date(k.split('|')[0]) > 14 * 86400000) delete st.alerted[k]; });
  writeFile('bot_state.json', JSON.stringify(st));
  writeFile('out/bot.json', JSON.stringify({ updated: new Date(now).toISOString(), price: px, trend: R.trend, pos: R.pos, off,
    events: R.ev.slice(-12), triggers: { buy: R.x.hi24[R.n] - off, sell: R.x.lo24[R.n] - off, ema200: R.x.ema200[R.n] - off } }));
  msgs.forEach((m, i) => writeFile(`out/msg_${i + 1}.txt`, m));
  writeFile('out/bot_msgs.json', JSON.stringify(msgs.map((m, i) => ({ kind: kinds[i], text: m }))));
  var BOT_OUT = msgs.length ? msgs.join('\n-----\n') : `no messages (gold ~${usd(px)}, trend ${R.trend}, ${R.pos ? 'in trade' : 'flat'})`;
}
if (typeof process !== 'undefined' && !IS_JXA) console.log(BOT_OUT);
BOT_OUT;
