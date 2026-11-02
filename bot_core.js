// Gold bot rules (tested in master_bt.js, 2023-2026, positive every year):
//  BUY  when an hourly close breaks the last 24 hours' high, above the 200-hour average, and the ~6-week trend (EMA 1000h) is rising.
//  SELL when an hourly close breaks the last 24 hours' low, below the 200-hour average, and the ~6-week trend is falling.
//  SL 2x hourly ATR. TP1 at 1.5R: close half, move SL to entry. The rest closes on the 1H rule (close back through the 12-hour low/high).
//  No new trade within 30 min of high-impact US news.
const BOT = { stopAtr: 2, tpR: 1.5, account: 100, riskPct: 0.01, newsMin: 30 };
const HOUR = 3600000;

function reaction(title) {
  const t = title.toLowerCase();
  if (/trump|president/.test(t)) return 'Unpredictable. Comments on tariffs, China or the Fed can move gold fast in either direction.';
  if (/unemployment rate|jobless|claims/.test(t)) return 'Higher than forecast = weak economy: gold usually UP. Lower: gold usually DOWN.';
  if (/cpi|pce|ppi|inflation/.test(t)) return 'Higher than forecast: USD up, gold usually DOWN. Lower than forecast: gold usually UP.';
  if (/non-farm|employment|payroll|jolts|adp/.test(t)) return 'Strong jobs: USD up, gold usually DOWN. Weak jobs: gold usually UP.';
  if (/fomc|federal funds|fed chair|powell|interest rate|monetary/.test(t)) return 'Hawkish (rates higher for longer): gold DOWN. Dovish (cuts coming): gold UP. Biggest event of the month.';
  if (/gdp|retail sales|ism|pmi|durable/.test(t)) return 'Strong number: USD up, gold usually DOWN. Weak number: gold usually UP.';
  if (/fed|speaks/.test(t)) return 'Hints of rate cuts lift gold; hints of hikes push it down.';
  return 'Can cause short spikes. Let the first 15 minutes settle.';
}

function usdEvents(cal) {
  return cal.filter(e => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium' || /trump|president|powell/i.test(e.title)))
    .map(e => ({ id: e.date + '|' + e.title, title: e.title, time: new Date(e.date).toISOString(), impact: /trump|president/i.test(e.title) ? 'High' : e.impact,
      forecast: e.forecast, previous: e.previous, actual: e.actual || '', reaction: reaction(e.title) }))
    .sort((a, b) => a.time < b.time ? -1 : 1);
}

// Replay the rules over the hourly candles. Returns every event (open/tp1/be/stop/exit/time/skip) and the open position.
// blocked(t) returns the news event that locks trading at time t, or null.
function botReplay(hb, blocked) {
  const x = indicatorsH(hb), S = makeStratsH(hb), n = hb.length - 1, ev = [];
  x.ema1000 = ema(x.c, 1000);
  let pos = null;
  for (let i = 1025; i <= n; i++) {
    const t = hb[i].ts + HOUR, bar = hb[i];
    if (pos) {
      const d = pos.dir, snap = () => Object.assign({}, pos);
      if (d > 0 ? bar.l <= pos.stop : bar.h >= pos.stop) { ev.push({ type: pos.half ? 'be' : 'stop', t, px: pos.stop, pos: snap() }); pos = null; continue; }
      if (!pos.half && (d > 0 ? bar.h >= pos.tp1 : bar.l <= pos.tp1)) { pos.half = true; pos.stop = pos.entry; ev.push({ type: 'tp1', t, px: pos.tp1, pos: snap() }); }
      if ((d > 0 ? S.h1break : S.h1breakS).exit(x, i)) { ev.push({ type: 'exit', t, px: bar.c, pos: snap() }); pos = null; }
      else if (t - pos.t0 > 5 * 86400000) { ev.push({ type: 'time', t, px: bar.c, pos: snap() }); pos = null; }
      continue;
    }
    let d = 0;
    if (S.h1break.entry(x, i) && x.ema1000[i] > x.ema1000[i - 24]) d = 1;
    else if (S.h1breakS.entry(x, i) && x.ema1000[i] < x.ema1000[i - 24]) d = -1;
    if (!d) continue;
    const news = blocked(t);
    if (news) { ev.push({ type: 'skip', t, px: x.c[i], dir: d, news }); continue; }
    const risk = BOT.stopAtr * x.atr14[i], e = x.c[i];
    pos = { dir: d, entry: e, stop: e - d * risk, sl0: e - d * risk, tp1: e + d * BOT.tpR * risk, risk, t0: t, half: false };
    ev.push({ type: 'open', t, px: e, pos: Object.assign({}, pos) });
  }
  return { ev, pos, x, n, trend: x.ema1000[n] > x.ema1000[n - 24] ? 'up' : 'down' };
}

// R result of a closed trade (half at TP1 if it was hit)
function tradeR(e) {
  const p = e.pos, m = p.dir * (e.px - p.entry) / p.risk;
  return p.half && e.type !== 'tp1' ? 0.5 * BOT.tpR + 0.5 * m : m;
}

// Cent account: 0.01 lot = 0.01 oz, so it moves $0.01 per $1 of gold
function centLots(stopDist) {
  // always even, so it splits into two equal trades: one closes at TP1, one rides to the CLOSE alert
  return Math.max(0.02, 2 * Math.floor(BOT.account * BOT.riskPct / (stopDist * 0.01) / 2) / 100);
}

const beirut = t => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
const beirutDay = t => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Asia/Beirut', weekday: 'short', day: 'numeric', month: 'short' });
const usd = v => Math.round(v).toLocaleString('en-US');

// Plain-language Telegram text for one event. off = PAXG minus spot, so levels match the broker's XAUUSD.
function botText(e, off) {
  const p = e.pos, P = v => usd(v - off), side = (p ? p.dir : e.dir) > 0 ? 'BUY' : 'SELL';
  const money = r => `${r >= 0 ? '+' : ''}${r.toFixed(1)}R (≈ ${r >= 0 ? '+' : '-'}$${Math.abs(r * BOT.account * BOT.riskPct).toFixed(2)})`;
  switch (e.type) {
    case 'open': {
      const lots = centLots(p.risk);
      return `${p.dir > 0 ? '🟢' : '🔴'} GOLD ${side} NOW ~${P(p.entry)}  (${beirut(e.t)} Beirut)\n` +
        `SL ${P(p.sl0)}  ($${Math.round(p.risk)} away)\n` +
        `TP1 ${P(p.tp1)}: close HALF there, then move SL to ${P(p.entry)}\n` +
        `Rest: no TP, hold until I send CLOSE\n` +
        `Lot: open TWO trades of ${(lots / 2).toFixed(2)} ($${BOT.account} cent account, total risk ≈ $${(lots * 100 * p.risk * 0.01).toFixed(2)}): one with TP at TP1, one with no TP\n` +
        `Why: hourly close ${p.dir > 0 ? 'above the 24h high' : 'below the 24h low'}, 6-week trend ${p.dir > 0 ? 'up' : 'down'}.\n` +
        `Enter within 15 min. If price already ran more than $${Math.round(p.risk / 2)} past ${P(p.entry)}, skip it.`;
    }
    case 'tp1': return `✅ TP1 hit ~${P(e.px)}: close HALF your ${side} now and move SL to entry ${P(p.entry)}. The rest is now risk-free.`;
    case 'be': return `⚪ The rest of your ${side} closed at entry ${P(p.entry)} (breakeven SL). Trade done: ${money(tradeR(e))}.`;
    case 'stop': return `🛑 SL hit ~${P(e.px)} on your ${side}. Trade closed: ${money(tradeR(e))}. Normal: losses are part of the plan.`;
    case 'exit': return `🏁 CLOSE your ${side} now ~${P(e.px)}: hourly close went back ${p.dir > 0 ? 'under the 12h low' : 'over the 12h high'}. Result: ${money(tradeR(e))}.`;
    case 'time': return `⏱ CLOSE your ${side} now ~${P(e.px)}: open 5 days, time limit. Result: ${money(tradeR(e))}.`;
    case 'skip': return `⚠️ ${side} signal at ~${P(e.px)} but ${e.news.title} is within 30 min. Skipped: no trade.`;
  }
}
