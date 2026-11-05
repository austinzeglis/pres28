// Turns past results and demographics into each contest's starting point, how far
// it strays, and which states stray together. Pure functions, so the back-test can
// rebuild it using only pre-election years.

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
function similarity(contests, cfg) {
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

// Centered, because what all states share is the national mood, which is modeled separately.
function centered(K) {
  const n = K.length;
  const row = K.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const all = row.reduce((a, b) => a + b, 0) / n;
  return K.map((r, i) => r.map((x, j) => x - row[i] - row[j] + all));
}

// The largest few independent patterns in a similarity matrix, by repeated power iteration.
function topFactors(K, count) {
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

// Each state's unit-length row of factor loadings: what it shares with similar states.
export function stateLoadings(allContests, cfg) {
  const statewide = allContests.filter((c) => !c.district);
  const factors = topFactors(centered(similarity(statewide, cfg)), cfg.factors);
  return new Map(statewide.map((c, i) => {
    const row = factors.map((f) => f.vector[i] * Math.sqrt(Math.max(f.value, 0)));
    const scale = Math.sqrt(row.reduce((s, x) => s + x * x, 0)) || 1;
    return [c.id, row.map((x) => x / scale)];
  }));
}

// Everything the simulator needs about the map, using only the years given.
export function buildMap(allContests, national, asOfYears, cfg) {
  const loadings = stateLoadings(allContests, cfg);
  const nRef = national[asOfYears.at(-1)];
  const contests = allContests.map((c) => ({
    id: c.id,
    ev: c.ev,
    name: c.name,
    division: c.division,
    district: c.district,
    parentId: c.parent,
    // Lean plus the reference year's national margin gives the margin at that national margin.
    base: projectedLean(c, national, asOfYears, cfg) + nRef,
    unit: loadings.get(c.parent),
    weight: c.district ? 0 : c.demo.pop,
  }));
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
