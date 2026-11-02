// Trading engine: data loading, indicators, strategies, backtest, live signals.
// Runs under macOS JXA (osascript -l JavaScript) — no installs needed — or under Node (the cloud bot).
const IS_JXA = typeof ObjC !== 'undefined';
if (IS_JXA) ObjC.import('Foundation');

const ROOT = IS_JXA ? (() => {
  const args = $.NSProcessInfo.processInfo.arguments.js.map(a => a.js);
  return args[args.length - 1];
})() : process.argv[process.argv.length - 1];

function readFile(p) {
  if (!IS_JXA) { try { return require('fs').readFileSync(ROOT + '/' + p, 'utf8'); } catch (e) { return null; } }
  const s = $.NSString.stringWithContentsOfFileEncodingError(ROOT + '/' + p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : s.js;
}
function writeFile(p, text) {
  if (!IS_JXA) return require('fs').writeFileSync(ROOT + '/' + p, text);
  $.NSString.alloc.initWithUTF8String(text).writeToFileAtomicallyEncodingError(ROOT + '/' + p, true, $.NSUTF8StringEncoding, null);
}

// ---------- data ----------
const num = s => parseFloat(String(s).replace(/[$,]/g, ''));

function loadNasdaq(sym) {
  const j = JSON.parse(readFile('data/' + sym + '.json'));
  const rows = j.data.tradesTable.rows.map(r => {
    const [m, d, y] = r.date.split('/');
    return { t: `${y}-${m}-${d}`, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close) };
  }).filter(b => b.c > 0 && b.o > 0);
  return rows.reverse();
}

function loadGold() {
  const seen = {};
  readFile('data/gold_raw.txt').split('\n').filter(Boolean).forEach(line => {
    JSON.parse(line).forEach(k => { seen[k[0]] = k; });
  });
  return Object.keys(seen).map(Number).sort((a, b) => a - b).map(ts => {
    const k = seen[ts];
    return { t: new Date(ts).toISOString().slice(0, 10), o: +k[1], h: +k[2], l: +k[3], c: +k[4] };
  });
}

function loadGold1h() {
  return JSON.parse(readFile('data/gold_1h.json')).map(k => ({ t: new Date(k[0]).toISOString(), o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

// ---------- indicators ----------
function sma(a, n) {
  const out = Array(a.length).fill(null); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function ema(a, n) {
  const out = Array(a.length).fill(null), k = 2 / (n + 1); let e = null;
  for (let i = 0; i < a.length; i++) {
    if (i === n - 1) e = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
    else if (i >= n) e = a[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function rsi(a, n) {
  const out = Array(a.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function atr(b, n) {
  const tr = b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)));
  const out = Array(b.length).fill(null); let a = null;
  for (let i = 0; i < b.length; i++) {
    if (i === n - 1) a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
    else if (i >= n) a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}
function highest(a, n) { return a.map((_, i) => i < n - 1 ? null : Math.max(...a.slice(i - n + 1, i + 1))); }
function lowest(a, n) { return a.map((_, i) => i < n - 1 ? null : Math.min(...a.slice(i - n + 1, i + 1))); }
function stdev(a, n) {
  const m = sma(a, n);
  return a.map((_, i) => m[i] == null ? null : Math.sqrt(a.slice(i - n + 1, i + 1).reduce((s, x) => s + (x - m[i]) ** 2, 0) / n));
}

function indicators(b) {
  const c = b.map(x => x.c), h = b.map(x => x.h), l = b.map(x => x.l);
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const macd = c.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  const firstM = macd.findIndex(x => x != null);
  const sigTail = ema(macd.slice(firstM), 9);
  const macdSig = Array(firstM).fill(null).concat(sigTail);
  const bbMid = sma(c, 20), bbSd = stdev(c, 20);
  return {
    c, sma5: sma(c, 5), sma200: sma(c, 200), ema20: ema(c, 20), ema50: ema(c, 50),
    rsi2: rsi(c, 2), rsi14: rsi(c, 14), atr14: atr(b, 14),
    hi55: highest(h, 55), lo20: lowest(l, 20), lo55: lowest(l, 55), hi20: highest(h, 20), macd, macdSig,
    bbUp: bbMid.map((m, i) => m == null ? null : m + 2 * bbSd[i]),
    bbLo: bbMid.map((m, i) => m == null ? null : m - 2 * bbSd[i]), bbMid,
  };
}

// ---------- strategies ----------
// Each returns { entry(i), exit(i, barsHeld) } evaluated at bar i's close; orders fill at next open.
const STRATEGIES = {
  trend: {
    name: 'Trend Rider', desc: 'Buy when the 20-day EMA crosses above the 50-day EMA while price is above the 200-day average. Sell when the 20 EMA drops back below the 50.',
    entry: (x, i) => x.ema20[i - 1] <= x.ema50[i - 1] && x.ema20[i] > x.ema50[i] && x.c[i] > x.sma200[i],
    exit: (x, i) => x.ema20[i] < x.ema50[i],
  },
  dip: {
    name: 'Dip Buyer', desc: 'In an uptrend (price above 200-day average), buy when 2-day RSI drops under 10 (a sharp short-term dip). Sell when price closes back above the 5-day average, or after 10 days.',
    entry: (x, i) => x.c[i] > x.sma200[i] && x.rsi2[i] < 10,
    exit: (x, i, held) => x.c[i] > x.sma5[i] || held >= 10,
  },
  breakout: {
    name: 'Breakout', desc: 'Buy when price closes at a new 55-day high. Sell when it closes below the 20-day low.',
    entry: (x, i) => x.c[i] >= x.hi55[i - 1] && x.c[i] > x.sma200[i],
    exit: (x, i) => x.c[i] < x.lo20[i - 1],
  },
  short: {
    name: 'Breakdown (short)', short: true, desc: 'Sell short when price closes at a new 55-day low while below its 200-day average. Buy back when it closes above the 20-day high. Tested and not used: it lost money on gold and on every stock.',
    entry: (x, i) => x.c[i] <= x.lo55[i - 1] && x.c[i] < x.sma200[i],
    exit: (x, i) => x.c[i] > x.hi20[i - 1],
  },
  macd: {
    name: 'MACD Cross', desc: 'Buy when MACD crosses above its signal line while price is above the 200-day average. Sell on the cross back down.',
    entry: (x, i) => x.macd[i - 1] <= x.macdSig[i - 1] && x.macd[i] > x.macdSig[i] && x.c[i] > x.sma200[i],
    exit: (x, i) => x.macd[i] < x.macdSig[i],
  },
};
const STOP_ATR = 3; // protective stop: 3x ATR from entry (below for buys, above for shorts)
const stopHit = (bar, pos) => pos.short ? (bar.o >= pos.stop || bar.h >= pos.stop) : (bar.o <= pos.stop || bar.l <= pos.stop);
const stopFill = (bar, pos) => pos.short ? Math.max(bar.o, pos.stop) : Math.min(bar.o, pos.stop);
const posRet = (pos, px) => pos.short ? 1 - px / pos.px : px / pos.px - 1;
const mkStop = (strat, px, a) => { const m = strat.stopAtr || STOP_ATR; return strat.short ? px + m * a : px - m * a; };

function backtest(b, x, strat, cost, from, to) {
  from = Math.max(from, 201); to = to == null ? b.length : to;
  let eq = 1, peak = 1, maxDD = 0, pos = null; const trades = [], curve = [];
  let daysIn = 0;
  for (let i = from; i < to; i++) {
    if (pos) {
      daysIn++;
      // stop hit intrabar?
      if (stopHit(b[i], pos)) {
        close(stopFill(b[i], pos), b[i].t, 'stop');
      } else if (i > pos.i && strat.exit(x, i, i - pos.i)) {
        pos.pendingExit = true;
      }
    }
    const markEq = pos ? eq * (1 + posRet(pos, b[i].c)) : eq;
    peak = Math.max(peak, markEq); maxDD = Math.max(maxDD, 1 - markEq / peak);
    curve.push(markEq);
    if (i + 1 >= to) break;
    if (pos && pos.pendingExit) close(b[i + 1].o, b[i + 1].t, 'signal');
    else if (!pos && strat.entry(x, i)) {
      const px = b[i + 1].o;
      pos = { px, i: i + 1, t: b[i + 1].t, stop: mkStop(strat, px, x.atr14[i]), short: !!strat.short };
      eq *= 1 - cost / 2;
    }
  }
  if (pos) close(b[to - 1].c, b[to - 1].t, 'end');
  function close(px, t, why) {
    const r = posRet(pos, px);
    eq *= (1 + r) * (1 - cost / 2);
    trades.push({ in: pos.t, out: t, ret: r - cost, why });
    pos = null;
  }
  const years = (new Date(b[to - 1].t) - new Date(b[from].t)) / 3.156e10;
  const wins = trades.filter(t => t.ret > 0), losses = trades.filter(t => t.ret <= 0);
  const gw = wins.reduce((s, t) => s + t.ret, 0), gl = -losses.reduce((s, t) => s + t.ret, 0);
  let streak = 0, worstStreak = 0;
  trades.forEach(t => { streak = t.ret <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); });
  const cagr = Math.pow(eq, 1 / years) - 1;
  return {
    totalRet: eq - 1, cagr, maxDD, trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: gl ? gw / gl : null, avgTrade: trades.length ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : 0,
    worstStreak, exposure: daysIn / (to - from), calmar: maxDD ? cagr / maxDD : 0,
    years, recent: trades.slice(-8),
  };
}

function buyHold(b, from, to) {
  from = Math.max(from, 201); to = to == null ? b.length : to;
  let peak = 0, maxDD = 0;
  for (let i = from; i < to; i++) { peak = Math.max(peak, b[i].c); maxDD = Math.max(maxDD, 1 - b[i].c / peak); }
  const years = (new Date(b[to - 1].t) - new Date(b[from].t)) / 3.156e10;
  const tot = b[to - 1].c / b[from].o;
  return { totalRet: tot - 1, cagr: Math.pow(tot, 1 / years) - 1, maxDD };
}

// ---------- live signal for one asset ----------
function liveSignal(b, x, strat, key) {
  const n = b.length - 1;
  // replay the strategy to know whether we're currently in a trade
  let pos = null;
  for (let i = 201; i <= n; i++) {
    if (pos) {
      if (stopHit(b[i], pos)) pos = null;
      else if (i > pos.i && strat.exit(x, i, i - pos.i)) { if (i === n) return mk(strat.short ? 'COVER' : 'SELL', pos); pos = null; continue; }
    }
    if (!pos && strat.entry(x, i)) {
      if (i === n) return mk(strat.short ? 'SHORT' : 'BUY', null);
      pos = { px: b[i + 1].o, i: i + 1, t: b[i + 1].t, stop: mkStop(strat, b[i + 1].o, x.atr14[i]), short: !!strat.short };
    }
  }
  return mk(pos ? 'HOLD' : 'WAIT', pos);

  function mk(action, p) {
    const px = b[n].c, a = x.atr14[n];
    const s = { action, strategy: key, price: px, asOf: b[n].t };
    if (strat.short) s.side = 'short';
    if (action === 'BUY' || action === 'SHORT') { s.entry = px; s.stop = mkStop(strat, px, a); s.target = px - 2 * (s.stop - px); }
    if (p) { s.entry = p.px; s.entryDate = p.t; s.stop = p.stop; s.target = p.px + 2 * (p.px - p.stop); s.openPnl = posRet(p, px); }
    return s;
  }
}

// Plain-language read of every indicator: +1 bullish, -1 bearish, 0 neutral
function indicatorBoard(b, x) {
  const n = b.length - 1, c = x.c[n], out = [];
  const add = (name, value, vote, note) => out.push({ name, value, vote, note });
  add('200-day average', x.sma200[n], c > x.sma200[n] ? 1 : -1, c > x.sma200[n] ? 'Price above: long-term uptrend' : 'Price below: long-term downtrend');
  add('EMA 20 / 50', x.ema20[n], x.ema20[n] > x.ema50[n] ? 1 : -1, x.ema20[n] > x.ema50[n] ? 'Short trend above medium: bullish' : 'Short trend below medium: bearish');
  const r = x.rsi14[n];
  add('RSI (14)', r, r > 70 ? -1 : r < 30 ? 1 : r >= 50 ? 1 : -1, r > 70 ? 'Overbought: pullback risk' : r < 30 ? 'Oversold: bounce possible' : r >= 50 ? 'Momentum positive' : 'Momentum negative');
  const r2 = x.rsi2[n];
  add('RSI (2)', r2, r2 < 10 ? 1 : r2 > 90 ? -1 : 0, r2 < 10 ? 'Sharp short-term dip' : r2 > 90 ? 'Short-term stretched up' : 'Neutral');
  add('MACD', x.macd[n] - x.macdSig[n], x.macd[n] > x.macdSig[n] ? 1 : -1, x.macd[n] > x.macdSig[n] ? 'Above signal line: bullish' : 'Below signal line: bearish');
  const bbPos = (c - x.bbLo[n]) / (x.bbUp[n] - x.bbLo[n]);
  add('Bollinger %B', bbPos, bbPos > 1 ? -1 : bbPos < 0 ? 1 : 0, bbPos > 1 ? 'Above upper band: stretched' : bbPos < 0 ? 'Below lower band: stretched down' : 'Inside bands');
  add('55-day high', x.hi55[n], c >= x.hi55[n - 1] ? 1 : 0, c >= x.hi55[n - 1] ? 'New 55-day high: breakout' : ((x.hi55[n] / c - 1) * 100).toFixed(1) + '% below the high');
  add('ATR (14)', x.atr14[n], 0, 'Typical daily move ' + (x.atr14[n] / c * 100).toFixed(1) + '%');
  const score = out.reduce((s, o) => s + o.vote, 0);
  return { items: out, score, max: out.filter(o => o.name !== 'ATR (14)').length };
}

function intraday(b) {
  const x = indicators(b), n = b.length - 1;
  const up = x.ema20[n] > x.ema50[n];
  return { price: b[n].c, time: b[n].t, ema20: x.ema20[n], ema50: x.ema50[n], rsi14: x.rsi14[n],
    bias: up && x.c[n] > x.ema20[n] ? 'Bullish' : !up && x.c[n] < x.ema20[n] ? 'Bearish' : 'Mixed',
    change24h: b[n].c / b[Math.max(0, n - 24)].c - 1 };
}
