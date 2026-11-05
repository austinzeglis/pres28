// Turns past results and demographics into each contest's starting point, how hard
// it moves with the country, how far it strays, and which states stray together.
// Pure functions, so the back-test can rebuild it using only pre-election years.

const YEARS = [2008, 2012, 2016, 2020, 2024];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const leanIn = (contest, year, national) => contest.results[year] - national[year];

// The state's lean relative to the country for the next election, from the past few.
export function projectedLean(contest, national, asOfYears, cfg) {
  const ys = asOfYears.slice(-3).reverse();
  const weights = cfg.leanWeights.slice(0, ys.length);
  const total = weights.reduce((a, b) => a + b, 0);
  let lean = 0;
  ys.forEach((y, i) => { lean += (weights[i] / total) * leanIn(contest, y, national); });
  if (ys.length >= 2) lean += cfg.trend * (leanIn(contest, ys[0], national) - leanIn(contest, ys[1], national));
  return lean;
}

// How much a state moves when the country moves. Most states are near 1. Places
// with few persuadable voters move less. Estimated from history, pulled hard toward 1.
export function elasticity(contest, national, asOfYears, cfg) {
  let num = 0;
  let den = 0;
  for (let i = 1; i < asOfYears.length; i++) {
    const a = asOfYears[i - 1];
    const b = asOfYears[i];
    const dN = national[b] - national[a];
    num += dN * (contest.results[b] - contest.results[a]);
    den += dN * dN;
  }
  if (!den) return 1;
  return clamp(1 + cfg.elasticityKeep * (num / den - 1), 0.6, 1.3);
}

function features(contests) {
  const raw = contests.map((c) => {
    const d = c.demo;
    return [d.college, d.black, d.hispanic, d.asian, d.native, d.white, d.meanAge, d.over65, d.urban].map((x) => x ?? 0);
  });
  const dims = raw[0].length;
  const out = raw.map(() => []);
  for (let j = 0; j < dims; j++) {
    const col = raw.map((r) => r[j]);
    const m = mean(col);
    const sd = Math.sqrt(mean(col.map((x) => (x - m) ** 2))) || 1;
    raw.forEach((r, i) => out[i].push((r[j] - m) / sd));
  }
  return out;
}

// How alike two states are, from 0 to 1: demographics, and a bump for the same region.
export function similarity(contests, cfg) {
  const f = features(contests);
  const n = contests.length;
  const K = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let dist = 0;
      for (let d = 0; d < f[i].length; d++) dist += (f[i][d] - f[j][d]) ** 2;
      const demo = Math.exp(-dist / (2 * f[i].length * cfg.kernelWidth ** 2));
      const region = contests[i].division === contests[j].division ? 1 : 0;
      K[i][j] = (1 - cfg.regionShare) * demo + cfg.regionShare * region;
    }
  }
  return K;
}

function centered(K) {
  const n = K.length;
  const row = K.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const all = row.reduce((a, b) => a + b, 0) / n;
  return K.map((r, i) => r.map((x, j) => x - row[i] - row[j] + all));
}

// The largest few independent patterns in a similarity matrix, by repeated power iteration.
export function topFactors(K, count) {
  const n = K.length;
  const A = K.map((r) => Float64Array.from(r));
  const factors = [];
  for (let f = 0; f < count; f++) {
    let v = Float64Array.from({ length: n }, (_, i) => Math.sin(i * (f + 1) + 1));
    let value = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) w[i] += A[i][j] * v[j];
      value = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      if (!value) break;
      v = w.map((x) => x / value);
    }
    factors.push({ value, vector: Array.from(v) });
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i][j] -= value * v[i] * v[j];
  }
  return factors;
}

// What the last shift in state leans says about the kind of place that's moving:
// regress it on demographics, so a state follows places like it, not just its own past.
function demographicDrift(statewide, national, asOfYears) {
  if (asOfYears.length < 2) return new Map();
  const [a, b] = asOfYears.slice(-2);
  const y = statewide.map((c) => leanIn(c, b, national) - leanIn(c, a, national));
  const X = features(statewide);
  const dims = X[0].length;
  const A = Array.from({ length: dims }, (_, i) => Array.from({ length: dims }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? statewide.length * 0.5 : 0)));
  const v = Array.from({ length: dims }, (_, i) => X.reduce((s, r, n) => s + r[i] * y[n], 0));
  for (let i = 0; i < dims; i++) {
    for (let j = i + 1; j < dims; j++) {
      const f = A[j][i] / A[i][i];
      for (let c = i; c < dims; c++) A[j][c] -= f * A[i][c];
      v[j] -= f * v[i];
    }
  }
  const beta = Array(dims).fill(0);
  for (let i = dims - 1; i >= 0; i--) {
    let t = v[i];
    for (let j = i + 1; j < dims; j++) t -= A[i][j] * beta[j];
    beta[i] = t / A[i][i];
  }
  return new Map(statewide.map((c, n) => [c.id, X[n].reduce((s, x, i) => s + x * beta[i], 0)]));
}

export function factorVectors(allContests, cfg) {
  const statewide = allContests.filter((c) => !c.district);
  return { ids: statewide.map((c) => c.id), factors: topFactors(centered(similarity(statewide, cfg)), cfg.factors) };
}

// Everything the simulator needs about the map, using only the years given.
export function buildMap(allContests, national, asOfYears, cfg) {
  const statewide = allContests.filter((c) => !c.district);
  const drift = cfg.demoDrift ? demographicDrift(statewide, national, asOfYears) : new Map();
  // Centered, because what all states share is the national mood, which is modeled separately.
  const K = centered(similarity(statewide, cfg));
  const factors = topFactors(K, cfg.factors);
  const index = new Map(statewide.map((c, i) => [c.id, i]));
  const nRef = national[asOfYears.at(-1)];

  const contests = allContests.map((c) => {
    const home = index.get(c.parent);
    const parentRow = factors.map((f) => f.vector[home] * Math.sqrt(f.value));
    const scale = Math.sqrt(parentRow.reduce((s, x) => s + x * x, 0)) || 1;
    return {
      id: c.id,
      ev: c.ev,
      name: c.name,
      division: c.division,
      district: c.district,
      parentId: c.parent,
      // Lean plus the reference year's national margin gives the margin at that national margin.
      base: projectedLean(c, national, asOfYears, cfg) + (cfg.demoDrift ?? 0) * (drift.get(c.parent) ?? 0) + nRef,
      elasticity: c.district ? 1 : elasticity(c, national, asOfYears, cfg),
      unit: parentRow.map((x) => x / scale),
      weight: c.district ? 0 : c.demo.pop,
    };
  });
  return { contests, nRef };
}

// Each contest's total stray is split between a shared part, with similar states
// moving together, and a part only that state feels.
export function finishParams(map, { sharedStray, ownStray, districtExtra }) {
  const byId = new Map(map.contests.map((c, i) => [c.id, i]));
  const k = map.contests[0].unit.length;
  return {
    nRef: map.nRef,
    factorSd: Array(k).fill(sharedStray),
    districtShare: 0.8,
    contests: map.contests.map((c) => ({
      ...c,
      load: c.unit,
      sigma: c.district ? districtExtra : ownStray,
      parent: c.district ? byId.get(c.parentId) : null,
    })),
  };
}

export const ALL_YEARS = YEARS;
