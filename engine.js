/* 무매·VR 주문 계산 엔진
 * 무한매수법 V4.0(일반모드·리버스모드)과 VR의 하루 주문표를 계산하고,
 * 종가(고가·시가)로 체결을 판정해 다음 상태를 만든다.
 * bars: [{d:'YYYY-MM-DD', o, h, l, c}] 오름차순.
 */
(function (root) {
  "use strict";

  var EPS = 1e-9;
  // 메리츠 매수 거부 한도는 현재가 +30% (Dw 확인 2026-10-30, 전에는 약 20%). 큰수는 거기서 5% 여유를 둔다. 계좌별 bigPct/rejectPct로 바꿀 수 있다.
  var BIG_PCT = 25, REJECT_PCT = 30;
  function bigPctOf(a) { return a && a.bigPct != null ? a.bigPct : BIG_PCT; }
  function rejectPctOf(a) { return a && a.rejectPct != null ? a.rejectPct : REJECT_PCT; }
  function r2(x) { return Math.round((x + (x >= 0 ? EPS : -EPS)) * 100) / 100; }
  function f2(x) { return Math.floor(x * 100 + EPS) / 100; }
  function c2(x) { return Math.ceil(x * 100 - EPS) / 100; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- 미국 장 달력 ----------------
   * NYSE 휴장일·조기폐장일(13:00 마감). 해마다 12월 전에 다음 해를 추가하고 NYSE 공지로 확인한다.
   * 주문 알림 스크립트(scripts/order-reminder.mjs)도 이 표를 쓴다.
   * 표에 없는 해는 주말만 건너뛰고, 주문표에 "휴장일 표 없음" 안내를 붙인다.
   */
  var CAL = {
    2026: { closed: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
            early: ["2026-11-27", "2026-12-24"] },
    2027: { closed: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
            early: ["2027-11-26"] }
  };
  function calKnown(d) { return !!CAL[+String(d).slice(0, 4)]; }
  function isHoliday(d) { var c = CAL[+String(d).slice(0, 4)]; return !!c && c.closed.indexOf(d) >= 0; }
  function isEarlyClose(d) { var c = CAL[+String(d).slice(0, 4)]; return !!c && c.early.indexOf(d) >= 0; }
  function isWeekend(d) { var w = new Date(d + "T12:00:00Z").getUTCDay(); return w === 0 || w === 6; }
  // 미국 정규장이 열리는 날인지 (주말·휴장일 제외)
  function isSession(d) { return !isWeekend(d) && !isHoliday(d); }
  function nextSession(d) {
    var x = d;
    do { x = addDays(x, 1); } while (!isSession(x));
    return x;
  }
  function prevSession(d) {
    var x = d;
    do { x = addDays(x, -1); } while (!isSession(x));
    return x;
  }
  // V 갱신일(달력상 2주 간격 금요일)이 휴장일·주말이면 그 전 마지막 장에 마감한다. 저장하는 날짜는 그대로 두어 2주 간격이 앞당겨지지 않게 한다
  function vrDue(d) { return !d ? d : isSession(d) ? d : prevSession(d); }
  // 주문표 안내: 조기폐장일, 휴장일 표가 없는 해
  function calNotes(p) {
    if (!calKnown(p.session)) p.notes.push(p.session.slice(0, 4) + "년 미국 휴장일 표가 아직 없어 주말만 건너뜁니다. 휴장일에는 주문을 건너뛰세요.");
    else if (isEarlyClose(p.session)) p.notes.push(p.session.slice(5).replace("-", "/") + "은 미국장 조기폐장일(뉴욕 13:00 마감)입니다. LOC는 그 전에 걸어 두세요.");
  }
  // 주문표를 만들지 않는 경우: 주문 없이 이유만 남긴다
  function block(p, why) { p.orders = []; p.blocked = why; p.notes.push(why); return p; }
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
  // a.ladMore = {session, n}: 그날 장에 한해 사다리를 n칸 더 낸다 (화면의 + 버튼, 3칸씩)
  function ladMoreOf(a, p) { return a.ladMore && a.ladMore.session === p.session && a.ladMore.n > 0 ? a.ladMore.n : 0; }
  function lowestBuy(orders) {
    var m = null;
    orders.forEach(function (o) { if (o.side === "BUY" && o.price != null) { var v = o.orig != null ? o.orig : o.price; if (m == null || v < m) m = v; } });
    return m;
  }

  // 큰수 매수: 매수가가 현재가와 너무 멀면 증권사가 주문을 거부하므로, 현재가 +25% 쯤의 '큰 수'에
  // 그보다 위 가격의 매수 수량을 모두 합쳐 건다 (라오어 <큰수 매수> 글은 15%, 메리츠 한도가 30%로 늘어 25%). 그 아래 사다리는 그대로.
  // 매도는 가격을 바꾸지 않는다. 메리츠는 현재가보다 훨씬 높은 매도도 거부하지 않으므로 경고하지 않는다 (Dw 확인 2026-10-20).
  // 큰수 기준가는 주문 시점의 시세다. 종가 뒤 시간외·주간장에서 크게 움직이면 증권사는 그 시세로 거부 여부를 따지므로
  // 전일 종가 대신 그 시세를 쓴다. 지금은 사용자가 입력하고, 자동화 때는 서버가 증권사 현재가로 같은 값을 넣는다.
  // a.bigOv = {session, px}: 그날 장에 한해 입력한 시세 → 큰수 = 시세 × (1 + bigPct)
  // a.bigOv = {session, price}: (이전 방식) 큰수 가격 자체를 직접 정한 값. 남아 있는 기록을 위해 계속 읽는다.
  function applyBig(p, c0, a) {
    var pct = bigPctOf(a);
    var bigP = f2(c0 * (1 + pct / 100)), moved = 0;
    p.bigAuto = bigP;
    var ov = a.bigOv && a.bigOv.session === p.session ? a.bigOv : null;
    if (ov && ov.px > 0) { p.bigPx = r2(ov.px); bigP = f2(p.bigPx * (1 + pct / 100)); p.bigManual = bigP; }
    else if (ov && ov.price > 0) { bigP = r2(ov.price); p.bigManual = bigP; }
    p.orders.forEach(function (o) {
      if (o.side === "BUY" && o.type === "LOC" && o.price > bigP) {
        o.orig = o.price; o.price = bigP; o.big = true; moved += o.qty;
      }
    });
    if (moved) p.notes.push((p.bigPx != null ? "매수가가 입력한 시세 $" + p.bigPx.toFixed(2) + "보다 " + pct + "% 넘게 높아, 그 위 매수 " : p.bigManual != null ? "직접 정한 큰수 $" + bigP.toFixed(2) + "보다 높은 매수 " : "매수가가 현재가보다 " + pct + "% 넘게 높아, 그 위 매수 ") + moved + "주를 큰수 $" + bigP.toFixed(2) + "에 모았습니다. 같은 가격 주문은 합쳐서 " + moved + "주로 넣으세요.");
    return p;
  }

  function infPlan(a, bars) {
    if (!bars || !bars.length) return null;
    var last = bars[bars.length - 1], c0 = last.c;
    var N = a.N, base = a.basePct, T = a.T || 0, qty = a.qty || 0, avg = a.avg, cash = a.cash;
    var fee = (a.fee || 0) / 100;
    var p = { basis: last, session: nextSession(last.d), orders: [], notes: [], T: T, N: N,
      mode: a.mode || "NORMAL", phase: "", star: null, starPct: null, budget: null, buyP: null, sellP: null };
    var floorPrice = c0 * 0.5;
    calNotes(p);

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
      // 별지점 = 직전 5개 미국 영업일 종가 평균. 하나라도 빠지면 계산하지 않는다
      var last5 = bars.slice(-5), sum = 0;
      var gap = last5.length < 5 ? "종가가 " + last5.length + "개뿐" : null;
      for (var g = 1; !gap && g < last5.length; g++) if (nextSession(last5[g - 1].d) !== last5[g].d) gap = nextSession(last5[g - 1].d) + " 종가 없음";
      if (gap) return block(p, "리버스 별지점은 직전 5영업일 종가가 모두 있어야 합니다(" + gap + "). 아래 \"종가 직접 입력\"에서 빠진 날 종가를 넣으면 주문표가 나옵니다.");
      for (var i = 0; i < last5.length; i++) sum += last5[i].c;
      var star = sum / last5.length;
      p.star = star;
      p.sellP = r2(star);
      p.buyP = r2(r2(star) - 0.01);
      var sq = Math.floor(qty / div);
      var bud = cash / 4;
      p.budget = bud;
      // 수수료를 뺀 주식 매수 예산. 수량·사다리는 이 값으로만 계산한다
      p.stockBudget = bud / (1 + fee);
      var bq = Math.floor(p.stockBudget / p.buyP);
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
      p.orders = p.orders.concat(ladder(p.stockBudget, bq, floorPrice, 8 + ladMoreOf(a, p), lowestBuy(p.orders)));
      p.notes.push("별지점 = 직전 5거래일 종가 평균. 종가가 $" + p.exitPrice.toFixed(2) + "(평단 −" + base + "%)를 넘으면 일반모드로 돌아갑니다.");
      return applyBig(p, c0, a);
    }

    // 일반모드에서는 T ≤ N−1이라 분모가 1 이상이다. 혹시라도 넘으면 잔금 이상을 걸지 않도록 막는다.
    // roundBudget = 방법론의 1회 매수금(잔금 ÷ (N−T)). stockBudget = 수수료를 뺀 주식 매수 예산.
    // 수량·사다리는 stockBudget 하나로만 계산해 수수료가 한 번만 들어가게 한다.
    var roundBudget = cash / Math.max(1, N - T);
    var budget = roundBudget / (1 + fee);
    p.budget = roundBudget; p.roundBudget = roundBudget; p.stockBudget = budget;

    if (qty <= 0) {
      p.phase = "처음매수";
      var big = f2(c0 * (a.bigMult || 1.12));
      var fq = Math.floor(budget / big);
      if (fq > 0) p.orders.push({ side: "BUY", kind: "first", type: "LOC", price: big, qty: fq, label: "처음매수 (큰수)" });
      p.orders = p.orders.concat(ladder(budget, fq, floorPrice, 10 + ladMoreOf(a, p), lowestBuy(p.orders)));
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
    p.orders = p.orders.concat(ladder(budget, Q, floorPrice, 10 + ladMoreOf(a, p), lowestBuy(p.orders)));

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
      // 시가가 이미 지정가를 넘어서 열리면(매수: 시가 < 지정가, 매도: 시가 > 지정가) 지정가가 아니라 시가로 체결된다. at: "open"으로 표시
      if (o.side === "SELL") return hi >= o.price - EPS ? (bar.o > o.price + EPS ? { px: bar.o, at: "open" } : { px: o.price }) : null;
      return lo <= o.price + EPS ? (bar.o < o.price - EPS ? { px: bar.o, at: "open" } : { px: o.price }) : null;
    }
    return null;
  }

  // 큰수로 낮춰 건 탓에 못 산 매수: 종가가 큰수 가격보다 높고 원래 매수가 이하로 끝난 주문
  // (원래 가격에 걸었다면 LOC로 종가에 체결됐을 주문)
  function bigMisses(orders, bar) {
    if (!bar || !orders) return [];
    return orders.filter(function (o) {
      return o.side === "BUY" && o.big && o.orig != null && bar.c > o.price + EPS && bar.c <= o.orig + EPS;
    });
  }

  // 매수가가 기준가(본장 시가 등)보다 거부 한도(rejectPct, 기본 30%) 넘게 높은 LOC 매수: 증권사가 거부했을 수 있다
  function rejectRisk(orders, px, a) {
    var lim = 1 + rejectPctOf(a) / 100;
    return (orders || []).filter(function (o) { return o.side === "BUY" && o.type === "LOC" && o.price > px * lim + EPS; });
  }

  function judgeAll(orders, bar) {
    return orders.map(function (o) {
      var j = judge(o, bar);
      return { order: o, filled: !!j, px: j ? j.px : null, at: j && j.at ? j.at : null, qty: o.qty };
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
        // 리버스 1일차는 MOC 체결이 확인된 날만 넘어간다. 낼 수량이 없어 MOC가 없던 날은 그대로 넘어간다.
        var planned = fills.some(function (f) { return f.order.kind === "rev-moc"; });
        if (has("rev-moc")) { T = T * factor; s.revDay = 1; }
        else if (!planned) s.revDay = 1;
        else { s.revDay = 0; events.push("리버스 첫날 MOC 매도가 체결되지 않아 다음 장도 리버스 1일차(MOC 매도)로 다시 냅니다."); }
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
    var cum = 0, fee = (a.fee || 0) / 100;
    calNotes(p);
    p.due = a.nextUpdate && last.d >= vrDue(a.nextUpdate);
    p.cap = cap; p.used = a.cycleUsed || 0;
    // 0회차(새로 시작, 첫 매수 기간): 보유가 0이면 V 공식(밴드 하단 ÷ 보유 수량)으로 매수가를 낼 수 없다.
    // 남은 한도 안에서 전일 종가 +10% 지정가로 한 번에 사고, 0회차 마감 때 그 평가금으로 V를 정한다.
    // 이 주문은 처음 넣은 가격·수량 그대로 0회차 마감까지 유지하는 기간 지정가로 본다 (다음 날 종가로 다시 계산하지 않음, index.html vrCarry).
    if (a.cycle === 0) {
      p.zero = true; p.min = 0; p.max = 0; p.ratio = null;
      var fp = r2(c0 * 1.1), fq = Math.floor((limit + EPS) / (fp * (1 + fee)));
      if (fq > 0) p.buys.push({ side: "BUY", kind: "vr-first", type: type, price: fp, qty: fq, label: "첫 매수", left: r2(pool - fp * fq * (1 + fee)) });
      p.orders = p.buys.slice();
      if (fq > 0) p.notes.push("0회차(첫 매수): 전일 종가보다 10% 높은 $" + fp.toFixed(2) + "에 지정가로 " + fq + "주, 최대 $" + (fp * fq * (1 + fee)).toFixed(2) + "(수수료 포함)까지 쓸 수 있는 주문이에요. 장이 오르면 이 가격 가까이에서도 체결되고, 시가가 이보다 높으면 체결되지 않아요. 수량은 남은 매수 한도 $" + limit.toFixed(2) + " 안에서 셌어요.");
      if (fq > 0 && a.nextUpdate) p.notes.push("증권사에는 0회차 마감(" + vrDue(a.nextUpdate).slice(5).replace("-", "/") + ")까지 유지되는 기간 지정가로 넣으세요. 앱도 다 체결될 때까지 같은 가격·수량으로 체결을 확인해요.");
      else p.notes.push(qty > 0 ? "이번 0회차 매수 한도를 다 썼어요. 0회차 마감 때 평가금으로 V를 정하고 1회차를 시작해요." : "남은 매수 한도 $" + limit.toFixed(2) + "로는 1주도 살 수 없어요. 상태 수정에서 Pool을 늘려 주세요.");
      return p;
    }
    for (var k = 1; k <= 20; k++) {
      var n = Math.max(1, qty + k - 1);
      var bp = r2(min / n);
      // 수수료까지 더한 누적 매수금이 남은 한도·Pool을 넘지 않게 한다
      if (cum + bp * (1 + fee) > limit + EPS) break;
      cum += bp * (1 + fee);
      p.buys.push({ side: "BUY", kind: "vr-buy", type: type, price: bp, qty: 1, label: "매수 " + k, left: r2(pool - cum) });
    }
    var sc = 0;
    for (var j = 1; j <= Math.min(qty, 12); j++) {
      var spx = r2(max / (qty - j + 1));
      sc += spx;
      p.sells.push({ side: "SELL", kind: "vr-sell", type: type, price: spx, qty: 1, label: "매도 " + j, left: r2(pool + sc) });
    }
    p.orders = p.buys.concat(p.sells);
    if (!p.buys.length) p.notes.push("이번 사이클 Pool 매수 한도 중 남은 $" + limit.toFixed(2) + "로 살 수 있는 매수 주문이 없습니다.");
    return p;
  }

  function vrApply(a, fills, bar) {
    var s = clone(a), fee = (a.fee || 0) / 100, log = [];
    if (s.cycleCap == null) s.cycleCap = r2(((a.pool || 0) + (a.cycleUsed || 0)) * vrLimitPct(a) / 100);
    fills.filter(function (f) { return f.filled && f.qty > 0 && f.px > 0; }).forEach(function (f) {
      if (f.order.side === "BUY") {
        // 평단: 무매와 같이 수수료 빼고 체결가로 가중평균. 기존 보유분 평단을 모르면(null) 계산하지 않는다
        if (s.qty === 0) s.avg = f.px;
        else if (s.avg != null) s.avg = (s.avg * s.qty + f.px * f.qty) / (s.qty + f.qty);
        s.qty += f.qty; s.pool -= f.px * f.qty * (1 + fee);
        s.cycleUsed = r2((s.cycleUsed || 0) + f.px * f.qty * (1 + fee));
      } else {
        var q = Math.min(f.qty, s.qty);
        s.qty -= q; s.pool += f.px * q * (1 - fee);
        if (s.qty === 0) s.avg = null;
      }
      log.push({ d: bar.d, side: f.order.side, kind: f.order.kind, px: f.px, q: f.qty });
    });
    s.pool = r2(s.pool);
    if (s.avg != null) s.avg = Math.round(s.avg * 10000) / 10000;
    return { next: s, log: log, events: [] };
  }

  // 체결 기록 하나(l: {d, side, px, q})를 계좌에서 되돌린다 (매매내역 수정·삭제용).
  // 매수를 빼면 평단을 가중평균 역산, 매도를 빼면 보유만 돌려놓는다. 지난 회차(lastRoll 이전) 체결은 이번 회차 한도(cycleUsed)에 손대지 않는다.
  function vrUnapply(a, l) {
    var s = clone(a), fee = (a.fee || 0) / 100, px = +l.px, q = +l.q || 0;
    var cur = !(a.lastRoll && a.lastRoll.d && l.d <= a.lastRoll.d);
    if (l.side === "BUY") {
      if (q > (s.qty || 0)) return { error: "지금 보유(" + (s.qty || 0) + "주)보다 많은 매수라 되돌릴 수 없어요." };
      var nq = s.qty - q;
      if (nq === 0) s.avg = null;
      else if (s.avg != null) { var na = (s.avg * s.qty - px * q) / nq; s.avg = na > 0 ? Math.round(na * 10000) / 10000 : null; }
      s.qty = nq; s.pool = r2((s.pool || 0) + px * q * (1 + fee));
      if (cur) s.cycleUsed = r2(Math.max(0, (s.cycleUsed || 0) - px * q * (1 + fee)));
    } else if (l.side === "SELL") {
      s.qty = (s.qty || 0) + q; s.pool = r2((s.pool || 0) - px * q * (1 - fee));
    }
    return { next: s };
  }

  // 2주마다: 다음 V = 직전 V + Pool/G + (E − 직전 V) ÷ (2√G) ± 적립금
  function vrRoll(a, close, date) {
    var s = clone(a), G = a.G || 10;
    var E = a.qty * close;
    // 0회차 마감: 공식 대신 지금 평가금 E를 시작 V로 잡고 1회차를 연다 (적립금은 1회차 마감 때부터).
    // 아직 1주도 못 샀으면 0회차를 한 주 늘린다.
    if (a.cycle === 0) {
      s.cycleUsed = 0;
      if (!(a.qty > 0)) { s.nextUpdate = addDays(a.nextUpdate || date, 7); s.cycleCap = null; return { next: s, E: 0, growth: 0, contrib: 0, zero: true, extended: true }; }
      s.V = r2(E); s.cycle = 1;
      s.cycleCap = r2(s.pool * vrLimitPct(s, 1) / 100);
      s.nextUpdate = addDays(a.nextUpdate || date, 14);
      s.lastRoll = { d: date, close: close, E: r2(E), Vprev: null, Vnext: s.V };
      s.hist = vrHistory(a);
      return { next: s, E: E, growth: 0, contrib: 0, zero: true };
    }
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
    s.hist = vrHistory(a).concat([histRow(a, a.cycle || 1, date, close, a.qty, E, a.V, a.pool, s.pool, a.invested, s.V)]);
    return { next: s, E: E, growth: growth, contrib: sign * contrib };
  }

  // 회차 기록 한 줄: 그 회차의 V·밴드와 마감 시점의 E·Pool (Pool은 적립 전, poolNext는 적립 후 다음 회차 시작 Pool)
  function histRow(a, c, d, close, qty, E, V, pool, poolNext, invested, Vnext) {
    var band = a.band || 0.15;
    return { c: c, d: d, close: close, qty: qty, E: r2(E), V: V, min: r2(V * (1 - band)), max: r2(V * (1 + band)),
      pool: r2(pool), poolNext: r2(poolNext), invested: invested == null ? null : r2(invested), Vnext: Vnext };
  }

  // 지난 회차 기록. 이 기능 전에 갱신한 계좌는 마지막 V 갱신(lastRoll)에서 직전 회차 한 줄을 되살린다
  function vrHistory(a) {
    if (a.hist && a.hist.length) return a.hist;
    var r = a.lastRoll;
    if (!r || r.Vprev == null || r.Vnext == null || !r.close) return [];
    var G = a.G || 10, sign = a.vrType === "WITHDRAWAL" ? -1 : (a.vrType === "LUMPSUM" ? 0 : 1), contrib = sign * (a.contrib || 0);
    var poolEnd = G * (r.Vnext - r.Vprev - (r.E - r.Vprev) / (2 * Math.sqrt(G)) - contrib);
    var inv = a.invested == null ? null : a.invested - (sign > 0 ? contrib : 0);
    return [histRow(a, (a.cycle || 2) - 1, r.d, r.close, Math.round(r.E / r.close), r.E, r.Vprev, poolEnd, poolEnd + contrib, inv, r.Vnext)];
  }

  /* ---------------- 주문 상태 (탭 배지·9시 알림 공통) ---------------- */

  // 무매는 다음 장 주문을 아직 안 넣었을 때, VR은 2주 주문일(V 갱신 후 새 표)에 아직 안 넣었을 때
  function orderStatus(a, bars) {
    if (!bars || !bars.length) return null;
    if (a.type === "VR") {
      var vp = vrPlan(a, bars), pendBlock = a.pending && a.nextUpdate && a.pending.session <= a.nextUpdate;
      if (vp && vp.due && !pendBlock) return { cls: "warn", txt: "V 갱신 필요" };
      if (a.cycleOrdered !== true) return { cls: "todo", txt: "주문 전" };
      return null;
    }
    var p = infPlan(a, bars); if (!p || !p.orders.length) return null;
    if (a.pending && a.pending.session === p.session) return null;
    if (a.pending && bars.some(function (b) { return b.d === a.pending.session; })) return { cls: "warn", txt: "체결 확인" };
    return { cls: "todo", txt: "주문 전" };
  }

  var api = { r2: r2, f2: f2, nextSession: nextSession, prevSession: prevSession, vrDue: vrDue, isSession: isSession, isHoliday: isHoliday, isEarlyClose: isEarlyClose, calKnown: calKnown, CAL: CAL, addDays: addDays, starPct: starPct,
    infPlan: infPlan, infApply: infApply, judge: judge, judgeAll: judgeAll, bigMisses: bigMisses, rejectRisk: rejectRisk, bigPctOf: bigPctOf, rejectPctOf: rejectPctOf,
    vrPlan: vrPlan, vrApply: vrApply, vrUnapply: vrUnapply, vrRoll: vrRoll, vrHistory: vrHistory, vrLimitPct: vrLimitPct, VR_LIMIT: VR_LIMIT, orderStatus: orderStatus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Engine = api;
})(this);
