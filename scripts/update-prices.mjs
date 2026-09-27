// 매일 SOXL·TQQQ 일봉(시가·고가·저가·종가)을 받아 Firestore prices/{종목} 문서에 합칩니다.
// 1순위 Yahoo Finance 차트 API, 실패하면 Stooq CSV. 둘 다 키가 필요 없습니다.
// 실행: FIREBASE_SERVICE_ACCOUNT='<서비스 계정 JSON>' node update-prices.mjs
import admin from "firebase-admin";

const TICKERS = (process.env.TICKERS || "SOXL,TQQQ").split(",").map((t) => t.trim()).filter(Boolean);
const KEEP = 150;
const UA = { "User-Agent": "Mozilla/5.0 (desk-prices)" };

const r2 = (x) => Math.round(x * 100) / 100;
const nyDate = (sec) => new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const nyNow = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: (+g("hour") % 24) * 60 + +g("minute") };
};

async function fromYahoo(t) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=3mo&interval=1d&includePrePost=false`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`yahoo ${t} HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) throw new Error(`yahoo ${t} empty`);
  return res.timestamp.map((s, i) => [nyDate(s), q.open[i], q.high[i], q.low[i], q.close[i]])
    .filter((b) => b.slice(1).every((v) => typeof v === "number" && isFinite(v)))
    .map((b) => [b[0], r2(b[1]), r2(b[2]), r2(b[3]), r2(b[4])]);
}

async function fromStooq(t) {
  const url = `https://stooq.com/q/d/l/?s=${t.toLowerCase()}.us&i=d`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`stooq ${t} HTTP ${r.status}`);
  const lines = (await r.text()).trim().split(/\r?\n/).slice(1);
  if (!lines.length || !/^\d{4}-/.test(lines[0])) throw new Error(`stooq ${t} empty`);
  return lines.slice(-70).map((l) => l.split(",")).map((c) => [c[0], +c[1], +c[2], +c[3], +c[4]])
    .filter((b) => b.slice(1).every((v) => isFinite(v) && v > 0)).map((b) => [b[0], r2(b[1]), r2(b[2]), r2(b[3]), r2(b[4])]);
}

async function fetchBars(t) {
  try { return { bars: await fromYahoo(t), source: "yahoo" }; }
  catch (e) { console.warn(String(e)); }
  return { bars: await fromStooq(t), source: "stooq" };
}

function sane(bars) {
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i][4] / bars[i - 1][4] - 1;
    if (Math.abs(ch) > 0.6) return `${bars[i][0]} 종가 변동 ${(ch * 100).toFixed(0)}%`;
  }
  return null;
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT 비밀값이 없습니다.");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  const now = nyNow();
  let failed = 0;

  for (const t of TICKERS) {
    try {
      let { bars, source } = await fetchBars(t);
      // 장이 아직 안 끝난 오늘 봉은 버린다 (뉴욕 16:10 이전)
      if (bars.length && bars[bars.length - 1][0] === now.date && now.minutes < 16 * 60 + 10) bars = bars.slice(0, -1);
      const ref = db.collection("prices").doc(t);
      const snap = await ref.get();
      const map = new Map((snap.exists ? snap.data().bars || [] : []).map((b) => [b[0], b]));
      bars.forEach((b) => map.set(b[0], b));
      const merged = [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-KEEP);
      const bad = sane(merged.slice(-30));
      if (bad) throw new Error(`${t} 값 이상 (${bad}) — 저장하지 않음`);
      await ref.set({ bars: merged, updatedAt: new Date().toISOString(), source });
      const last = merged[merged.length - 1];
      console.log(`${t}: ${last[0]} 종가 ${last[4]} (${source}, ${merged.length}개)`);
    } catch (e) {
      failed++;
      console.error(`${t} 실패: ${e.message || e}`);
    }
  }
  if (failed === TICKERS.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
