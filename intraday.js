// Faster gold strategies on 1-hour candles. Shared by the backtest (intraday_bt.js) and live signals (live.js).
function loadGoldHourly(file) {
  const seen = {};
  readFile(file).split('\n').filter(Boolean).forEach(line => { try { JSON.parse(line).forEach(k => { seen[k[0]] = k; }); } catch (e) {} });
  return Object.keys(seen).map(Number).sort((a, b) => a - b).map(ts => {
    const k = seen[ts], d = new Date(ts);
    return { t: d.toISOString(), ts, hour: d.getUTCHours(), dow: d.getUTCDay(), o: +k[1], h: +k[2], l: +k[3], c: +k[4] };
  }).filter(b => {
    // spot gold is closed Fri 21:00 UTC -> Sun 22:00 UTC; PAXG trades through it, so drop those hours
    if (b.dow === 6) return false;
    if (b.dow === 5 && b.hour >= 21) return false;
    if (b.dow === 0 && b.hour < 22) return false;
    return true;
  });
}

function indicatorsH(b) {
  const x = indicators(b), h = b.map(k => k.h), l = b.map(k => k.l);
  x.ema200 = ema(x.c, 200);
  x.hi24 = highest(h, 24); x.lo24 = lowest(l, 24); x.hi12 = highest(h, 12); x.lo12 = lowest(l, 12);
  x.hour = b.map(k => k.hour);
  // Asian session range (00:00-06:59 UTC) of the current day, known from 07:00 UTC on
  x.asHi = Array(b.length).fill(null); x.asLo = Array(b.length).fill(null);
  let hi = null, lo = null, day = null;
  for (let i = 0; i < b.length; i++) {
    const d = b[i].t.slice(0, 10);
    if (d !== day) { day = d; hi = null; lo = null; }
    if (b[i].hour < 7) { hi = hi == null ? b[i].h : Math.max(hi, b[i].h); lo = lo == null ? b[i].l : Math.min(lo, b[i].l); }
    else { x.asHi[i] = hi; x.asLo[i] = lo; }
  }
  return x;
}

// one London-session trade per day: remember the day of the last entry
function oncePerDay() { let last = null; return (b, i) => { const d = b[i].t.slice(0, 10); if (d === last) return false; last = d; return true; }; }

function makeStratsH(b) {
  const lonL = oncePerDay(), lonS = oncePerDay();
  return {
    h1break: { name: '1H Breakout', desc: 'Buy when the hourly close breaks the last 24 hours\x27 high while above the 200-hour average. Exit on a close below the 12-hour low.',
      entry: (x, i) => x.c[i] > x.hi24[i - 1] && x.c[i] > x.ema200[i], exit: (x, i) => x.c[i] < x.lo12[i - 1] },
    h1breakS: { name: '1H Breakdown (short)', short: true, desc: 'Short when the hourly close breaks the last 24 hours\x27 low while below the 200-hour average. Exit on a close above the 12-hour high.',
      entry: (x, i) => x.c[i] < x.lo24[i - 1] && x.c[i] < x.ema200[i], exit: (x, i) => x.c[i] > x.hi12[i - 1] },
    h1dip: { name: '1H Dip Buyer', desc: 'Above the 200-hour average, buy when 2-period RSI drops under 10. Exit on a close above the 5-hour average or after 12 hours.',
      entry: (x, i) => x.c[i] > x.ema200[i] && x.rsi2[i] < 10, exit: (x, i, held) => x.c[i] > x.sma5[i] || held >= 12 },
    h1cross: { name: '1H EMA Cross', desc: 'Buy when the 20-hour EMA crosses above the 50-hour EMA while above the 200-hour average. Exit on the cross back down.',
      entry: (x, i) => x.ema20[i - 1] <= x.ema50[i - 1] && x.ema20[i] > x.ema50[i] && x.c[i] > x.ema200[i], exit: (x, i) => x.ema20[i] < x.ema50[i] },
    london: { name: 'London Breakout', desc: 'Between 07:00 and 15:00 UTC (10:00-18:00 Beirut), buy when an hourly close breaks above the Asian-session high while above the 200-hour average. Close by 20:00 UTC (23:00 Beirut).',
      entry: (x, i) => x.hour[i] >= 7 && x.hour[i] <= 15 && x.asHi[i] != null && x.c[i] > x.asHi[i] && x.c[i - 1] <= x.asHi[i] && x.c[i] > x.ema200[i] && lonL(b, i),
      exit: (x, i) => x.hour[i] >= 20 || x.hour[i] < 7 },
    londonS: { name: 'London Breakdown (short)', short: true, desc: 'Between 07:00 and 15:00 UTC, short when an hourly close breaks below the Asian-session low while below the 200-hour average. Close by 20:00 UTC.',
      entry: (x, i) => x.hour[i] >= 7 && x.hour[i] <= 15 && x.asLo[i] != null && x.c[i] < x.asLo[i] && x.c[i - 1] >= x.asLo[i] && x.c[i] < x.ema200[i] && lonS(b, i),
      exit: (x, i) => x.hour[i] >= 20 || x.hour[i] < 7 },
  };
}
const COST_H = 0.0003; // 0.03% round trip, about $1.30/oz at 4,300: a typical retail XAUUSD spread plus slippage
