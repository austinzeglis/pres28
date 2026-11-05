// Tests the model on real past elections, using only what was known beforehand.
// Part 1 fits the state pieces. Part 2 runs the actual candidates through the simulator.
// Run: node tools/backtest.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { simulate } from "../public/sim.js";
import { buildMap, factorVectors, finishParams } from "../collect/states_model.mjs";
import { fundamentals, PAST_CASES } from "../collect/mood.mjs";

const data = JSON.parse(readFileSync("data/states.json", "utf8"));
const { national, contests } = data;
const YEARS = [2008, 2012, 2016, 2020, 2024];
const TESTS = [2016, 2020, 2024];
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

const base = { factors: 6, kernelWidth: 1, regionShare: 0.35 };

function errors(cfg, year) {
  const asOf = YEARS.filter((y) => y < year);
  const map = buildMap(contests, national, asOf, cfg);
  return map.contests
    .filter((c) => !c.district && c.id !== "DC")
    .map((c) => {
      const pred = c.base + c.elasticity * (national[year] - map.nRef);
      const actual = contests.find((x) => x.id === c.id).results[year];
      return { id: c.id, err: actual - pred, actual, pred };
    });
}

// ---------- Part 1: how should a state's past predict its future? ----------

const grid = [];
for (const leanWeights of [[1, 0, 0], [0.7, 0.3, 0], [0.6, 0.3, 0.1], [0.5, 0.3, 0.2]]) {
  for (const trend of [0, 0.15, 0.25, 0.4, 0.6]) {
    for (const elasticityKeep of [0, 0.25, 0.5, 0.75]) {
      for (const demoDrift of [0, 0.25, 0.5, 0.75, 1]) grid.push({ ...base, leanWeights, trend, elasticityKeep, demoDrift });
    }
  }
}
const scored = grid.map((cfg) => {
  const byYear = TESTS.map((y) => rms(errors(cfg, y).map((e) => e.err)));
  return { cfg, byYear, avg: byYear.reduce((a, b) => a + b, 0) / byYear.length };
}).sort((a, b) => a.avg - b.avg);
const best = scored[0].cfg;
console.log("PART 1: state pieces, predicting each state given the true national margin");
console.log(` best: weights ${best.leanWeights} trend ${best.trend} elasticity keep ${best.elasticityKeep} demographic drift ${best.demoDrift}`);
console.log(` error by year ${TESTS.map((y, i) => `${y} ${scored[0].byYear[i].toFixed(2)}`).join(", ")} | avg ${scored[0].avg.toFixed(2)}`);
const plain = { ...base, leanWeights: [1, 0, 0], trend: 0, elasticityKeep: 0 };
const plainErr = TESTS.map((y) => rms(errors(plain, y).map((e) => e.err)));
console.log(` naive "same lean as last time": ${TESTS.map((y, i) => `${y} ${plainErr[i].toFixed(2)}`).join(", ")}`);

// How far states stray, and how much of it similar states share.
const { ids, factors } = factorVectors(contests, best);
let selfVar = 0;
let selfN = 0;
const explainedByYear = [];
const yearVar = [];
for (const y of TESTS) {
  const e = new Map(errors(best, y).map((x) => [x.id, x.err]));
  const mid = [...e.values()].reduce((a, b) => a + b, 0) / e.size;
  const r = ids.map((id) => (e.has(id) ? e.get(id) - mid : 0));
  const norm = r.reduce((s, x) => s + x * x, 0);
  const explained = factors.reduce((s, f) => s + r.reduce((t, x, i) => t + x * f.vector[i], 0) ** 2, 0);
  explainedByYear.push(explained / norm);
  yearVar.push(norm / e.size);
  selfVar += norm;
  selfN += e.size;
}
const chance = factors.length / ids.length;
const avgExplained = explainedByYear.reduce((a, b) => a + b, 0) / explainedByYear.length;
const sharedShare = Math.max(0.2, Math.min(0.85, (avgExplained - chance) / (1 - chance)));
// Calm years set the everyday stray. Turbulence supplies the occasional 2016.
const totalStray = Math.sqrt(selfVar / selfN);
console.log(` state stray ${totalStray.toFixed(2)} pts (by year ${yearVar.map((v) => Math.sqrt(v).toFixed(1)).join(", ")}), shared by similar states ${(100 * sharedShare).toFixed(0)}% (raw ${explainedByYear.map((x) => (100 * x).toFixed(0)).join(", ")}%, chance ${(100 * chance).toFixed(0)}%)`);
const stray = {
  sharedStray: totalStray * Math.sqrt(sharedShare),
  ownStray: totalStray * Math.sqrt(1 - sharedShare),
  districtExtra: 3.5,
};

// ---------- Part 2: the real candidates ----------

const TURBULENCE_DF = 4;
const SEEDS = 12345;
const DRAWS = 100000;

function runCase(c, stage) {
  const asOf = YEARS.filter((y) => y < c.year);
  const map = buildMap(contests, national, asOf, best);
  const params = finishParams(map, stray);
  const mood = stage === "final" ? c.finalPolls : fundamentals(national, asOf, c);
  const sd = stage === "final" ? 3 : 5.5;
  params.nationalMean = mood;
  params.nationalSd = sd;
  params.nationalDf = 5;
  params.candidateSd = stage === "final" ? 0.5 : 2;
  params.turbulenceDf = c.turbulenceDf ?? TURBULENCE_DF;

  const apply = c.useHome !== false;
  for (const pc of params.contests) {
    pc.weight = pc.weight ?? 0;
    if (apply && c.demHome?.includes(pc.parentId)) pc.base += 2;
    if (apply && c.repHome?.includes(pc.parentId)) pc.base -= 2;
  }
  const out = simulate(params, DRAWS, SEEDS + c.year);
  const truth = new Map(contests.map((x) => [x.id, x.results[c.year]]));
  const states = out.states.filter((s) => truth.get(s.id) != null);
  const wrong = states.filter((s) => (s.demWin > 0.5) !== (truth.get(s.id) > 0)).map((s) => s.id);
  const brier = states.reduce((a, s) => a + (s.demWin - (truth.get(s.id) > 0 ? 1 : 0)) ** 2, 0) / states.length;
  const inside = states.filter((s) => Math.abs(truth.get(s.id) - s.margin) <= 1.2816 * s.sd).length / states.length;
  const errs = states.filter((s) => !s.id.includes("-") && s.id !== "DC").map((s) => truth.get(s.id) - s.margin);
  return { out, mood, wrong, brier, inside, rmse: rms(errs) };
}

console.log("\nPART 2: real candidates through the full simulator");
for (const stage of ["two years out", "final"]) {
  console.log(`\n-- ${stage === "final" ? "final weeks, using the final national polling average" : "two years out, using only earlier results and the midterm"}`);
  for (const c of PAST_CASES) {
    const r = runCase(c, stage);
    const fav = r.out.demWin > r.out.repWin ? c.dem : c.rep;
    console.log(`${c.year} ${c.dem} vs ${c.rep}: mood D${r.mood >= 0 ? "+" : ""}${r.mood.toFixed(1)} (actual ${national[c.year] >= 0 ? "+" : ""}${national[c.year]}) | ${c.dem} ${(100 * r.out.demWin).toFixed(1)}%, ${c.rep} ${(100 * r.out.repWin).toFixed(1)}% | EV ${r.out.evMedian} [${r.out.evLow}-${r.out.evHigh}] actual ${c.actualEv} ${c.actualEv >= r.out.evLow && c.actualEv <= r.out.evHigh ? "inside" : "OUTSIDE"} | favored ${fav}, won ${c.actualEv >= 270 ? c.dem : c.rep}`);
    console.log(`     contests wrong ${r.wrong.length}/56: ${r.wrong.join(" ")} | state error ${r.rmse.toFixed(1)} | inside 80% range ${(100 * r.inside).toFixed(0)}% | Brier ${r.brier.toFixed(3)}`);
  }
}

console.log("\n-- does letting some years rearrange the map help? final weeks, actual electoral votes inside the 80% range");
for (const c of PAST_CASES) {
  const a = runCase(c, "final");
  const b = runCase({ ...c, turbulenceDf: 0 }, "final");
  const line = (r) => `${r.out.evLow}-${r.out.evHigh}, ${(100 * r.inside).toFixed(0)}% of contests inside, Brier ${r.brier.toFixed(3)}`;
  console.log(`${c.year} actual ${c.actualEv}: with ${line(a)} | without ${line(b)}`);
}

console.log("\n-- does the home-state piece help? final-weeks state error with and without");
for (const c of PAST_CASES) {
  const a = runCase(c, "final");
  const b = runCase({ ...c, useHome: false }, "final");
  console.log(`${c.year}: with ${a.rmse.toFixed(2)}, without ${b.rmse.toFixed(2)}`);
}

writeFileSync("data/state_fit.json", JSON.stringify({ cfg: best, stray, sharedShare, totalStray, turbulenceDf: TURBULENCE_DF, built: new Date().toISOString() }, null, 1) + "\n");
console.log("\nwrote data/state_fit.json");
