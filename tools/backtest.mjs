// Tests the model on real past elections. Each election is tested with settings fitted
// only on the other elections, and with state leans from before it.
// Known leaks: demographics are from 2023, and the mood formula's constants were chosen
// by a person who knew these three results. Three elections is very little evidence.
// Run: node tools/backtest.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { simulate } from "../public/sim.js";
import { buildMap, finishParams, stateLoadings } from "../collect/states_model.mjs";
import { fundamentals, PAST_CASES } from "../collect/mood.mjs";

const { national, contests } = JSON.parse(readFileSync("data/states.json", "utf8"));
const YEARS = [2008, 2012, 2016, 2020, 2024];
const TESTS = [2016, 2020, 2024];
const TURBULENCE_DF = 4;
const DISTRICT_EXTRA = 3.5;
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

const STATE_IDS = contests.filter((c) => !c.district && c.id !== "DC").map((c) => c.id);

function stateErrors(lean, year) {
  const map = buildMap(contests, national, YEARS.filter((y) => y < year), { ...lean, factors: 1, kernelWidth: 1, regionShare: 0.35 });
  const byId = new Map(map.contests.map((c) => [c.id, c]));
  return STATE_IDS.map((id) => contests.find((x) => x.id === id).results[year] - (byId.get(id).base + national[year] - map.nRef));
}

// ---------- which way of reading a state's past predicts best? ----------

const LEANS = [];
for (const leanWeights of [[1, 0, 0], [0.7, 0.3, 0], [0.6, 0.3, 0.1], [0.5, 0.3, 0.2]]) {
  for (const trend of [0, 0.15, 0.25, 0.4]) LEANS.push({ leanWeights, trend });
}
const leanScore = (lean, years) => years.reduce((s, y) => s + rms(stateErrors(lean, y)), 0) / years.length;
const bestLean = (years) => [...LEANS].sort((a, b) => leanScore(a, years) - leanScore(b, years))[0];

// ---------- how strongly do similar states move together? ----------

function logLikelihood(residual, load, share) {
  // Multivariate normal on unit-spread errors, by Cholesky: shared*LL' + own*I.
  const n = residual.length;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let c = 0;
      for (let k = 0; k < load[i].length; k++) c += load[i][k] * load[j][k];
      A[i][j] = share * c + (i === j ? 1 - share : 0);
    }
  }
  let logDet = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= A[i][k] * A[j][k];
      if (i === j) {
        A[i][i] = Math.sqrt(s);
        logDet += 2 * Math.log(A[i][i]);
      } else {
        A[i][j] = s / A[j][j];
      }
    }
  }
  const y = new Float64Array(n);
  let q = 0;
  for (let i = 0; i < n; i++) {
    let s = residual[i];
    for (let k = 0; k < i; k++) s -= A[i][k] * y[k];
    y[i] = s / A[i][i];
    q += y[i] * y[i];
  }
  return -0.5 * (logDet + q);
}

// Errors scaled by that year's own size, so 2016 sets the pattern's weight, not its size.
function scaledResiduals(lean, year) {
  const e = stateErrors(lean, year);
  const mid = e.reduce((a, b) => a + b, 0) / e.length;
  const r = e.map((x) => x - mid);
  const s = rms(r);
  return r.map((x) => x / s);
}

const LINKS = [];
for (const factors of [4, 6, 8, 12]) {
  for (const kernelWidth of [0.5, 0.7, 1]) {
    for (const regionShare of [0.15, 0.35, 0.6]) LINKS.push({ factors, kernelWidth, regionShare });
  }
}
const SHARES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const loadCache = new Map();
function loadsFor(link) {
  const key = JSON.stringify(link);
  if (!loadCache.has(key)) {
    const m = stateLoadings(contests, link);
    loadCache.set(key, STATE_IDS.map((id) => m.get(id)));
  }
  return loadCache.get(key);
}

function bestLink(lean, years) {
  const residuals = years.map((y) => scaledResiduals(lean, y));
  let best = null;
  for (const link of LINKS) {
    for (const share of SHARES) {
      const ll = residuals.reduce((s, r) => s + logLikelihood(r, loadsFor(link), share), 0);
      if (!best || ll > best.ll) best = { link, share, ll };
    }
  }
  return best;
}

function fitOn(years) {
  const lean = bestLean(years);
  const { link, share } = bestLink(lean, years);
  const errors = years.flatMap((y) => stateErrors(lean, y));
  const total = rms(errors);
  return {
    cfg: { ...lean, ...link },
    sharedShare: share,
    totalStray: total,
    stray: { sharedStray: total * Math.sqrt(share), ownStray: total * Math.sqrt(1 - share), districtExtra: DISTRICT_EXTRA },
  };
}

console.log("STATE LINKS: score on the held-out year, higher is better");
const OLD_SHARE = 0.23;
const OLD_LINK = { factors: 6, kernelWidth: 1, regionShare: 0.35 };
for (const y of TESTS) {
  const train = TESTS.filter((t) => t !== y);
  const lean = bestLean(train);
  const chosen = bestLink(lean, train);
  const r = scaledResiduals(lean, y);
  const none = r.reduce((s, x) => s - 0.5 * x * x, 0);
  console.log(` ${y}: fitted ${JSON.stringify(chosen.link)} share ${chosen.share} -> ${logLikelihood(r, loadsFor(chosen.link), chosen.share).toFixed(1)} | old setting ${logLikelihood(r, loadsFor(OLD_LINK), OLD_SHARE).toFixed(1)} | no links ${none.toFixed(1)}`);
}

// ---------- the real candidates ----------

const DRAWS = 100000;

function runCase(c, stage, fit, options = {}) {
  const asOf = YEARS.filter((y) => y < c.year);
  const params = finishParams(buildMap(contests, national, asOf, fit.cfg), fit.stray);
  params.nationalMean = stage === "final" ? c.finalPolls : fundamentals(national, asOf, c);
  params.nationalSd = stage === "final" ? 3 : 5.5;
  params.nationalDf = 5;
  params.candidateSd = stage === "final" ? 0.5 : 2;
  params.turbulenceDf = options.turbulenceDf ?? TURBULENCE_DF;
  if (options.home !== false) {
    for (const pc of params.contests) {
      if (c.demHome?.includes(pc.parentId)) pc.base += 2;
      if (c.repHome?.includes(pc.parentId)) pc.base -= 2;
    }
  }
  const out = simulate(params, DRAWS, 12345 + c.year);
  const truth = new Map(contests.map((x) => [x.id, x.results[c.year]]));
  const states = out.states.filter((s) => truth.get(s.id) != null);
  const wrong = states.filter((s) => (s.demWin > 0.5) !== (truth.get(s.id) > 0)).map((s) => s.id);
  const brier = states.reduce((a, s) => a + (s.demWin - (truth.get(s.id) > 0 ? 1 : 0)) ** 2, 0) / states.length;
  const inside = states.filter((s) => Math.abs(truth.get(s.id) - s.margin) <= 1.2816 * s.sd).length / states.length;
  const errs = states.filter((s) => !s.id.includes("-") && s.id !== "DC").map((s) => truth.get(s.id) - s.margin);
  return { out, mood: params.nationalMean, wrong, brier, inside, rmse: rms(errs) };
}

console.log("\nREAL CANDIDATES: settings fitted without the year being tested");
for (const stage of ["two years out", "final"]) {
  console.log(`\n-- ${stage === "final" ? "final weeks, using the final national polling average" : "two years out, using earlier results, the midterm and approval"}`);
  for (const c of PAST_CASES) {
    const fit = fitOn(TESTS.filter((t) => t !== c.year));
    const r = runCase(c, stage, fit);
    const inRange = c.actualEv >= r.out.evLow && c.actualEv <= r.out.evHigh;
    console.log(`${c.year} ${c.dem} vs ${c.rep}: mood D${r.mood >= 0 ? "+" : ""}${r.mood.toFixed(1)} (actual ${national[c.year]}) | ${c.dem} ${(100 * r.out.demWin).toFixed(1)}%, ${c.rep} ${(100 * r.out.repWin).toFixed(1)}% | EV ${r.out.evMedian} [${r.out.evLow}-${r.out.evHigh}] actual ${c.actualEv} ${inRange ? "inside" : "OUTSIDE"} | share ${fit.sharedShare} stray ${fit.totalStray.toFixed(1)}`);
    console.log(`     contests wrong ${r.wrong.length}/56: ${r.wrong.join(" ")} | state error ${r.rmse.toFixed(1)} | inside 80% range ${(100 * r.inside).toFixed(0)}% | Brier ${r.brier.toFixed(3)}`);
  }
}

console.log("\n-- the mood formula against simple rules (not held out: its constants were chosen knowing these results)");
for (const c of PAST_CASES) {
  const asOf = YEARS.filter((y) => y < c.year);
  const last = national[asOf.at(-1)];
  const avg = asOf.reduce((s, y) => s + national[y], 0) / asOf.length;
  console.log(` ${c.year}: formula ${fundamentals(national, asOf, c).toFixed(1)}, last election ${last}, average so far ${avg.toFixed(1)}, actual ${national[c.year]}`);
}

console.log("\n-- does the home-state piece help? final-weeks state error with and without");
for (const c of PAST_CASES) {
  const fit = fitOn(TESTS.filter((t) => t !== c.year));
  console.log(` ${c.year}: with ${runCase(c, "final", fit).rmse.toFixed(2)}, without ${runCase(c, "final", fit, { home: false }).rmse.toFixed(2)}`);
}

const final = fitOn(TESTS);
writeFileSync("data/state_fit.json", JSON.stringify({ ...final, turbulenceDf: TURBULENCE_DF, built: new Date().toISOString() }, null, 1) + "\n");
const check = stateLoadings(contests, final.cfg);
const corr = (a, b) => check.get(a).reduce((s, x, i) => s + x * check.get(b)[i], 0) * final.sharedShare;
console.log(`\nFINAL fit on all three: ${JSON.stringify(final.cfg)} share ${final.sharedShare} stray ${final.totalStray.toFixed(2)}`);
console.log(" state links now:", [["PA", "MI"], ["PA", "WI"], ["MI", "WI"], ["IA", "OH"], ["GA", "NC"], ["AZ", "NV"], ["PA", "TX"], ["PA", "CA"]].map(([a, b]) => `${a}-${b} ${corr(a, b).toFixed(2)}`).join(", "));
