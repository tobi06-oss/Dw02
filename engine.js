/* 무매·VR 주문 계산 엔진
 * 무한매수법 V4.0(일반모드·리버스모드)과 VR의 하루 주문표를 계산하고,
 * 종가(고가·시가)로 체결을 판정해 다음 상태를 만든다.
 * bars: [{d:'YYYY-MM-DD', o, h, l, c}] 오름차순.
 */
(function (root) {
  "use strict";

  var EPS = 1e-9;
  function r2(x) { return Math.round((x + (x >= 0 ? EPS : -EPS)) * 100) / 100; }
  function f2(x) { return Math.floor(x * 100 + EPS) / 100; }
  function c2(x) { return Math.ceil(x * 100 - EPS) / 100; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function nextSession(d) {
    var t = new Date(d + "T12:00:00Z");
    do { t.setUTCDate(t.getUTCDate() + 1); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
    return t.toISOString().slice(0, 10);
  }
  function addDays(d, n) {
    var t = new Date(d + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }

  /* ---------------- 무한매수법 ---------------- */

  // 별% = base × (1 − 2T/N)  (SOXL 20분할: 20−2T, TQQQ 20분할: 15−1.5T, 40분할도 동일식)
  function starPct(base, N, T) { return base * (1 - 2 * T / N); }

  // 매수 사다리: 1회 예산으로 1주씩 더 살 수 있게 되는 가격을 차례로 구한다.
  function ladder(budget, q, floorPrice, max) {
    var out = [];
    if (!(budget > 0)) return out;
    for (var k = 1; k <= (max || 12); k++) {
      var p = f2(budget / (q + k));
      if (p <= 0 || p < floorPrice) break;
      out.push({ side: "BUY", kind: "ladder", type: "LOC", price: p, qty: 1, label: "하락 대비 " + k });
    }
    return out;
  }

  // 증권사 가격제한(현재가 ±20% 부근)을 피하는 큰수 주문. 체결 결과는 원래 주문과 같다.
  function applyBig(o, c0, a) {
    var lim = (a.bigLimitPct || 20) / 100;
    if (o.type !== "LOC") return o;
    if (o.side === "BUY" && o.price > c0 * (1 + lim)) {
      o.orig = o.price; o.price = f2(c0 * (1 + lim - 0.02)); o.big = true;
    } else if (o.side === "SELL" && o.price < c0 * (1 - lim)) {
      o.orig = o.price; o.price = c2(c0 * (1 - lim + 0.02)); o.big = true;
    }
    return o;
  }

  function infPlan(a, bars) {
    if (!bars || !bars.length) return null;
    var last = bars[bars.length - 1], c0 = last.c;
    var N = a.N, base = a.basePct, T = a.T || 0, qty = a.qty || 0, avg = a.avg, cash = a.cash;
    var p = { basis: last, session: nextSession(last.d), orders: [], notes: [], T: T, N: N,
      mode: a.mode || "NORMAL", phase: "", star: null, starPct: null, budget: null, buyP: null, sellP: null };
    var floorPrice = c0 * 0.5;

    if (p.mode === "REVERSE") {
      var div = N / 2;
      if (!a.revDay) {
        p.phase = "리버스 1일차";
        var q0 = Math.floor(qty / div);
        if (q0 > 0) p.orders.push({ side: "SELL", kind: "rev-moc", type: "MOC", price: null, qty: q0, label: "리버스 첫날 무조건 매도" });
        p.notes.push("리버스 첫날은 매수 없이 보유수량의 1/" + div + "만 MOC로 매도합니다.");
        return p;
      }
      p.phase = "리버스 " + (a.revDay + 1) + "일차";
      var last5 = bars.slice(-5), sum = 0;
      for (var i = 0; i < last5.length; i++) sum += last5[i].c;
      var star = sum / last5.length;
      p.star = star;
      p.sellP = r2(star);
      p.buyP = r2(r2(star) - 0.01);
      var sq = Math.floor(qty / div);
      if (sq > 0) p.orders.push(applyBig({ side: "SELL", kind: "rev-sell", type: "LOC", price: p.sellP, qty: sq, label: "별지점 위 매도 (1/" + div + ")" }, c0, a));
      var bud = cash / 4;
      p.budget = bud;
      var bq = Math.floor(bud / p.buyP);
      if (bq > 0) p.orders.push(applyBig({ side: "BUY", kind: "rev-buy", type: "LOC", price: p.buyP, qty: bq, label: "쿼터매수 (잔금/4)" }, c0, a));
      p.orders = p.orders.concat(ladder(bud, bq, floorPrice, 8));
      p.exitPrice = r2(avg * (1 - base / 100));
      p.notes.push("별지점 = 직전 5거래일 종가 평균. 종가가 $" + p.exitPrice.toFixed(2) + "(평단 −" + base + "%)를 넘으면 일반모드로 돌아갑니다.");
      return p;
    }

    var budget = cash / (N - T);
    p.budget = budget;

    if (qty <= 0) {
      p.phase = "처음매수";
      var big = f2(c0 * (a.bigMult || 1.12));
      var fq = Math.floor(budget / big);
      if (fq > 0) p.orders.push({ side: "BUY", kind: "first", type: "LOC", price: big, qty: fq, label: "처음매수 (큰수)" });
      p.orders = p.orders.concat(ladder(budget, fq, floorPrice, 10));
      p.notes.push("처음매수는 전일 종가보다 " + Math.round(((a.bigMult || 1.12) - 1) * 100) + "% 높은 가격으로 LOC를 걸어 사실상 무조건 매수합니다.");
      return p;
    }

    var sp = starPct(base, N, T);
    var starP = avg * (1 + sp / 100);
    p.starPct = sp; p.star = starP;
    p.sellP = r2(starP);
    p.buyP = r2(p.sellP - 0.01);
    var front = T < N / 2;
    p.phase = front ? "전반전" : "후반전";

    var Q = 0;
    if (front) {
      var half = budget / 2;
      var q1 = Math.floor(half / p.buyP);
      var avgP = r2(avg);
      var q2 = Math.floor((budget - q1 * p.buyP) / avgP);
      if (q1 > 0) p.orders.push(applyBig({ side: "BUY", kind: "star-half", type: "LOC", price: p.buyP, qty: q1, label: "별지점 절반" }, c0, a));
      if (q2 > 0) p.orders.push(applyBig({ side: "BUY", kind: "avg-half", type: "LOC", price: avgP, qty: q2, label: "평단 절반" }, c0, a));
      Q = q1 + q2;
    } else {
      var qf = Math.floor(budget / p.buyP);
      if (qf > 0) p.orders.push(applyBig({ side: "BUY", kind: "star-full", type: "LOC", price: p.buyP, qty: qf, label: "별지점 전체" }, c0, a));
      Q = qf;
    }
    p.orders = p.orders.concat(ladder(budget, Q, floorPrice, 10));

    var quarter = Math.floor(qty / 4), rest = qty - quarter;
    var target = r2(avg * (1 + base / 100));
    p.target = target;
    if (quarter > 0) p.orders.push(applyBig({ side: "SELL", kind: "quarter", type: "LOC", price: p.sellP, qty: quarter, label: "쿼터매도 (1/4)" }, c0, a));
    if (rest > 0) p.orders.push({ side: "SELL", kind: "limit", type: "LIMIT", price: target, qty: rest, label: "지정가매도 (+" + base + "%)" });
    if (target > c0 * 1.3) p.notes.push("지정가 $" + target.toFixed(2) + "가 현재가보다 30% 이상 높아 증권사에서 거부되면, 가격이 가까워졌을 때 다시 거세요.");
    if (!front) p.notes.push("후반전: 별지점이 평단보다 낮아 쿼터매도는 손절입니다. 무매는 손절이 핵심입니다.");
    if (T + 1 > N - 1) p.notes.push("이번 매수가 체결되면 T가 " + (N - 1) + "을 넘어 리버스모드로 넘어갑니다.");
    return p;
  }

  function judge(o, bar) {
    if (!bar) return null;
    if (o.type === "MOC") return { px: bar.c };
    if (o.type === "LOC") {
      if (o.side === "BUY") return bar.c <= o.price + EPS ? { px: bar.c } : null;
      return bar.c >= o.price - EPS ? { px: bar.c } : null;
    }
    if (o.type === "LIMIT") {
      if (o.side === "SELL") return bar.h >= o.price - EPS ? { px: bar.o >= o.price ? bar.o : o.price } : null;
      return bar.l <= o.price + EPS ? { px: bar.o <= o.price ? bar.o : o.price } : null;
    }
    return null;
  }

  function judgeAll(orders, bar) {
    return orders.map(function (o) {
      var j = judge(o, bar);
      return { order: o, filled: !!j, px: j ? j.px : null, qty: o.qty };
    });
  }

  // fills: [{order, filled, px, qty}] — 사용자가 수정했을 수 있음
  function infApply(a, fills, bar) {
    var s = clone(a), fee = (a.fee || 0) / 100, N = a.N, base = a.basePct;
    var log = [], events = [];
    var got = fills.filter(function (f) { return f.filled && f.qty > 0 && f.px > 0; });
    var sells = got.filter(function (f) { return f.order.side === "SELL"; });
    var buys = got.filter(function (f) { return f.order.side === "BUY"; });
    var T0 = s.T || 0;

    sells.forEach(function (f) {
      var q = Math.min(f.qty, s.qty);
      if (q <= 0) return;
      var pnl = (f.px - s.avg) * q - f.px * q * fee;
      s.realized = (s.realized || 0) + pnl;
      s.cash += f.px * q * (1 - fee);
      s.qty -= q;
      log.push({ d: bar.d, side: "SELL", kind: f.order.kind, px: f.px, q: q, pnl: r2(pnl) });
    });
    if (s.qty === 0) s.avg = null;
    buys.forEach(function (f) {
      var cost = f.px * f.qty;
      s.avg = s.qty > 0 ? (s.avg * s.qty + cost) / (s.qty + f.qty) : f.px;
      s.qty += f.qty;
      s.cash -= cost * (1 + fee);
      log.push({ d: bar.d, side: "BUY", kind: f.order.kind, px: f.px, q: f.qty });
    });

    var has = function (k) { return got.some(function (f) { return f.order.kind === k; }); };
    var T = T0;

    if ((a.mode || "NORMAL") === "REVERSE") {
      var factor = 1 - 2 / N;
      if (!a.revDay) {
        if (has("rev-moc")) T = T * factor;
        s.revDay = 1;
      } else {
        if (has("rev-sell")) T = T * factor;
        if (has("rev-buy") || has("ladder")) T = T + (N - T) * 0.25;
        s.revDay = (a.revDay || 0) + 1;
      }
      if (s.qty > 0 && bar.c > s.avg * (1 - base / 100)) {
        s.mode = "NORMAL"; s.revDay = 0;
        events.push("종가 $" + bar.c.toFixed(2) + "가 평단 −" + base + "%를 넘어 일반모드로 돌아갑니다.");
      }
    } else {
      var quarter = has("quarter"), limit = has("limit");
      if (limit && quarter) T = 0;
      else if (limit) T = T0 * 0.25;
      else if (quarter) T = T0 * 0.75;
      var delta = 0;
      if (has("first") || has("star-full")) delta += 1;
      if (has("star-half")) delta += 0.5;
      if (has("avg-half")) delta += 0.5;
      T += delta;
      if (s.qty > 0 && T > N - 1) {
        s.mode = "REVERSE"; s.revDay = 0;
        events.push("T가 " + (N - 1) + "을 넘어 리버스모드로 전환합니다. 다음 주문은 MOC 매도입니다.");
      }
    }
    s.T = T;

    if (s.qty === 0 && (sells.length || T0 > 0)) {
      var prevPrincipal = s.principal;
      s.cycle = (s.cycle || 1) + 1;
      if (s.compound !== false) {
        s.principal = r2(s.cash);
      } else {
        var profit = s.cash - prevPrincipal;
        if (profit > 0) { s.aside = r2((s.aside || 0) + profit); s.cash = prevPrincipal; }
      }
      s.T = 0; s.avg = null; s.mode = "NORMAL"; s.revDay = 0;
      events.push("전량 매도로 사이클이 끝났습니다. 다음 사이클 원금 $" + (s.compound !== false ? s.principal : prevPrincipal).toFixed(2) + (s.compound !== false ? " (복리)" : " (단리)"));
    }
    s.cash = r2(s.cash);
    return { next: s, log: log, events: events };
  }

  /* ---------------- VR ---------------- */

  var VR_LIMIT = { INSTALLMENT: 75, LUMPSUM: 50, WITHDRAWAL: 25 };

  function vrPlan(a, bars) {
    if (!bars || !bars.length) return null;
    var last = bars[bars.length - 1], c0 = last.c;
    var band = a.band != null ? a.band : 0.15;
    var min = a.V * (1 - band), max = a.V * (1 + band);
    var qty = a.qty || 0, pool = a.pool || 0;
    var limitPct = a.limitPct != null ? a.limitPct : (VR_LIMIT[a.vrType || "INSTALLMENT"] || 75);
    var limit = pool * limitPct / 100;
    var type = a.orderType || "LOC";
    var p = { basis: last, session: nextSession(last.d), min: min, max: max, E: qty * c0, ratio: a.V ? qty * c0 / a.V : null,
      limit: limit, limitPct: limitPct, buys: [], sells: [], orders: [], notes: [] };
    var cum = 0;
    for (var k = 1; k <= 20; k++) {
      var n = Math.max(1, qty + k - 1);
      var bp = r2(min / n);
      if (cum + bp > limit + EPS) break;
      cum += bp;
      p.buys.push({ side: "BUY", kind: "vr-buy", type: type, price: bp, qty: 1, label: "매수 " + k, left: r2(pool - cum) });
    }
    var sc = 0;
    for (var j = 1; j <= Math.min(qty, 12); j++) {
      var spx = r2(max / (qty - j + 1));
      sc += spx;
      p.sells.push({ side: "SELL", kind: "vr-sell", type: type, price: spx, qty: 1, label: "매도 " + j, left: r2(pool + sc) });
    }
    p.orders = p.buys.concat(p.sells);
    p.due = a.nextUpdate && last.d >= a.nextUpdate;
    if (!p.buys.length) p.notes.push("Pool 사용 한도($" + limit.toFixed(2) + ")로 살 수 있는 매수 주문이 없습니다.");
    return p;
  }

  function vrApply(a, fills, bar) {
    var s = clone(a), fee = (a.fee || 0) / 100, log = [];
    fills.filter(function (f) { return f.filled && f.qty > 0 && f.px > 0; }).forEach(function (f) {
      if (f.order.side === "BUY") {
        s.qty += f.qty; s.pool -= f.px * f.qty * (1 + fee);
      } else {
        var q = Math.min(f.qty, s.qty);
        s.qty -= q; s.pool += f.px * q * (1 - fee);
      }
      log.push({ d: bar.d, side: f.order.side, kind: f.order.kind, px: f.px, q: f.qty });
    });
    s.pool = r2(s.pool);
    return { next: s, log: log, events: [] };
  }

  // 2주마다: 다음 V = 직전 V + Pool/G + (E − 직전 V) ÷ (2√G) ± 적립금
  function vrRoll(a, close, date) {
    var s = clone(a), G = a.G || 10;
    var E = a.qty * close;
    var contrib = a.contrib || 0;
    var sign = a.vrType === "WITHDRAWAL" ? -1 : (a.vrType === "LUMPSUM" ? 0 : 1);
    var growth = a.pool / G + (E - a.V) / (2 * Math.sqrt(G));
    s.V = r2(a.V + growth + sign * contrib);
    s.pool = r2(a.pool + sign * contrib);
    if (sign > 0) s.invested = r2((a.invested || 0) + contrib);
    s.cycle = (a.cycle || 1) + 1;
    s.nextUpdate = addDays(a.nextUpdate || date, 14);
    s.lastRoll = { d: date, close: close, E: r2(E), Vprev: a.V, Vnext: s.V };
    return { next: s, E: E, growth: growth, contrib: sign * contrib };
  }

  var api = { r2: r2, f2: f2, nextSession: nextSession, addDays: addDays, starPct: starPct,
    infPlan: infPlan, infApply: infApply, judge: judge, judgeAll: judgeAll,
    vrPlan: vrPlan, vrApply: vrApply, vrRoll: vrRoll, VR_LIMIT: VR_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(this);
