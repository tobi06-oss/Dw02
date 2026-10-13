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
  // ceil: 위쪽 본 매수 주문(별지점·평단 등) 중 가장 낮은 가격. 이 가격 이상인 칸은 의미가 없어 빼고, 그 아래 칸만 max개까지 낸다.
  function ladder(budget, q, floorPrice, max, ceil) {
    var out = [];
    if (!(budget > 0)) return out;
    for (var k = 1; out.length < (max || 12) && k < 400; k++) {
      var p = f2(budget / (q + k));
      if (p <= 0 || p < floorPrice) break;
      if (ceil != null && p >= ceil) continue;
      out.push({ side: "BUY", kind: "ladder", type: "LOC", price: p, qty: 1, label: "하락 대비 " + (out.length + 1) });
    }
    return out;
  }
  function lowestBuy(orders) {
    var m = null;
    orders.forEach(function (o) { if (o.side === "BUY" && o.price != null) { var v = o.orig != null ? o.orig : o.price; if (m == null || v < m) m = v; } });
    return m;
  }

  // 큰수 매수: 매수가가 현재가와 너무 멀면 증권사가 주문을 거부하므로, 현재가 +15% 쯤의 '큰 수'에
  // 그보다 위 가격의 매수 수량을 모두 합쳐 건다 (라오어 <큰수 매수> 글, 엑셀 기준 15%). 그 아래 사다리는 그대로.
  // 매도는 가격을 바꾸지 않는다. 거부되면 걸지 않는 것이 규칙이다 (매수매도거부 글).
  function applyBig(p, c0, a) {
    var pct = a.bigPct != null ? a.bigPct : 15;
    var bigP = f2(c0 * (1 + pct / 100)), moved = 0;
    p.orders.forEach(function (o) {
      if (o.side === "BUY" && o.type === "LOC" && o.price > bigP) {
        o.orig = o.price; o.price = bigP; o.big = true; moved += o.qty;
      }
    });
    if (moved) p.notes.push("매수가가 현재가보다 " + pct + "% 넘게 높아, 그 위 매수 " + moved + "주를 큰수 $" + bigP.toFixed(2) + "에 모았습니다. 같은 가격 주문은 합쳐서 " + moved + "주로 넣으세요.");
    var rejLim = (a.rejectPct != null ? a.rejectPct : 20) / 100;
    var far = p.orders.filter(function (o) { return o.side === "SELL" && o.price != null && o.price > c0 * (1 + rejLim); });
    if (far.length) p.notes.push(far.map(function (o) { return o.label; }).join(", ") + " 가격이 현재가보다 " + Math.round(rejLim * 100) + "% 넘게 높아 증권사가 거부할 수 있습니다. 거부되면 걸지 마세요. 가격을 낮춰 걸면 안 됩니다.");
    return p;
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
      var bud = cash / 4;
      p.budget = bud;
      var bq = Math.floor(bud / p.buyP);
      p.exitPrice = r2(avg * (1 - base / 100));
      if (bq <= 0) {
        // 리버스 중 소진: 쿼터매수(잔금/4)로 1주도 못 사면 매수 없이 MOC 매도만 (소진 기준 추가 글, 2026-08)
        p.phase += " · 소진";
        if (sq > 0) p.orders.push({ side: "SELL", kind: "rev-moc", type: "MOC", price: null, qty: sq, label: "소진 · 무조건 매도 (1/" + div + ")" });
        p.notes.push("잔금/4($" + bud.toFixed(2) + ")로 1주도 살 수 없어 매수 없이 MOC로 매도합니다.");
        return p;
      }
      if (sq > 0) p.orders.push({ side: "SELL", kind: "rev-sell", type: "LOC", price: p.sellP, qty: sq, label: "별지점 위 매도 (1/" + div + ")" });
      p.orders.push({ side: "BUY", kind: "rev-buy", type: "LOC", price: p.buyP, qty: bq, label: "쿼터매수 (잔금/4)" });
      p.orders = p.orders.concat(ladder(bud, bq, floorPrice, 8, lowestBuy(p.orders)));
      p.notes.push("별지점 = 직전 5거래일 종가 평균. 종가가 $" + p.exitPrice.toFixed(2) + "(평단 −" + base + "%)를 넘으면 일반모드로 돌아갑니다.");
      return applyBig(p, c0, a);
    }

    // 일반모드에서는 T ≤ N−1이라 분모가 1 이상이다. 혹시라도 넘으면 잔금 이상을 걸지 않도록 막는다.
    var budget = cash / Math.max(1, N - T);
    p.budget = budget;

    if (qty <= 0) {
      p.phase = "처음매수";
      var big = f2(c0 * (a.bigMult || 1.12));
      var fq = Math.floor(budget / big);
      if (fq > 0) p.orders.push({ side: "BUY", kind: "first", type: "LOC", price: big, qty: fq, label: "처음매수 (큰수)" });
      p.orders = p.orders.concat(ladder(budget, fq, floorPrice, 10, lowestBuy(p.orders)));
      p.notes.push("처음매수는 전일 종가보다 " + Math.round(((a.bigMult || 1.12) - 1) * 100) + "% 높은 가격으로 LOC를 걸어 사실상 무조건 매수합니다.");
      return applyBig(p, c0, a);
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
      // 종가가 평단 이하로 끝나면 두 주문이 다 체결되므로, 1회 매수금 한도 안에서 평단 가격으로 살 수 있는 최대 수량까지 평단 LOC에 싣는다
      // (예전에는 이 몫이 평단보다 비싼 '하락 대비' 1주로 따로 나왔다)
      while (q1 + q2 + 1 > 0 && f2(budget / (q1 + q2 + 1)) >= avgP) q2++;
      if (q1 > 0) p.orders.push({ side: "BUY", kind: "star-half", type: "LOC", price: p.buyP, qty: q1, label: "별지점 절반" });
      if (q2 > 0) p.orders.push({ side: "BUY", kind: "avg-half", type: "LOC", price: avgP, qty: q2, label: "평단 절반" });
      Q = q1 + q2;
    } else {
      var qf = Math.floor(budget / p.buyP);
      if (qf > 0) p.orders.push({ side: "BUY", kind: "star-full", type: "LOC", price: p.buyP, qty: qf, label: "별지점 전체" });
      Q = qf;
    }
    p.orders = p.orders.concat(ladder(budget, Q, floorPrice, 10, lowestBuy(p.orders)));

    var quarter = Math.floor(qty / 4), rest = qty - quarter;
    var target = r2(avg * (1 + base / 100));
    p.target = target;
    if (quarter > 0) p.orders.push({ side: "SELL", kind: "quarter", type: "LOC", price: p.sellP, qty: quarter, label: "쿼터매도 (1/4)" });
    if (rest > 0) p.orders.push({ side: "SELL", kind: "limit", type: "LIMIT", ext: true, price: target, qty: rest, label: "지정가매도 (+" + base + "%)" });
    if (!front) p.notes.push("후반전: 별지점이 평단보다 낮아 쿼터매도는 손절입니다. 무매는 손절이 핵심입니다.");
    if (T + 1 > N - 1) p.notes.push("이번 매수가 체결되면 T가 " + (N - 1) + "을 넘어 리버스모드로 넘어갑니다.");
    return applyBig(p, c0, a);
  }

  function judge(o, bar) {
    if (!bar) return null;
    if (o.type === "MOC") return { px: bar.c };
    if (o.type === "LOC") {
      if (o.side === "BUY") return bar.c <= o.price + EPS ? { px: bar.c } : null;
      return bar.c >= o.price - EPS ? { px: bar.c } : null;
    }
    if (o.type === "LIMIT") {
      // 무매 지정가매도는 프리장~본장~애프터장까지 유효하다 (일반모드 글 6). 시간외 고가·저가(xh·xl)가 있으면 그것으로 판정.
      // VR은 본장 기준이다 (예약매수 초과체결 글).
      var hi = o.ext && bar.xh != null ? Math.max(bar.h, bar.xh) : bar.h;
      var lo = o.ext && bar.xl != null ? Math.min(bar.l, bar.xl) : bar.l;
      if (o.side === "SELL") return hi >= o.price - EPS ? { px: bar.o >= o.price ? bar.o : o.price } : null;
      return lo <= o.price + EPS ? { px: bar.o <= o.price ? bar.o : o.price } : null;
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
        if (has("rev-sell") || has("rev-moc")) T = T * factor;
        if (has("rev-buy") || has("ladder")) T = T + (N - T) * 0.25;
        s.revDay = (a.revDay || 0) + 1;
      }
      if (s.qty > 0 && bar.c > s.avg * (1 - base / 100)) {
        if (T > N - 1) {
          // 일반모드로 돌아가도 T가 1회분도 안 남았으면 다시 리버스모드 시작 (리버스모드 글 6-(6))
          s.revDay = 0;
          events.push("종가 $" + bar.c.toFixed(2) + "가 평단 −" + base + "%를 넘었지만 T가 " + (N - 1) + "을 넘어 1회분이 남지 않았습니다. 리버스모드를 처음부터 다시 시작합니다. 다음 주문은 MOC 매도입니다.");
        } else {
          s.mode = "NORMAL"; s.revDay = 0;
          events.push("종가 $" + bar.c.toFixed(2) + "가 평단 −" + base + "%를 넘어 일반모드로 돌아갑니다.");
        }
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

  var VR_LIMIT = { INSTALLMENT: 75, LUMPSUM: 50, WITHDRAWAL: 10 };

  // 한 사이클(2주)에 Pool에서 매수로 쓸 수 있는 비율.
  // 적립식: 75%에서 시작해 26주마다 5%씩 줄여 10%까지 (pool 사용한도 글). 0원부터 시작한 VR은 첫 1년 100%.
  // 거치식 50% (개요 글), 인출식 10% (pool 사용한도 글).
  function vrLimitPct(a, cycle) {
    var type = a.vrType || "INSTALLMENT";
    if (type !== "INSTALLMENT") return VR_LIMIT[type];
    var week = (a.startWeek || 0) + ((cycle || a.cycle || 1) - 1) * 2;
    if (a.fromZero) {
      if (week < 52) return 100;
      week -= 52;
    }
    return Math.max(10, 75 - 5 * Math.floor(week / 26));
  }

  function vrPlan(a, bars) {
    if (!bars || !bars.length) return null;
    var last = bars[bars.length - 1], c0 = last.c;
    var band = a.band != null ? a.band : 0.15;
    var min = a.V * (1 - band), max = a.V * (1 + band);
    var qty = a.qty || 0, pool = a.pool || 0;
    var limitPct = vrLimitPct(a);
    // 한도는 사이클 시작(적립 후) Pool 기준으로 고정하고, 이번 사이클에 이미 매수에 쓴 돈을 뺀다 (개요 글 "한사이클당 pool 사용의 제한")
    var cap = a.cycleCap != null ? a.cycleCap : (pool + (a.cycleUsed || 0)) * limitPct / 100;
    var limit = Math.max(0, Math.min(pool, cap - (a.cycleUsed || 0)));
    // VR은 본장 지정가 예약주문으로만 한다 (예약매수 초과체결 글). 예전에 저장된 orderType은 쓰지 않는다.
    var type = "LIMIT";
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
    p.cap = cap; p.used = a.cycleUsed || 0;
    if (!p.buys.length) p.notes.push("이번 사이클 Pool 매수 한도 중 남은 $" + limit.toFixed(2) + "로 살 수 있는 매수 주문이 없습니다.");
    return p;
  }

  function vrApply(a, fills, bar) {
    var s = clone(a), fee = (a.fee || 0) / 100, log = [];
    if (s.cycleCap == null) s.cycleCap = r2(((a.pool || 0) + (a.cycleUsed || 0)) * vrLimitPct(a) / 100);
    fills.filter(function (f) { return f.filled && f.qty > 0 && f.px > 0; }).forEach(function (f) {
      if (f.order.side === "BUY") {
        s.qty += f.qty; s.pool -= f.px * f.qty * (1 + fee);
        s.cycleUsed = r2((s.cycleUsed || 0) + f.px * f.qty * (1 + fee));
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
    s.cycleCap = r2(s.pool * vrLimitPct(a, s.cycle) / 100);
    s.cycleUsed = 0;
    s.nextUpdate = addDays(a.nextUpdate || date, 14);
    s.lastRoll = { d: date, close: close, E: r2(E), Vprev: a.V, Vnext: s.V };
    return { next: s, E: E, growth: growth, contrib: sign * contrib };
  }

  var api = { r2: r2, f2: f2, nextSession: nextSession, addDays: addDays, starPct: starPct,
    infPlan: infPlan, infApply: infApply, judge: judge, judgeAll: judgeAll,
    vrPlan: vrPlan, vrApply: vrApply, vrRoll: vrRoll, vrLimitPct: vrLimitPct, VR_LIMIT: VR_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(this);
