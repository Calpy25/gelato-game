"use strict";
// ===== 定数 =====
const DAYS = 26;                                   // 1か月の営業日数
const START_CASH = 3000000;
// 月別の需要指数（4月開業スタート）
const MONTHS = [
  { m: 4, idx: 0.70 }, { m: 5, idx: 0.95 }, { m: 6, idx: 1.15 }, { m: 7, idx: 1.60 }, { m: 8, idx: 1.80 }, { m: 9, idx: 1.30 },
  { m: 10, idx: 0.85 }, { m: 11, idx: 0.50 }, { m: 12, idx: 0.40 }, { m: 1, idx: 0.35 }, { m: 2, idx: 0.35 }, { m: 3, idx: 0.50 },
];
const MAX_TURN = MONTHS.length;
// 人員
const WAGE_REG = 150000, WAGE_BAITO = 120000, WAGE_SPOT = 170000, TRAIN = 20000;
const PROD_BAITO = 0.85, PROD_NEW = 0.6;           // 戦力（社員=1.0）
// 所与の固定費（変更不可）
const GIVEN = [["🏠 店舗家賃", 156000], ["💡 光熱費（基本）", 65000], ["📡 保険・通信費ほか", 39000], ["🏭 マシンリース（1台）", 100000]];
const GIVEN_TOTAL = GIVEN.reduce((a, g) => a + g[1], 0);
// 品種：価格・原価は固定。share＝来店客のうち、その品種を選ぶ割合
const VARIETIES = [
  { id: "prem", name: "プレミアム", icon: "🥭", desc: "ピスタチオ・マンゴー等の贅沢ジェラート", price: 650, cost: 195, share: 0.30 },
  { id: "std",  name: "定番",       icon: "🍦", desc: "ミルク・チョコ。一番人気",             price: 400, cost: 160, share: 0.70 },
];
const BASE_CAP = 50, OPS_CAP_BONUS = 10;           // 1人あたり接客上限（杯/日）
const OPS_LOSS_RECOVER = 0.15, OPS_COST = 200000, OPS_MAX = 3;
const BASE_DEMAND = 155;                           // 指数1.0・広報なしの来店客数（杯/日）
const HOT_EXTRA = 25;                              // 猛暑月の保冷剤コスト/杯
const SUBSTITUTE = 0.35;                           // 売り切れ品種の客が他の品種に切り替える割合
const AD_MAX = 800000;
const adFactor = spend => 1 + 1.6 * (1 - Math.exp(-spend / 390000));   // 広報レバレッジ（逓減）
const PROD_MAX = 5000;

// ===== 状態 =====
const S = {
  turn: 1, cash: START_CASH, penalty: 1.0, opsLevel: 0, phase: "plan",
  ops: false, cond: null, history: [], showMap: false, mapSpot: 0, showBest: false,
  regular: 2, lastBaito: 0, carry: 1, wageMul: 1, hap: "some", strategy: null, reasons: [], memo: "",
  prod: { prem: 1000, std: 2500 },
};
const $ = id => document.getElementById(id);
const yen = n => (n < 0 ? "-" : "") + "¥" + Math.abs(Math.round(n)).toLocaleString();
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const capPer = (lv = S.opsLevel) => BASE_CAP + lv * OPS_CAP_BONUS;
const pct = x => Math.round(x * 100) + "%";

// ===== ハプニング（イベント）の定義 =====
const HAP = { none: 0, some: 1, many: 1.7 };
const E0 = { demandF: 1, powerDelta: 0, matMul: 1, extraCost: 0, wageMul: 1 };
const comb = (...es) => es.reduce((a, e) => e ? { demandF: a.demandF * (e.demandF ?? 1), powerDelta: a.powerDelta + (e.powerDelta ?? 0),
  matMul: a.matMul * (e.matMul ?? 1), extraCost: a.extraCost + (e.extraCost ?? 0), wageMul: a.wageMul * (e.wageMul ?? 1) } : a, E0);
// 予告あり（確定・予想に反映される）
const KNOWN_EVENTS = [
  { id: "matsuri", icon: "🎪", name: "近所のお祭り", months: [7, 8, 10], text: "人出が増えて、来店が増えそうです", eff: { demandF: 1.2 } },
  { id: "rival", icon: "🏬", name: "競合のジェラート店が近所に出店", months: [5, 6, 7, 9], text: "お客さんが分散しそうです（来月も少し影響）", eff: { demandF: 0.9 }, carry: 0.95 },
  { id: "minwage", icon: "💴", name: "最低賃金の改定", months: [10], forced: true, text: "人件費が上がります（この月以降ずっと）", eff: { wageMul: 1.05 } },
];
// 天候リスク（確率だけ分かる・予想には入っていない）
const WEATHER_RISKS = [
  { id: "typhoon", icon: "🌀", name: "台風の接近", months: [8, 9, 10], p: 0.25, text: "来店が大きく減ります", eff: { demandF: 0.72 } },
  { id: "rain", icon: "☔", name: "長雨", months: [6, 7, 9], p: 0.30, text: "来店が減ります", eff: { demandF: 0.87 } },
  { id: "heat", icon: "🥵", name: "猛暑日が続く", months: [7, 8], p: 0.35, text: "客足は伸びますが、冷却・光熱費が増えます", eff: { demandF: 1.15, extraCost: 40000 } },
  { id: "cold", icon: "❄️", name: "寒波", months: [12, 1, 2], p: 0.25, text: "来店がさらに減ります", eff: { demandF: 0.87 } },
  { id: "snap", icon: "🌸", name: "花冷え", months: [4], p: 0.25, text: "肌寒く、来店が減ります", eff: { demandF: 0.9 } },
];
// 突発（予告なし・営業してみるまで分からない）
const SUDDEN_EVENTS = [
  { id: "sick", icon: "🤒", name: "スタッフの急な欠員", w: 3, text: "接客できる人員が0.6人分減りました（数日間の欠勤）", eff: { powerDelta: -0.6 } },
  { id: "broken", icon: "🔧", name: "マシン故障", w: 2, text: "数日間営業が止まり、修理費もかかりました", eff: { demandF: 0.93, extraCost: 60000 } },
  { id: "price", icon: "📈", name: "食材価格の高騰", w: 2, text: "原価が10%上がりました", eff: { matMul: 1.10 } },
  { id: "media", icon: "📺", name: "メディアで紹介された", w: 1, text: "お客さんが急増しました（来月も少し続きそう）", eff: { demandF: 1.3 }, carry: 1.1 },
  { id: "group", icon: "🚌", name: "団体のお客さんが来店", w: 2, text: "想定外の追い風です", eff: { demandF: 1.15 } },
  { id: "sns", icon: "😡", name: "SNSでクレームが拡散", w: 1, text: "お客さんが遠のきました（来月も少し影響）", eff: { demandF: 0.85 }, carry: 0.95 },
];
function effText(e) {
  const t = [];
  if (e.demandF && e.demandF !== 1) t.push(`来店客数 ${e.demandF > 1 ? "+" : ""}${Math.round((e.demandF - 1) * 100)}%`);
  if (e.powerDelta) t.push(`接客人員 ${e.powerDelta}人分`);
  if (e.matMul && e.matMul !== 1) t.push(`原価 +${Math.round((e.matMul - 1) * 100)}%`);
  if (e.extraCost) t.push(`臨時費用 ${yen(e.extraCost)}`);
  if (e.wageMul && e.wageMul !== 1) t.push(`人件費 +${Math.round((e.wageMul - 1) * 100)}%`);
  return t.join("・");
}

// ===== 今月の条件（予想と実際） =====
function makeCond(turn) {
  const mo = MONTHS[turn - 1];
  const trueF = Math.min(1.25, Math.max(0.78, 1 + (Math.random() + Math.random() + Math.random() - 1.5) * 0.2));
  const fF = Math.min(1.25, Math.max(0.78, trueF + (Math.random() - 0.5) * 0.12));   // 予報は少しズレる
  const summer = mo.idx >= 1.15;
  const label = trueF >= 1.08 ? (summer ? "猛暑" : "好天続き") : trueF <= 0.92 ? (summer ? "冷夏・長雨" : "悪天候続き") : "平年並み";
  const mult = HAP[S.hap];
  let known = null;
  if (mult > 0) {
    const forced = KNOWN_EVENTS.find(e => e.forced && e.months.includes(mo.m));
    if (forced) known = forced;
    else { const cand = KNOWN_EVENTS.filter(e => !e.forced && e.months.includes(mo.m)); if (cand.length && Math.random() < Math.min(0.7, 0.3 * mult)) known = cand[Math.floor(Math.random() * cand.length)]; }
  }
  const risks = mult > 0 ? WEATHER_RISKS.filter(e => e.months.includes(mo.m)).map(e => { const p = Math.min(0.85, e.p * mult); return { ev: e, p, realized: Math.random() < p }; }) : [];
  let seen = false; risks.forEach(k => { if (k.realized) { if (seen) k.realized = false; seen = true; } });   // 同時に起きるのは1つまで
  let sudden = null;
  if (mult > 0 && Math.random() < Math.min(0.6, 0.2 * mult)) {
    let x = Math.random() * SUDDEN_EVENTS.reduce((a, e) => a + e.w, 0);
    sudden = SUDDEN_EVENTS.find(e => (x -= e.w) < 0) || SUDDEN_EVENTS[0];
  }
  return { turn, m: mo.m, idx: mo.idx, trueF, fF, label, noise: 0.97 + Math.random() * 0.06, known, risks, sudden,
    effKnown: known ? comb(known.eff) : E0, effRisk: comb(...risks.filter(k => k.realized).map(k => k.ev.eff)), effSudden: sudden ? comb(sudden.eff) : E0,
    newCarry: (known?.carry ?? 1) * (sudden?.carry ?? 1) };
}
function fLabel(f) { return f >= 1.08 ? "平年より高め" : f <= 0.92 ? "平年より低め" : "平年並み"; }

// ===== 計算（予想も実績も同じ式） =====
function plan() {
  return { prod: { ...S.prod }, ads: +$("ads").value, ops: S.ops,
    regular: +$("regular").value, baito: +$("baito").value, spot: +$("spot").value };
}
// mode: false＝予想 / true＝実績 / {weather,risks,sudden,noise,extra}＝段階ごとの試算
function evaluate(p, c, mode) {
  const m = mode === true ? { weather: 1, risks: 1, sudden: 1, noise: 1 } : (mode || {});
  const f = m.weather ? c.trueF : c.fF;
  let eff = c.effKnown;
  if (m.risks) eff = comb(eff, c.effRisk);
  if (m.sudden) eff = comb(eff, c.effSudden);
  if (m.extra) eff = comb(eff, m.extra);
  const mm = eff.matMul, wm = S.wageMul * eff.wageMul;
  const lvl = S.opsLevel + (p.ops && S.opsLevel < OPS_MAX ? 1 : 0);
  const raw = BASE_DEMAND * DAYS * c.idx * f * adFactor(p.ads) * S.penalty * S.carry * eff.demandF;
  const demand = Math.round(raw * (m.noise ? c.noise : 1));
  const dv = {}; let acc = 0;
  VARIETIES.forEach((v, i) => { dv[v.id] = i < VARIETIES.length - 1 ? Math.round(demand * v.share) : demand - acc; acc += dv[v.id]; });
  // 販売：まず自分の品種、売り切れ分の一部は他品種へ
  const sv = {}, left = {}; let unmet = 0, leftSum = 0;
  VARIETIES.forEach(v => { sv[v.id] = Math.min(dv[v.id], p.prod[v.id]); unmet += dv[v.id] - sv[v.id]; left[v.id] = p.prod[v.id] - sv[v.id]; leftSum += left[v.id]; });
  const switching = Math.min(unmet * SUBSTITUTE, leftSum);
  if (switching > 0) VARIETIES.forEach(v => { sv[v.id] += Math.round(switching * left[v.id] / leftSum); });
  // 戦力と接客上限
  const retained = Math.min(p.baito, S.lastBaito), newHire = Math.max(0, p.baito - S.lastBaito);
  const power = Math.max(0, p.regular + PROD_BAITO * retained + PROD_NEW * newHire + p.spot + eff.powerDelta);
  const cap = Math.floor(power * capPer(lvl) * DAYS);
  let total = sum(sv), capped = false;
  if (total > cap) { capped = true; VARIETIES.forEach(v => { sv[v.id] = Math.floor(sv[v.id] * cap / total); }); total = sum(sv); }
  const prodTotal = sum(p.prod);
  const lost = Math.max(0, demand - total);
  const limiter = capped ? "staff" : lost > demand * 0.03 ? "stock" : "demand";
  const extra = c.idx * f >= 1.45 ? HOT_EXTRA : 0;
  let sales = 0, matCost = 0, lossRecovered = 0, lossQty = 0, unit = 0;
  const loss = {}, vm = {};
  VARIETIES.forEach(v => {
    sales += sv[v.id] * v.price; matCost += p.prod[v.id] * v.cost * mm;
    loss[v.id] = p.prod[v.id] - sv[v.id]; lossQty += loss[v.id];
    const rec = loss[v.id] * v.cost * mm * lvl * OPS_LOSS_RECOVER;
    lossRecovered += rec;
    vm[v.id] = sv[v.id] * v.price - p.prod[v.id] * (v.cost * mm + extra) + rec;
    unit += v.share * (v.price - v.cost * mm - extra);
  });
  const seasonCost = prodTotal * extra;
  const varCost = matCost + seasonCost - lossRecovered;
  const margin = sales - varCost;
  // 費用の3層
  const regCost = p.regular * WAGE_REG * wm, opsCost = lvl > S.opsLevel ? OPS_COST : 0;
  const fixedCost = GIVEN_TOTAL + regCost + opsCost + eff.extraCost;
  const baitoCost = p.baito * WAGE_BAITO * wm, trainCost = newHire * TRAIN, spotCost = p.spot * WAGE_SPOT * wm;
  const semiCost = baitoCost + trainCost + spotCost + p.ads;
  const allFixed = fixedCost + semiCost;
  const staffCost = regCost + baitoCost + trainCost + spotCost;
  const marginRate = sales > 0 ? margin / sales : 0;
  const bepSales = marginRate > 0 ? allFixed / marginRate : Infinity;
  return { f, demand, dLo: Math.round(raw * 0.85), dHi: Math.round(raw * 1.15), dv, sv, pv: p.prod, loss, vm, cap, power,
    prod: prodTotal, sold: total, limiter, lossQty, sales, matCost, seasonCost, lossRecovered, varCost, margin,
    regCost, opsCost, eventCost: eff.extraCost, matMul: mm, wm, fixedCost, baitoCost, trainCost, spotCost, ads: p.ads, semiCost, allFixed, staffCost,
    regular: p.regular, baito: p.baito, spot: p.spot, newHire, retained,
    profit: margin - allFixed, lvl, lost, unit, extra, marginRate, bepSales,
    safety: sales > 0 && isFinite(bepSales) ? (sales - bepSales) / sales : -1,
    bepQty: unit > 0 ? Math.ceil(allFixed / unit) : Infinity };
}

// ===== 部品の描画 =====
function meterHTML(r, anim) {
  const ok = r.margin >= r.allFixed;
  const max = Math.max(r.allFixed * 1.5, r.margin * 1.05, 1);
  return `<div class="bep"><div class="bep-track">
    <div class="bep-margin ${ok ? "over" : ""} ${anim ? "anim" : ""}" style="width:${Math.max(0, r.margin) / max * 100}%"></div>
    <div class="bep-line" style="left:${r.allFixed / max * 100}%"><span>固定費＋準変動費 ${yen(r.allFixed)}</span></div></div>
    <div class="bep-legend"><i class="g"></i>限界利益 ${yen(r.margin)}　<i class="b"></i>固定費＋準変動費ライン　${ok ? "✅ 損益分岐点を超えます" : "❌ あと " + yen(r.allFixed - r.margin) + " 足りません"}</div></div>`;
}
function barsHTML(r) {
  const mx = Math.max(r.demand, r.prod, r.cap, 1);
  const rows = [["demand", "👥 来店客数（需要）", r.demand], ["stock", "🥄 製造量（在庫）", r.prod], ["staff", "🧑‍🍳 接客上限（人員）", r.cap]];
  return `<div class="bars">` + rows.map(([k, n, v]) =>
    `<div class="row ${k === r.limiter ? "min" : ""}"><span>${n}</span><div class="bar"><div style="width:${v / mx * 100}%"></div></div><span>${v.toLocaleString()}杯</span></div>`).join("")
    + `<div class="row"><span>→ 販売数</span><div></div><b>${r.sold.toLocaleString()}杯</b></div></div>`;
}
function kpiHTML(r) {
  return `<div class="kpis">
    <div class="kpi"><span>売上高</span><b>${yen(r.sales)}</b></div>
    <div class="kpi pink"><span>変動費</span><b>${yen(r.varCost)}</b></div>
    <div class="kpi green"><span>限界利益</span><b>${yen(r.margin)}</b></div>
    <div class="kpi blue"><span>固定費</span><b>${yen(r.fixedCost)}</b></div>
    <div class="kpi yellow"><span>準変動費</span><b>${yen(r.semiCost)}</b></div>
    <div class="kpi ${r.profit >= 0 ? "plus" : "minus"} wide"><span>営業利益</span><b>${yen(r.profit)}</b></div></div>`;
}
function bepInfoHTML(r) {
  const safe = r.safety;
  return `<div class="bepinfo"><div><span>損益分岐点売上高</span><b>${isFinite(r.bepSales) ? yen(r.bepSales) : "—"}</b></div>
    <div><span>今月の売上高</span><b>${yen(r.sales)}</b></div>
    <div><span>経営安全率</span><b class="${safe >= 0 ? "pos" : "neg"}">${r.sales > 0 && isFinite(r.bepSales) ? Math.round(safe * 100) + "%" : "—"}</b></div></div>
    <div class="bep-note">経営安全率 ＝（売上高 − 損益分岐点売上高）÷ 売上高。高いほど、売上が落ちても赤字になりにくい体質です。</div>`;
}
function varTableHTML(r) {
  return `<table class="vs vt"><tr><th>品種</th><th>需要</th><th>製造</th><th>販売</th><th>ロス</th><th>限界利益</th></tr>` +
    VARIETIES.map(v => `<tr><td>${v.icon} ${v.name}</td><td>${r.dv[v.id].toLocaleString()}</td><td>${r.pv[v.id].toLocaleString()}</td><td><b>${r.sv[v.id].toLocaleString()}</b></td>
      <td class="${r.loss[v.id] > r.pv[v.id] * 0.1 && r.loss[v.id] > 100 ? "neg" : ""}">${r.loss[v.id].toLocaleString()}</td><td class="${r.vm[v.id] < 0 ? "neg" : ""}">${yen(r.vm[v.id])}</td></tr>`).join("") + `</table>`;
}
function plHTML(r) {
  const L = (n, v, cls = "", neg = false) => `<tr class="${cls}"><td>${n}</td><td class="${neg ? "neg" : ""}">${yen(v)}</td></tr>`;
  return `<table class="pl">` +
    VARIETIES.map(v => L(`　${v.icon} ${v.name}（${r.sv[v.id].toLocaleString()}杯 × ${yen(v.price)}）`, r.sv[v.id] * v.price)).join("") +
    L("売上高", r.sales, "sub") +
    L(`　材料費（製造 ${r.prod.toLocaleString()}杯）`, -r.matCost) +
    (r.seasonCost ? L("　猛暑の保冷剤コスト", -r.seasonCost) : "") +
    (r.lossRecovered ? L("　ロス軽減効果（業務改善）", r.lossRecovered) : "") +
    L(`変動費 計（うちロス ${r.lossQty.toLocaleString()}杯）`, -r.varCost, "sub l-var") +
    L("限界利益", r.margin, "sub", r.margin < 0) +
    GIVEN.map(g => L(`　🔒 ${g[0].slice(2)}`, -g[1])).join("") +
    L(`　社員給与（${r.regular}人）`, -r.regCost) +
    (r.opsCost ? L("　オペレーション改善投資", -r.opsCost) : "") + (r.eventCost ? L("　臨時費用（修理・冷却など）", -r.eventCost) : "") +
    L("固定費 計", -r.fixedCost, "sub l-fix") +
    L(`　アルバイト（${r.baito}人）`, -r.baitoCost) +
    (r.trainCost ? L(`　新人の研修費（${r.newHire}人）`, -r.trainCost) : "") +
    (r.spot ? L(`　スポット人員（${r.spot}人）`, -r.spotCost) : "") +
    (r.ads ? L("　広報費", -r.ads) : "") +
    L("準変動費 計", -r.semiCost, "sub l-semi") +
    L("営業利益", r.profit, "sub", r.profit < 0) + `</table>`;
}

// ===== 予想ビュー =====
function renderPlan() {
  const c = S.cond, p = plan(), r = evaluate(p, c, false);
  const hot = c.idx * c.fF >= 1.45;
  const idxNote = c.idx >= 1.3 ? "繁忙期（ピーク）" : c.idx <= 0.5 ? "閑散期" : "通常期";
  $("conds").innerHTML =
    `<div class="cond"><span>今月</span><b>${c.m}月</b><em>${idxNote}</em></div>
     <div class="cond"><span>季節の需要指数</span><b>${c.idx.toFixed(2)}</b><em class="${c.idx >= 1.3 ? "hi" : ""}">平年の水準</em></div>
     <div class="cond"><span>今月の天候予報</span><b>${fLabel(c.fF)}</b><em class="${hot ? "hi" : ""}">${hot ? "猛暑！保冷剤+¥25/杯" : "予報は外れることも"}（${c.fF >= 1 ? "+" : ""}${Math.round((c.fF - 1) * 100)}%）</em></div>
     <div class="cond"><span>前月の影響</span><b>${S.penalty < 1 ? "⚠️ 需要ダウン" : S.carry !== 1 ? (S.carry > 1 ? "追い風" : "向かい風") : "なし"}</b><em>${S.penalty < 1 ? `×${S.penalty.toFixed(2)}（行列クレーム）` : S.carry !== 1 ? `×${S.carry.toFixed(2)}（前月のできごと）` : "順調"}</em></div>`;
  $("forecast").innerHTML =
    `<div class="fc-demand">👥 予想来店客数 <b>約 ${r.demand.toLocaleString()} 人</b>（1日 約${Math.round(r.demand / DAYS)}人）<small>（${r.dLo.toLocaleString()}〜${r.dHi.toLocaleString()}人の範囲でブレます）</small></div>` +
    `<div class="fc-tag">下は「予想どおりに営業した場合」の見通しです。人員・広報・製造量を調整してみましょう。</div>` +
    kpiHTML(r) + `<h3>🎯 損益分岐点メーター（限界利益 vs 固定費＋準変動費）</h3>` + meterHTML(r, false) + bepInfoHTML(r) +
    `<h3>🍨 品種別の見通し</h3>` + varTableHTML(r) +
    `<h3>🍦 何がボトルネック？（販売数 ＝ 一番低い数値）</h3>` + barsHTML(r) +
    `<h3>🧾 予想損益計算書</h3>` + plHTML(r);
  renderEvents(p, r); renderStrategy();
  renderQuick(p, r); renderAdsCmp(p, r); renderMap(p);
  { const np0 = { ...p, ads: 0 }; np0.prod = fitProd(np0); const r0b = evaluate(np0, c, false);
    $("balance").innerHTML = balanceHTML(r, p.ads > 0 ? (r.margin - r0b.margin) / p.ads : 0, p.ads > 0); }
  renderGuide(p, r);
  // 左パネル
  $("regular").min = S.regular;
  if (+$("regular").value < S.regular) $("regular").value = S.regular;
  $("regVal").textContent = p.regular + "人";
  $("regNote").innerHTML = `1人 ${yen(WAGE_REG * r.wm)}/月・戦力1.0。<b>一度増やすと減らせません</b>${p.regular > S.regular ? `（今月 +${p.regular - S.regular}人で固定費が増えます）` : ""}`;
  $("baitoVal").textContent = p.baito + "人";
  $("baitoNote").innerHTML = `1人 ${yen(WAGE_BAITO * r.wm)}/月・戦力${PROD_BAITO}。前月 ${S.lastBaito}人 → 新規 <b>${r.newHire}人</b>（研修費 ${yen(TRAIN)}/人・今月の戦力${PROD_NEW}）`;
  $("spotVal").textContent = p.spot + "人";
  $("spotNote").textContent = `1人 ${yen(WAGE_SPOT * r.wm)}/月・戦力1.0。割高だが研修不要で即戦力、翌月に持ち越しません`;
  $("staffTotal").textContent = `合計 ${p.regular + p.baito + p.spot}人（戦力 ${r.power.toFixed(1)}人分）`;
  $("capNote").innerHTML = `⚙️ 接客上限 <b>${r.cap.toLocaleString()}杯/月</b>（1日 約${Math.round(r.cap / DAYS)}杯）　予想需要 ${r.demand.toLocaleString()}杯 → 必要な戦力の目安 <b>${(r.demand / DAYS / capPer(r.lvl)).toFixed(1)}人分</b>`;
  $("varList").innerHTML = VARIETIES.map(v => `<div class="var">
      <div class="var-h"><b>${v.icon} ${v.name}</b><span class="rate">利益率 ${Math.round((v.price - v.cost) / v.price * 100)}%</span></div>
      <div class="var-i">${v.desc}<br>価格 ${yen(v.price)}／原価 ${yen(v.cost * r.matMul)}／1杯の利益 <b>${yen(v.price - v.cost * r.matMul - r.extra)}</b>　予想需要 <b>${r.dv[v.id].toLocaleString()}杯</b></div>
      <div class="var-s"><input type="range" min="0" max="${PROD_MAX}" step="50" value="${S.prod[v.id]}" data-v="${v.id}"><b>${S.prod[v.id].toLocaleString()}杯</b></div>
    </div>`).join("");
  document.querySelectorAll("#varList input").forEach(el => el.oninput = () => { S.prod[el.dataset.v] = +el.value; renderPlan(); });
  $("adsVal").textContent = yen(p.ads);
  $("goBtn").disabled = S.phase !== "plan" || !S.strategy;
  $("goBtn").textContent = S.strategy ? "🍦 今月の営業開始！" : "🎯 先に、今月の戦略を選んでね";
  const r0 = evaluate({ ...p, ads: 0 }, c, false);
  const gain = r.demand - r0.demand;
  $("adsNote").innerHTML = `需要 ×${adFactor(p.ads).toFixed(2)}：来店客数 <b>+${gain.toLocaleString()}人</b>（広報なし ${r0.demand.toLocaleString()}人 → ${r.demand.toLocaleString()}人）。` +
    (p.ads > 0 ? `<br>客数1人あたり広報費 ${yen(p.ads / Math.max(gain, 1))} ／ 1人の限界利益 約${yen(r.unit)}${r.limiter === "staff" ? "　<b>⚠️ 接客上限で頭打ち</b>" : ""}` : "<br>広報を増やすと需要は大きく伸びます（使うほど効き目は薄れます）");
  const opsMax = S.opsLevel >= OPS_MAX;
  $("opsBtn").disabled = opsMax;
  $("opsBtn").classList.toggle("on", S.ops && !opsMax);
  $("opsNote").textContent = opsMax ? "最大レベルです" : `${yen(OPS_COST)}（固定費）/ 接客+10杯/人・日、ロス-15%（Lv${S.opsLevel}→${S.opsLevel + 1}）。効果は来月以降も続きます`;
}
function renderHeader() {
  const mo = MONTHS[Math.min(S.turn, MAX_TURN) - 1];
  $("dayChip").textContent = `📅 ${mo.m}月（${Math.min(S.turn, MAX_TURN)} / ${MAX_TURN}か月目）`;
  $("cashChip").textContent = "💰 " + yen(S.cash);
  $("givenList").innerHTML = GIVEN.map(g => `<span>${g[0]} ${yen(g[1])}</span>`).join("") + `<span class="tot">計 ${yen(GIVEN_TOTAL)}/月</span>`;
}
function renderHist() {
  const maxAbs = Math.max(...S.history.map(h => Math.abs(h.profit)), 1);
  $("hist").innerHTML = S.history.map(h => {
    const hg = Math.abs(h.profit) / maxAbs * 50;
    return `<div class="h" title="${h.m}月: ${yen(h.profit)}"><div class="${h.profit >= 0 ? "p" : "m"}" style="${h.profit >= 0 ? "bottom" : "top"}:50%;height:${hg}%"></div><i>${h.m}</i></div>`;
  }).join("");
  // 累計グラフ：累計の限界利益 vs 累計の（固定費＋準変動費）
  if (!S.history.length) { $("cum").innerHTML = `<div class="hist-empty">まだデータがありません</div>`; return; }
  let cm = 0, cc = 0; const A = [[0, 0]], B = [[0, 0]];
  S.history.forEach((h, i) => { cm += h.margin; cc += h.allFixed; A.push([i + 1, cm]); B.push([i + 1, cc]); });
  const mx = Math.max(cm, cc, 1), W = 600, H = 190, X = i => 40 + i / MAX_TURN * (W - 55), Y = v => H - 20 - v / mx * (H - 40);
  const line = (pts, col) => `<polyline fill="none" stroke="${col}" stroke-width="3" points="${pts.map(p => X(p[0]) + "," + Y(p[1])).join(" ")}"/>`;
  const xl = S.history.map((h, i) => `<text x="${X(i + 1)}" y="${H - 4}" font-size="10" text-anchor="middle" fill="#8a7060">${h.m}月</text>`).join("");
  const over = cm >= cc;
  $("cum").innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="cumsvg">${line(B, "#6aa8ff")}${line(A, "#2fa88a")}${xl}
    <text x="${W - 8}" y="14" font-size="11" text-anchor="end" fill="#2fa88a">● 累計の限界利益 ${yen(cm)}</text>
    <text x="${W - 8}" y="28" font-size="11" text-anchor="end" fill="#3c6fcc">● 累計の固定費＋準変動費 ${yen(cc)}</text></svg>
    <div class="bep-legend">${over ? "✅ 年間累計で損益分岐点を超えています（累計黒字）" : "❌ 累計では、まだ損益分岐点に届いていません"}　累計の営業利益 ${yen(cm - cc)}</div>`;
}

// ===== 判断の材料：早見表と広報の比較 =====
function renderQuick(p, r) {
  const capDay = r.cap / DAYS;
  const rows = VARIETIES.map(v => {
    const vc = v.cost * r.matMul + r.extra, um = v.price - vc;
    const bq = um > 0 ? Math.ceil(r.allFixed / um) : Infinity, bq0 = um > 0 ? Math.ceil(r.fixedCost / um) : Infinity;
    const day = bq / DAYS;
    return `<tr><td>${v.icon} ${v.name}</td><td>${yen(v.price)}</td><td>${yen(vc)}</td><td class="hl"><b>${yen(um)}</b></td><td>${Math.round(um / v.price * 100)}%</td>
      <td>${isFinite(bq0) ? bq0.toLocaleString() : "—"}杯</td>
      <td class="hl"><b>${isFinite(bq) ? bq.toLocaleString() : "—"}杯</b><small>（1日 約${Math.ceil(day)}杯／売上 ${yen(bq * v.price)}）</small>${day > capDay ? '<br><small class="neg">⚠️ 接客上限（1日 約' + Math.round(capDay) + '杯）超え</small>' : ""}</td></tr>`;
  }).join("");
  const avgP = VARIETIES.reduce((a, v) => a + v.share * v.price, 0), avgC = VARIETIES.reduce((a, v) => a + v.share * (v.cost * r.matMul + r.extra), 0);
  const bqm = r.unit > 0 ? Math.ceil(r.allFixed / r.unit) : Infinity;
  const [a, b] = VARIETIES, ua = a.price - a.cost * r.matMul - r.extra, ub = b.price - b.cost * r.matMul - r.extra;
  $("quick").innerHTML = `<div class="quick"><h3>📌 損益分岐点の早見表（今月の固定費で、品種ごとに見ると）</h3>
    <div class="q-top"><div><span>固定費</span><b>${yen(r.fixedCost)}</b></div><div><span>＋ 準変動費</span><b>${yen(r.semiCost)}</b></div><div class="q-sum"><span>＝ 回収すべき費用</span><b>${yen(r.allFixed)}</b></div></div>
    <table class="vs vt qt"><tr><th>品種</th><th>価格</th><th>変動費<small>（原価）</small></th><th>1杯の限界利益</th><th>限界利益率</th><th>損益分岐点<small>（固定費だけ）</small></th><th>損益分岐点<small>（固定費＋準変動費）</small></th></tr>${rows}
      <tr class="mix"><td>🍨 今の売れ筋ミックス<br><small>（${VARIETIES.map(v => v.name + Math.round(v.share * 100) + "%").join("・")}）</small></td><td>${yen(avgP)}</td><td>${yen(avgC)}</td><td class="hl"><b>${yen(r.unit)}</b></td><td>${Math.round(r.unit / avgP * 100)}%</td>
      <td>${r.unit > 0 ? Math.ceil(r.fixedCost / r.unit).toLocaleString() : "—"}杯</td><td class="hl"><b>${isFinite(bqm) ? bqm.toLocaleString() : "—"}杯</b><small>（1日 約${Math.ceil(bqm / DAYS)}杯）</small></td></tr></table>
    <div class="q-note">📘 損益分岐点の杯数 ＝ 費用 ÷ 1杯の限界利益。<b>${a.icon}${a.name}は1杯で ${yen(ua)}</b> 稼ぐので、定番（${yen(ub)}）の約 <b>${(ua / ub).toFixed(1)}倍</b>の速さで固定費を回収できます。ただし来店客の ${Math.round(a.share * 100)}% しか選びません。</div></div>`;
}
function renderAdsCmp(p, r) {
  const levels = [...new Set([0, 100000, 200000, 400000, 800000, p.ads])].sort((x, y) => x - y);
  const res = levels.map(ads => { const np = { ...p, ads }; np.prod = fitProd(np); return { ads, nr: evaluate(np, S.cond, false) }; });
  const base = res[0].nr;
  const rows = res.map(({ ads, nr }) => {
    const gain = nr.margin - base.margin, net = gain - ads;
    const verdict = ads === 0 ? "（基準）" : nr.limiter === "staff" ? "⚠️ 接客上限で頭打ち" : net > 0 ? "✅ 広報が得" : "❌ 広報費の方が高い";
    return `<tr class="${ads === p.ads ? "cur" : ""}"><td>${ads === 0 ? "広報なし" : yen(ads)}${ads === p.ads ? " 👈今の設定" : ""}</td><td>${nr.demand.toLocaleString()}</td><td>${nr.sold.toLocaleString()}</td>
      <td>${yen(nr.margin)}</td><td>${ads === 0 ? "—" : (gain >= 0 ? "+" : "") + yen(gain)}</td><td class="${ads === 0 ? "" : net >= 0 ? "pos" : "neg"}">${ads === 0 ? "—" : (net >= 0 ? "+" : "") + yen(net)}</td><td><b>${yen(nr.profit)}</b></td><td>${verdict}</td></tr>`;
  }).join("");
  const bestR = res.reduce((a, x) => (x.nr.profit > a.nr.profit ? x : a), res[0]);
  $("adscmp").innerHTML = `<div class="quick"><h3>📣 広報を使う？ 使わない？（限界利益で比較）</h3>
    <table class="vs vt qt"><tr><th>広報費</th><th>来店客数</th><th>販売杯数</th><th>限界利益</th><th>広報による<br>限界利益の増加</th><th>増加 − 広報費<br><small>（利益の純増）</small></th><th>営業利益</th><th>判定</th></tr>${rows}</table>
    <div class="q-note">📘 広報は、<b>限界利益の増加 ＞ 広報費</b> なら得です。ただし接客上限を超えた分は売れず、広報費は無駄になります。${bestR.ads === 0 ? "今月は<b>広報なし</b>が最も利益が高い見込みです。" : `今月は<b>広報 ${yen(bestR.ads)}</b> 付近が最も利益が高い見込みです。`}（製造量は、各ケースで予想に合わせています）</div></div>`;
}

// ===== 3つのバランスメーター =====
function balanceHTML(r, roi, hasAds) {
  const util = r.cap > 0 ? r.demand / r.cap : 0, digest = r.prod > 0 ? r.sold / r.prod : 1;
  const st = (v, good, warn) => v >= good[0] && v <= good[1] ? "good" : v >= warn[0] && v <= warn[1] ? "warn" : "bad";
  const uS = st(util, [0.9, 1.05], [0.7, 1.2]), dS = digest >= 0.95 ? "good" : digest >= 0.85 ? "warn" : "bad";
  const aS = !hasAds ? "none" : roi >= 1 ? "good" : roi >= 0.5 ? "warn" : "bad";
  const uT = util < 0.7 ? "人員に余裕があります。この人件費は、今月の売上に見合っていますか？" : util < 0.9 ? "やや余裕があります。" : util <= 1.05 ? "需要と人員がよく揃っています。" : "需要が接客上限を超えています。取りこぼしの損失と、人員を増やす費用を比べてみましょう。";
  const dT = digest < 0.85 ? "作りすぎです。売れ残りはそのままロス（材料費の無駄）になります。" : digest < 0.95 ? "少しロスが出ています。" : r.limiter === "stock" ? "売り切れています。作る量は足りていますか？" : "ほとんど売り切れています。";
  const aT = !hasAds ? "広報なし。広報を使うと、需要はどれだけ増えるでしょう？" : roi < 1 ? "広報で増えた限界利益が、広報費より小さいです。接客上限で頭打ちになっていませんか？" : "広報費以上に、限界利益が増えています。";
  const tile = (title, val, target, s, text) => `<div class="bt ${s}"><div class="bt-h">${title}</div><div class="bt-v">${val}</div><div class="bt-g">目安：${target}</div><div class="bt-t">${text}</div></div>`;
  return `<div class="bal"><h3>⚖️ 3つのバランス（需要・人員・製造は揃っていますか？）</h3><div class="bal-g">` +
    tile("🧑‍🍳 人員の稼働率", Math.round(util * 100) + "%", "90〜100%（需要 ÷ 接客上限）", uS, uT) +
    tile("🥄 在庫の消化率", Math.round(digest * 100) + "%", "95%以上（販売 ÷ 製造）", dS, dT) +
    tile("📣 広報の費用対効果", hasAds ? roi.toFixed(1) + "倍" : "—", "1.0倍以上（限界利益の増加 ÷ 広報費）", aS, aT) + `</div></div>`;
}

// ===== 利益マップ（広報 × アルバイト、タブでスポット人員） =====
const MAP_ADS = [0, 100000, 200000, 300000, 400000, 600000, 800000], MAP_BAITO = [0, 1, 2, 3, 4, 5, 6, 7, 8];
function mapCell(p, ads, baito, spot) { const np = { ...p, ads, baito, spot }; np.prod = fitProd(np); return evaluate(np, S.cond, false).profit; }
function renderMap(p) {
  const box = $("pmap");
  if (!S.showMap) { box.innerHTML = `<button class="mapbtn" id="mapToggle">🗺️ 利益マップを見る（広報 × 人員）</button>`; return; }
  const spot = S.mapSpot;
  const cells = MAP_ADS.map(a => MAP_BAITO.map(b => mapCell(p, a, b, spot)));
  const flat = cells.flat(), mx = Math.max(...flat, 1), mn = Math.min(...flat, -1);
  let best = null; if (S.showBest) cells.forEach((row, i) => row.forEach((v, j) => { if (!best || v > best.v) best = { v, i, j }; }));
  const color = v => v >= 0 ? `hsl(140,50%,${96 - 38 * v / mx}%)` : `hsl(0,70%,${96 - 30 * v / mn}%)`;
  const rows = cells.map((row, i) => `<tr><th>${MAP_ADS[i] === 0 ? "広報なし" : "¥" + MAP_ADS[i] / 10000 + "万"}</th>` + row.map((v, j) =>
    `<td data-a="${MAP_ADS[i]}" data-b="${MAP_BAITO[j]}" style="background:${color(v)}" class="${p.ads === MAP_ADS[i] && p.baito === MAP_BAITO[j] && p.spot === spot ? "now" : ""}">${best && best.i === i && best.j === j ? "★" : ""}${v >= 0 ? "+" : ""}${Math.round(v / 10000)}</td>`).join("") + "</tr>").join("");
  box.innerHTML = `<div class="quick"><h3>🗺️ 利益マップ（営業利益・万円）</h3>
    <div class="map-help">縦＝広報費、横＝アルバイト人数。上のタブでスポット人員を切り替えます。<b>濃い緑ほど利益が高く、赤は赤字</b>です。マスを押すと、その設定を試せます。どちらへ動かすと良くなるか、探してみましょう。（製造量は、各マスで予想に合わせています。社員・オペレーション改善は今の設定のままです）</div>
    <div class="map-tabs">スポット人員：${[0, 1, 2, 3].map(s => `<button class="mt ${s === spot ? "on" : ""}" data-s="${s}">${s}人</button>`).join("")}</div>
    <div class="map-scroll"><table class="pmap"><tr><th>広報＼バイト</th>${MAP_BAITO.map(b => `<th>${b}人</th>`).join("")}</tr>${rows}</table></div>
    <div class="map-foot">枠のついたマス＝今の設定${S.showBest ? "　★＝このタブでの最良（答え合わせ）" : ""}　<button class="mini" id="bestToggle">${S.showBest ? "★を隠す" : "★ 答え合わせ（最良のマスを見る）"}</button>　<button class="mini" id="mapToggle">マップを閉じる</button></div></div>`;
}
document.addEventListener("click", e => {
  if (S.phase !== "plan") return;
  const t = e.target.closest("button, td[data-a]"); if (!t) return;
  if (t.id === "mapToggle") { S.showMap = !S.showMap; S.mapSpot = +$("spot").value; renderPlan(); }
  else if (t.id === "bestToggle") { S.showBest = !S.showBest; renderPlan(); }
  else if (t.classList.contains("mt")) { S.mapSpot = +t.dataset.s; renderPlan(); }
  else if (t.dataset.a !== undefined) { $("ads").value = t.dataset.a; $("baito").value = t.dataset.b; $("spot").value = S.mapSpot; renderPlan(); }
});

// ===== 黒字へのガイド =====
function fitProd(np) {
  const big = {}; VARIETIES.forEach(v => { big[v.id] = PROD_MAX; });
  const d = evaluate({ ...np, prod: big }, S.cond, false);
  const k = Math.min(1, d.cap / Math.max(d.demand, 1));
  const o = {}; VARIETIES.forEach(v => { o[v.id] = Math.min(PROD_MAX, Math.ceil(d.dv[v.id] * k / 50) * 50); });
  return o;
}
function candidates(p, r) {
  const list = [];
  const add = (title, patch, why, refit = true) => {
    const np = { ...p, ...patch };
    if (refit) np.prod = fitProd(np);
    const nr = evaluate(np, S.cond, false);
    list.push({ title, np, nr, why, delta: nr.profit - r.profit });
  };
  add("📐 製造量を予想に合わせる", {}, "作りすぎはロス、足りないと機会損失。需要と接客上限に合わせます");
  [1, 2].forEach(n => { if (p.baito + n <= 10) add(`🧑‍🎓 アルバイトを ${p.baito + n}人にする`, { baito: p.baito + n }, "接客上限を上げて取りこぼしを減らします（新人は研修費がかかり、今月の戦力は低め）"); });
  [1, 2].forEach(n => { if (p.baito - n >= 0) add(`🧑‍🎓 アルバイトを ${p.baito - n}人にする`, { baito: p.baito - n }, "準変動費を減らして、損益分岐点を下げます"); });
  if (p.spot < 4) add(`⚡ スポット人員を ${p.spot + 1}人にする`, { spot: p.spot + 1 }, "割高だが研修不要で、繁忙月の穴埋めに使えます");
  if (p.spot > 0) add(`⚡ スポット人員を ${p.spot - 1}人にする`, { spot: p.spot - 1 }, "割高な人員を減らします");
  [40000, 80000, 160000].forEach(s => { if (p.ads + s <= AD_MAX) add(`📣 広報を ${yen(p.ads + s)} にする`, { ads: p.ads + s }, "来店客数を増やします（準変動費）。製造量も合わせて増やします"); });
  [40000, 80000, 160000].forEach(s => { if (p.ads - s >= 0) add(`📣 広報を ${yen(p.ads - s)} にする`, { ads: p.ads - s }, "効き目の薄れた広報費を削ります"); });
  if (S.opsLevel < OPS_MAX) add(S.ops ? "🔧 オペレーション改善をやめる" : "🔧 オペレーション改善をする", { ops: !S.ops },
    `接客上限UPとロス軽減。${yen(OPS_COST)}は今月の固定費ですが、効果は来月以降も続きます（今月だけ見ると不利に見えます）`);
  VARIETIES.forEach(v => {
    [200, -200].forEach(dv => {
      const n = p.prod[v.id] + dv; if (n < 0 || n > PROD_MAX) return;
      add(`${v.icon} ${v.name}の製造を ${dv > 0 ? "+" : ""}${dv}杯（${n.toLocaleString()}杯）`, { prod: { ...p.prod, [v.id]: n } },
        dv > 0 ? `利益率${Math.round((v.price - v.cost) / v.price * 100)}%の品種。売り切れを防ぎます` : "売れ残り（ロス）を減らします", false);
    });
  });
  return list;
}
function bestPlan(p) {
  let best = null;
  for (let ads = 0; ads <= AD_MAX; ads += 80000) for (const ops of S.opsLevel < OPS_MAX ? [false, true] : [false])
    for (let baito = 0; baito <= 10; baito++) for (let spot = 0; spot <= 2; spot++) {
      const np = { ...p, ads, ops, baito, spot }; np.prod = fitProd(np);
      const nr = evaluate(np, S.cond, false);
      if (!best || nr.profit > best.nr.profit) best = { np, nr };
    }
  return best;
}
function diagnosis(r) {
  const name = { demand: "来店客数（需要）", stock: "製造量（在庫）", staff: "接客上限（人員）" }[r.limiter];
  let t = `いま販売数を止めているのは <b>${name}</b> です。`;
  if (r.limiter === "staff") t += `お客さんは${r.demand.toLocaleString()}人来るのに、接客できるのは${r.cap.toLocaleString()}人分 → <b>${r.lost.toLocaleString()}人を取りこぼし</b>、来月の需要も下がります。広報を増やしても売上は増えません。`;
  if (r.limiter === "stock") t += `${r.lost.toLocaleString()}人分の商品が足りません（売り切れ）。`;
  if (r.limiter === "demand") t += `人員や在庫には余裕があります。<b>広報で集客を伸ばす</b>か、<b>人員（準変動費）を減らす</b>余地があります。`;
  if (r.lossQty >= r.prod * 0.1 && r.lossQty > 100) t += ` 作りすぎで<b>${r.lossQty.toLocaleString()}杯がロス</b>になります。`;
  return t;
}
let bestTimer = null;
function renderGuide(p, r) {
  const ok = r.margin >= r.allFixed;
  const bep = r.bepQty, sold = r.sold;
  const pc = isFinite(bep) ? Math.min(100, sold / bep * 100) : 0;
  const head = ok
    ? `<div class="g-head ok">✅ この設定なら黒字の見込み（${yen(r.profit)}）。さらに伸ばせる余地があるか見てみましょう。</div>`
    : `<div class="g-head ng">❌ このままだと赤字の見込み（${yen(r.profit)}）。黒字には<b>${isFinite(bep) ? bep.toLocaleString() : "—"}杯</b>売る必要があります。</div>`;
  const gauge = `<div class="g-gauge"><div class="g-fill ${ok ? "ok" : ""}" style="width:${pc}%"></div></div>
    <div class="g-gauge-t">見込み販売数 <b>${sold.toLocaleString()}杯</b> ／ 損益分岐点 <b>${isFinite(bep) ? bep.toLocaleString() + "杯" : "∞"}</b>（固定費＋準変動費 ${yen(r.allFixed)} ÷ 1杯あたり平均の限界利益 ${yen(r.unit)}）</div>`;
  const cands = candidates(p, r).filter(c => c.delta >= 3000).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const sg = v => (v >= 0 ? "+" : "") + yen(v);
  const steps = cands.length ? cands.map((c, i) => `<div class="g-item"><div class="g-t">${i + 1}. ${c.title} <span class="g-d">利益 ${sg(c.delta)}</span></div>
      <div class="g-w">${c.why}</div>
      <div class="g-m">販売 ${r.sold.toLocaleString()}→${c.nr.sold.toLocaleString()}杯 ／ 限界利益 ${sg(c.nr.margin - r.margin)} ／ 固定費+準変動費 ${sg(c.nr.allFixed - r.allFixed)}</div>
      <button class="mini apply" data-i="${i}">👉 これを適用</button></div>`).join("")
    : `<div class="g-item">今の設定は、ひとつ動かす範囲ではこれ以上良くなりません。${ok ? "ほぼ最適です 🎉" : "（下の「まとめて見直す」も見てみましょう。）"}</div>`;
  $("guide").innerHTML = `<div class="guide"><h3>💡 黒字へのガイド</h3>${head}${gauge}
    <div class="g-diag">🔍 ${diagnosis(r)}</div>
    <div class="g-rule">📘 考え方：<b>限界利益の増加 ＞ 固定費＋準変動費の増加</b> なら、その打ち手は儲かります。閑散期は<b>準変動費（アルバイト・広報）を絞って損益分岐点を下げる</b>、繁忙期は<b>増やして取りこぼしを防ぐ</b>のが基本です。社員（固定費）は減らせません。</div>
    <div class="g-title">おすすめの打ち手（効果の大きい順）</div>${steps}<div id="bestBox"></div></div>`;
  window.__cands = cands;
  clearTimeout(bestTimer);
  bestTimer = setTimeout(() => {          // 重い探索は入力が止まってから
    const b = bestPlan(p); window.__best = b;
    const box = $("bestBox"); if (!box) return;
    const hard = b.nr.profit < 0 ? `<div class="g-item">⚠️ どの組み合わせでも赤字になる厳しい月です（閑散期など）。<b>赤字を最小限に抑える</b>のも立派な経営判断です。</div>` : "";
    box.innerHTML = (b.nr.profit - r.profit >= 3000 ? `<div class="g-title">🎯 まとめて見直すなら（目安）</div><div class="g-item"><div class="g-t">利益 ${yen(r.profit)} → <b>${yen(b.nr.profit)}</b></div>
      <div class="g-m">アルバイト ${b.np.baito}人／スポット ${b.np.spot}人／広報 ${yen(b.np.ads)}${b.np.ops ? "／オペレーション改善" : ""}／製造 ${VARIETIES.map(v => `${v.icon}${b.np.prod[v.id].toLocaleString()}`).join(" ")}</div>
      <div class="g-w">ひとつずつ動かしても良くならない時は、人員と広報と製造量をセットで動かすと黒字になることがあります。</div>
      <button class="mini apply" data-i="best">👉 この作戦を適用</button></div>` : "") + hard;
  }, 250);
}
document.addEventListener("click", e => {
  const b = e.target.closest(".apply"); if (!b || S.phase !== "plan") return;
  const np = b.dataset.i === "best" ? window.__best.np : window.__cands[+b.dataset.i].np;
  $("ads").value = np.ads; $("baito").value = np.baito; $("spot").value = np.spot; $("regular").value = np.regular;
  S.prod = { ...np.prod }; S.ops = np.ops;
  renderPlan();
});
function reviewHTML(f, r, c) {
  const t = [];
  if (r.lost > 0) t.push(`🧑‍🍳 <b>取りこぼし ${r.lost.toLocaleString()}人</b>：${r.limiter === "staff" ? "接客上限を超えました。繁忙期は人員（アルバイト・スポット）を増やすか、オペレーション改善で上限を上げましょう" : "商品が売り切れました。製造量を増やしましょう"}。来月の需要にも響きます。`);
  VARIETIES.forEach(v => { if (r.loss[v.id] >= Math.max(100, r.pv[v.id] * 0.1)) t.push(`🗑️ ${v.icon}${v.name}が <b>${r.loss[v.id].toLocaleString()}杯ロス</b>（材料費 ${yen(r.loss[v.id] * v.cost)}の無駄）。`); });
  if (Math.abs(r.demand - f.demand) / Math.max(f.demand, 1) > 0.12) t.push(`🌦️ 予想より来店客数が <b>${r.demand > f.demand ? "上振れ" : "下振れ"}</b>（${f.demand.toLocaleString()}→${r.demand.toLocaleString()}人）。天候（${c.label}）の影響です。予報のズレは起きるものと考えて、余裕を持たせましょう。`);
  if (r.cap > r.demand * 1.5 && r.baito + r.spot > 0) t.push(`💸 人員に余裕がありすぎます（接客上限 ${r.cap.toLocaleString()}杯 ／ 来店 ${r.demand.toLocaleString()}人）。準変動費のアルバイトを減らせば、損益分岐点が下がります。`);
  if (r.margin < r.allFixed) t.push(`📉 限界利益 ${yen(r.margin)} が固定費＋準変動費 ${yen(r.allFixed)} に届きませんでした。<b>売る数を増やす</b>か<b>準変動費を絞る</b>かを考えましょう。`);
  else t.push(`👍 限界利益が固定費＋準変動費を ${yen(r.margin - r.allFixed)} 上回りました。経営安全率は ${Math.round(r.safety * 100)}% です。`);
  return `<div class="guide"><h3>📝 今月のふりかえり</h3><ul>${t.map(x => `<li>${x}</li>`).join("")}</ul></div>`;
}

// ===== ハプニング表示・戦略選択 =====
const STRATEGIES = [
  { id: "attack", icon: "🔥", name: "攻める", desc: "広報と人員を厚くして、売上を最大化する" },
  { id: "defend", icon: "🛡️", name: "守る", desc: "準変動費を絞って、損益分岐点を下げる" },
  { id: "margin", icon: "💎", name: "利益率重視", desc: "プレミアムを軸に、1杯の利益を高める" },
  { id: "safe", icon: "🧯", name: "安全第一", desc: "欠品・ロス・取りこぼしを避け、余裕を持つ" },
];
const REASONS = ["予報が高めだから", "繁忙期だから", "閑散期だから", "資金に余裕がないから", "資金に余裕があるから",
  "先月ロスが多かった", "先月取りこぼしがあった", "ハプニングが心配", "広報の効果を試したい"];
function renderStrategy() {
  $("stratList").innerHTML = STRATEGIES.map(s => `<button class="sc ${S.strategy === s.id ? "on" : ""}" data-st="${s.id}"><b>${s.icon} ${s.name}</b><small>${s.desc}</small></button>`).join("");
  $("reasonList").innerHTML = `<div class="chips-h">理由（当てはまるものを選んでください・複数可）</div>` +
    REASONS.map(t => `<button class="chip2 ${S.reasons.includes(t) ? "on" : ""}" data-rs="${t}">${t}</button>`).join("");
}
function renderEvents(p, r) {
  const c = S.cond, parts = [];
  if (c.known) parts.push(`<div class="ev known"><b>${c.known.icon} ${c.known.name}</b> <em>予告・確定</em><div>${c.known.text}（${effText(c.known.eff)}）。予想にはすでに反映されています。</div></div>`);
  c.risks.forEach(k => {
    const alt = evaluate(p, c, { extra: k.ev.eff }), d = alt.profit - r.profit;
    parts.push(`<div class="ev risk"><b>${k.ev.icon} ${k.ev.name}のリスク</b> <em>発生確率 ${Math.round(k.p * 100)}%</em><div>${k.ev.text}（${effText(k.ev.eff)}）。予想にはまだ入っていません。<br>もし起きたら：営業利益 ${yen(r.profit)} → <b>${yen(alt.profit)}</b>（${d >= 0 ? "+" : ""}${yen(d)}）</div></div>`);
  });
  if (HAP[S.hap] > 0) parts.push(`<div class="ev sudden"><b>❓ 突発のできごと</b><div>アルバイトの欠員、マシン故障、食材の高騰、メディア紹介など。何が起こるかは、営業してみるまで分かりません。備え（スポット人員・資金の余裕・在庫や人員の余裕）を考えておきましょう。</div></div>`);
  $("events").innerHTML = parts.length ? `<div class="evbox"><h3>⚠️ 今月の気になる情報（ハプニング）</h3>${parts.join("")}</div>` : "";
}
function evresHTML(c) {
  const li = [];
  if (c.known) li.push(`<li>${c.known.icon} <b>${c.known.name}</b>（予告）：${c.known.text}</li>`);
  c.risks.forEach(k => li.push(k.realized ? `<li class="bad">${k.ev.icon} <b>${k.ev.name}が発生しました！</b>（確率 ${Math.round(k.p * 100)}%）：${k.ev.text}</li>` : `<li class="mute">${k.ev.icon} ${k.ev.name}は、今月は起きませんでした（確率 ${Math.round(k.p * 100)}%）</li>`));
  if (c.sudden) li.push(`<li class="bad">${c.sudden.icon} <b>突発：${c.sudden.name}</b>：${c.sudden.text}</li>`);
  else if (HAP[S.hap] > 0) li.push(`<li class="mute">突発のできごとは、ありませんでした</li>`);
  return li.length ? `<div class="guide"><h3>⚡ 今月のハプニング</h3><ul class="evres">${li.join("")}</ul></div>` : "";
}
function gapHTML(f, e1, e2, e3, r, best) {
  const row = (n, v, cls = "") => `<tr class="${cls}"><td>${n}</td><td class="${v < 0 ? "neg" : ""}">${yen(v)}</td></tr>`;
  const sg = v => (v >= 0 ? "+" : "") + yen(v);
  return `<div class="guide"><h3>🔍 予想と実績の差は、なぜ生まれた？</h3><table class="pl">
    ${row("予想の営業利益（あなたの設定どおりなら）", f.profit, "sub")}${row("　天候のブレ（予報とのズレ）", e1.profit - f.profit)}${row("　天候リスク（台風・長雨など）", e2.profit - e1.profit)}
    ${row("　突発のできごと", e3.profit - e2.profit)}${row("　客足のブレ（その他）", r.profit - e3.profit)}${row("実績の営業利益", r.profit, "sub")}</table>
    <div class="g-diag">🎲 <b>運の影響は合計 ${sg(r.profit - f.profit)}</b>。一方、<b>判断の質</b>は「予想の利益 ${yen(f.profit)}」に表れます。予想ベースで最良の設定なら ${yen(best)} でした（${best - f.profit >= 3000 ? "あなたの設定では、約 <b>" + yen(best - f.profit) + "</b> の伸びしろが残っていました" : "ほぼ最良の設定でした"}）。<br>
    結果が悪くても、判断が悪かったとは限りません。運と判断を分けて振り返りましょう。</div></div>`;
}
function strategyReviewHTML(id, r) {
  const st = STRATEGIES.find(s => s.id === id), pc = x => Math.round(x * 100) + "%";
  const util = r.cap > 0 ? r.demand / r.cap : 0, lostR = r.lost / Math.max(r.demand, 1), lossR = r.lossQty / Math.max(r.prod, 1);
  const pr = VARIETIES[0].id; let facts = [], ok = false, msg = "";
  if (id === "attack") {
    facts = [`広報費 ${yen(r.ads)}（需要 ×${adFactor(r.ads).toFixed(2)}）`, `来店 ${r.demand.toLocaleString()}人 → 販売 ${r.sold.toLocaleString()}杯（取りこぼし ${r.lost.toLocaleString()}人）`, `人員の稼働率 ${pc(util)}`];
    ok = r.ads > 0 && lostR < 0.1; msg = ok ? "広報で集客を伸ばし、しっかり受け止められました。" : r.ads === 0 ? "広報を使っていないので、「攻める」設定にはなっていませんでした。" : "集客に対して人員や在庫が足りず、取りこぼしました。";
  } else if (id === "defend") {
    facts = [`準変動費 ${yen(r.semiCost)}（売上の ${pc(r.sales ? r.semiCost / r.sales : 0)}）`, `損益分岐点売上高 ${isFinite(r.bepSales) ? yen(r.bepSales) : "—"}`, `経営安全率 ${pc(r.safety)}`, `人員の稼働率 ${pc(util)}`];
    ok = r.safety >= 0.1 && util >= 0.85; msg = ok ? "準変動費を抑えながら、需要を受け止められました。" : util < 0.85 ? "人員に余裕が残っていました。準変動費を、もっと絞る余地があります。" : "経営安全率が低く、損益分岐点に近い状態でした。";
  } else if (id === "margin") {
    facts = [`${VARIETIES[0].icon}${VARIETIES[0].name}：需要 ${r.dv[pr].toLocaleString()} ／ 製造 ${r.pv[pr].toLocaleString()} ／ 販売 ${r.sv[pr].toLocaleString()}（ロス ${r.loss[pr].toLocaleString()}）`, `限界利益率 ${pc(r.marginRate)}`];
    ok = r.pv[pr] >= r.dv[pr] && r.loss[pr] <= r.pv[pr] * 0.1; msg = ok ? "利益率の高いプレミアムを、切らさず・余らせず売れました。" : r.pv[pr] < r.dv[pr] ? "プレミアムが売り切れ、利益率の高い機会を逃しました。" : "プレミアムを作りすぎて、ロスが出ました。";
  } else {
    facts = [`取りこぼし ${r.lost.toLocaleString()}人（${pc(lostR)}）`, `ロス ${r.lossQty.toLocaleString()}杯（${pc(lossR)}）`, `経営安全率 ${pc(r.safety)}`];
    ok = lostR < 0.03 && lossR <= 0.1; msg = ok ? "取りこぼしもロスも少なく、余裕を持って営業できました。" : lostR >= 0.03 ? "取りこぼしがありました。余裕が足りませんでした。" : "ロスが多く、余裕を持たせすぎました。";
  }
  return `<div class="guide"><h3>🎯 戦略の振り返り：${st.icon} ${st.name}</h3>
    <div class="g-w">選んだ理由：${S.reasons.length ? S.reasons.join("／") : "（選択なし）"}${S.memo ? "　メモ：「" + S.memo + "」" : ""}</div>
    <ul>${facts.map(x => `<li>${x}</li>`).join("")}</ul>
    <div class="sr ${ok ? "ok" : "ng"}">${ok ? "✅ 狙いどおり" : "△ 狙いとズレがありました"}：${msg}</div>
    <div class="g-w">※ 点数ではありません。狙いと実際を見比べるための材料です。</div></div>`;
}
document.addEventListener("click", e => {
  if (S.phase !== "plan") return;
  const sc = e.target.closest(".sc"), ch = e.target.closest(".chip2");
  if (sc) { S.strategy = sc.dataset.st; renderPlan(); }
  else if (ch) { const t = ch.dataset.rs; S.reasons = S.reasons.includes(t) ? S.reasons.filter(x => x !== t) : [...S.reasons, t]; renderPlan(); }
});

// ===== 営業開始 =====
function openShop() {
  const p = plan(), c = S.cond;
  const f = evaluate(p, c, false), r = evaluate(p, c, true);
  const e1 = evaluate(p, c, { weather: 1 }), e2 = evaluate(p, c, { weather: 1, risks: 1 }), e3 = evaluate(p, c, { weather: 1, risks: 1, sudden: 1 });
  const np0 = { ...p, ads: 0 }; np0.prod = fitProd(np0); const r0 = evaluate(np0, c, true);
  const roi = p.ads > 0 ? (r.margin - r0.margin) / p.ads : 0;
  const bestProfit = Math.max(bestPlan(p).nr.profit, f.profit);
  const st = STRATEGIES.find(s => s.id === S.strategy);
  const stratHTML = strategyReviewHTML(S.strategy, r);
  S.opsLevel = r.lvl; S.regular = p.regular; S.lastBaito = p.baito;
  S.wageMul *= c.effKnown.wageMul; S.carry = c.newCarry;
  let penaltyMsg = "";
  if (r.lost / Math.max(r.demand, 1) > 0.12) {
    S.penalty = p.ads > 0 ? 0.85 : 0.92;
    penaltyMsg = `行列クレーム発生！${r.lost.toLocaleString()}人を取り逃がし、来月の需要が下がります`;
  } else S.penalty = Math.min(1, S.penalty + 0.05);
  S.cash += r.profit;
  const evNames = [c.known && c.known.icon + c.known.name, ...c.risks.filter(k => k.realized).map(k => k.ev.icon + k.ev.name), c.sudden && c.sudden.icon + c.sudden.name].filter(Boolean);
  S.history.push({ turn: S.turn, m: c.m, profit: r.profit, margin: r.margin, allFixed: r.allFixed, fixedCost: r.fixedCost, semiCost: r.semiCost,
    staffCost: r.staffCost, power: r.power, loss: r.lossQty, sales: r.sales, demand: r.demand,
    strategy: st.icon + st.name, reasons: [...S.reasons], memo: S.memo, fProfit: f.profit, bestProfit, luck: r.profit - f.profit, events: evNames });
  S.phase = "result";
  const ok = r.margin >= r.allFixed;
  $("report").innerHTML =
    `<div class="verdict ${ok ? "ok" : "ng"}">${ok ? `🎉 損益分岐点を超えました！ 黒字 ${yen(r.profit)}` : `😢 損益分岐点に届きませんでした… 赤字 ${yen(r.profit)}`}
      ${penaltyMsg ? `<br>⚠️ ${penaltyMsg}` : ""}${r.lossQty > 0 ? `<br>🗑️ ロス ${r.lossQty.toLocaleString()}杯 を廃棄しました` : ""}<br>💰 月末の資金 ${yen(S.cash)}</div>` +
    evresHTML(c) + gapHTML(f, e1, e2, e3, r, bestProfit) + stratHTML +
    `<table class="vs"><tr><th></th><th>予想</th><th>実際</th></tr>
      <tr><td>天候</td><td>${fLabel(c.fF)}（${c.fF >= 1 ? "+" : ""}${Math.round((c.fF - 1) * 100)}%）</td><td>${c.label}（${c.trueF >= 1 ? "+" : ""}${Math.round((c.trueF - 1) * 100)}%）</td></tr>
      <tr><td>来店客数</td><td>${f.demand.toLocaleString()}人</td><td><b>${r.demand.toLocaleString()}人</b></td></tr>
      <tr><td>販売数</td><td>${f.sold.toLocaleString()}杯</td><td><b>${r.sold.toLocaleString()}杯</b></td></tr>
      <tr><td>営業利益</td><td>${yen(f.profit)}</td><td><b>${yen(r.profit)}</b></td></tr></table>` +
    reviewHTML(f, r, c) + balanceHTML(r, roi, p.ads > 0) + kpiHTML(r) + `<h3>🎯 損益分岐点メーター</h3>` + meterHTML(r, true) + bepInfoHTML(r) +
    `<h3>🍨 品種別の結果</h3>` + varTableHTML(r) +
    `<h3>🍦 何がボトルネック？</h3>` + barsHTML(r) + `<h3>🧾 損益計算書（P&amp;L）</h3>` + plHTML(r);
  $("nextBtn").textContent = S.cash < 0 ? "💥 結果を見る" : S.turn >= MAX_TURN ? "🏁 年間の結果発表へ" : "▶ 翌月へ";
  showPhase(); renderHeader(); renderHist();
}
function nextDay() {
  if (S.cash < 0 || S.turn >= MAX_TURN) return showFinal();
  S.turn++; S.ops = false; S.showBest = false; S.strategy = null; S.reasons = []; S.memo = ""; $("memo").value = ""; S.cond = makeCond(S.turn); S.phase = "plan";
  showPhase(); renderHeader(); renderPlan();
}
function showPhase() {
  $("planView").hidden = S.phase !== "plan";
  $("resultView").hidden = S.phase !== "result";
  $("finalView").hidden = S.phase !== "final";
  document.querySelectorAll("#decide input,#decide button").forEach(e => { e.disabled = S.phase !== "plan"; });
  if (S.phase === "plan") { renderPlan(); if (S.opsLevel >= OPS_MAX) $("opsBtn").disabled = true; }
}
function showFinal() {
  S.phase = "final";
  const h = S.history, total = S.cash - START_CASH;
  const black = h.filter(x => x.profit >= 0).length, loss = h.reduce((a, x) => a + x.loss, 0);
  const rank = S.cash < 0 ? "D" : total >= 3000000 ? "S" : total >= 2000000 ? "A" : total >= 1000000 ? "B" : total >= 0 ? "C" : "D";
  const staffActual = h.reduce((a, x) => a + x.staffCost, 0);
  const peak = Math.max(...h.map(x => x.power), 0);
  const allReg = Math.ceil(peak) * WAGE_REG * h.length;      // ピークに合わせて全員を社員にした場合
  const worst = h.reduce((a, x) => (x.profit < a.profit ? x : a), h[0]), best = h.reduce((a, x) => (x.profit > a.profit ? x : a), h[0]);
  $("finalView").innerHTML = `<h2>🏆 年間の結果発表</h2>
    <div class="verdict ${total >= 0 && S.cash >= 0 ? "ok" : "ng"}">${S.cash < 0 ? "💥 資金ショート！ 閑散期を耐えられませんでした。<br>" : ""}ランク <span class="rank">${rank}</span>　最終資金 ${yen(S.cash)}（${total >= 0 ? "+" : ""}${yen(total)}）</div>
    <div class="kpis"><div class="kpi"><span>黒字の月</span><b>${black} / ${h.length}か月</b></div><div class="kpi"><span>ロス合計</span><b>${loss.toLocaleString()}杯</b></div>
    <div class="kpi"><span>年間の営業利益</span><b>${yen(total)}</b></div></div>
    <div class="guide"><h3>👥 人員コストの比較：準変動費化の効果</h3>
      <table class="vs"><tr><td>あなたの人員コスト（社員＋アルバイト＋スポット＋研修）</td><td><b>${yen(staffActual)}</b></td></tr>
      <tr><td>ピーク（戦力 ${peak.toFixed(1)}人分）に合わせ、全員を社員にした場合</td><td>${yen(allReg)}</td></tr>
      <tr><td>準変動費化による差額</td><td><b class="${allReg - staffActual >= 0 ? "pos" : "neg"}">${yen(allReg - staffActual)}</b></td></tr></table>
      <ul><li>最も良かった月：${best.m}月（${yen(best.profit)}）／最も悪かった月：${worst.m}月（${yen(worst.profit)}）</li>
      <li>固定費は売上がなくても毎月かかります。繁忙期だけ人員を足し、閑散期に絞る「準変動費化」が、年間の損益分岐点を下げます。</li></ul></div>
    <div class="guide"><h3>📒 判断ログ（毎月の戦略・理由・結果）</h3><div class="map-scroll"><table class="vs vt qt logt"><tr><th>月</th><th>戦略</th><th>理由・メモ</th><th>予想利益</th><th>運の影響</th><th>実績</th><th>ハプニング</th></tr>
      ${h.map(x => `<tr><td>${x.m}月</td><td>${x.strategy}</td><td class="lt">${x.reasons.join("／") || "—"}${x.memo ? "<br>「" + x.memo + "」" : ""}</td><td>${yen(x.fProfit)}</td>
      <td class="${x.luck >= 0 ? "pos" : "neg"}">${(x.luck >= 0 ? "+" : "") + yen(x.luck)}</td><td><b>${yen(x.profit)}</b></td><td class="lt">${x.events.join("／") || "—"}</td></tr>`).join("")}</table></div>
      <ul><li>運の影響の合計：<b>${yen(h.reduce((a, x) => a + x.luck, 0))}</b>　／　判断の伸びしろ（最良設定との差）の合計：<b>${yen(h.reduce((a, x) => a + Math.max(0, x.bestProfit - x.fProfit), 0))}</b></li>
      <li>結果が悪かった月も、「判断」と「運」に分けて見ると、次に直すべき点が分かります。</li></ul></div>
    <button class="go next" onclick="location.reload()">🔁 もう一度あそぶ</button>`;
  showPhase();
}

// ===== イベント =====
["ads", "regular", "baito", "spot"].forEach(id => $(id).addEventListener("input", renderPlan));
$("opsBtn").onclick = () => { S.ops = !S.ops; renderPlan(); };
$("fitBtn").onclick = () => { S.prod = fitProd(plan()); renderPlan(); };
$("goBtn").onclick = openShop;
$("memo").addEventListener("input", e => { S.memo = e.target.value; });
$("hap").addEventListener("change", e => { S.hap = e.target.value; if (S.phase === "plan") { S.cond = makeCond(S.turn); renderHeader(); renderPlan(); } });
$("nextBtn").onclick = nextDay;
S.cond = makeCond(1);
renderHeader(); showPhase(); renderHist();
