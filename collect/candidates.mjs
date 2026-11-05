// How much better or worse than a generic nominee each person would run, built from
// separate pieces. Each piece is small and capped, so no single signal can decide a race.
// Positive is good for that person, in points of national margin.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// House popular vote where a national margin isn't available, or the nearest thing in off years.
const ENVIRONMENT = { 2016: -1.1, 2018: 8.6, 2019: 2, 2020: 3.1, 2021: -3, 2022: -2.8, 2023: 2, 2024: -2.7, 2025: 6 };

const RECORD_TRANSFER = 0.25; // most of a local overperformance doesn't travel nationally
const INCUMBENT_EDGE = 2.5;
const AGE_START = 75;
const AGE_PER_YEAR = 0.2;
const IDEOLOGY_PER_UNIT = 2.5;
const TRUMP_DISTANCE_PER_POINT = 0.08; // of net disapproval, for someone with no tie to him
// Two years out, nobody has been vetted nationally. Candidate edges count for half now and in
// full by Election Day, and ranges start wider and tighten the same way.
const FAR_OUT_SHARE = 0.5;
const STRENGTH_CAP = 3.5;
const BASE_SD = { far: 2.5, near: 1 };

// These members' voting scores look moderate because they vote against their party
// from its edge, so the score says the opposite of what voters see.
const VOTING_SCORE_MISLEADS = new Set(["alexandria-ocasio-cortez", "bernie-sanders", "ro-khanna", "thomas-massie", "marjorie-taylor-greene", "rand-paul", "john-fetterman"]);

export const INELIGIBLE = { "donald-trump": "Two-term limit", "elon-musk": "Born abroad" };

function leanOf(contest, national, year) {
  const years = [2008, 2012, 2016, 2020, 2024];
  const near = years.filter((y) => Math.abs(y - year) <= 2);
  const use = near.length ? near : [years.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a))];
  return use.reduce((s, y) => s + contest.results[y] - national[y], 0) / use.length;
}

// How far they beat their state's lean and the national mood that year, recent races counting most.
export function overperformance(races, party, contests, national, house2026) {
  if (!races?.length) return null;
  let total = 0;
  let weight = 0;
  for (const r of races) {
    const c = contests.get(r.state);
    if (!c) continue;
    const env = r.year === 2026 ? house2026 : ENVIRONMENT[r.year] ?? 0;
    const expected = leanOf(c, national, r.year) + env;
    const beat = (party === "D" ? 1 : -1) * (r.demMargin - expected) - (r.incumbent ? INCUMBENT_EDGE : 0);
    const w = 0.8 ** (2026 - r.year);
    total += w * beat;
    weight += w;
  }
  return weight ? total / weight : null;
}

// Every two-way matchup poll: margin = the poll's mood + Democrat's edge - Republican's edge.
// Asking the same voters about several pairings is what separates candidates from the mood.
export function pollEdges(rows, today) {
  const polls = rows.filter((r) => !r.state && !r.third && r.demPct != null && r.repPct != null);
  if (!polls.length) return {};
  const keyOf = (r) => `${r.pollster}|${r.end}`;
  const w = polls.map((r) => 2 ** (-(new Date(today) - new Date(r.end)) / 864e5 / 240));
  const edge = {};
  const count = {};
  const mood = {};
  const overall = polls.reduce((s, r, i) => s + w[i] * (r.demPct - r.repPct), 0) / w.reduce((a, b) => a + b, 0);
  for (const r of polls) {
    edge[`D:${r.dem}`] = 0;
    edge[`R:${r.rep}`] = 0;
    mood[keyOf(r)] = overall;
    count[r.dem] = (count[r.dem] ?? 0) + 1;
    count[r.rep] = (count[r.rep] ?? 0) + 1;
  }
  const PULL = 3; // toward zero, or one poll would set the number
  const MOOD_PULL = 1;
  for (let it = 0; it < 60; it++) {
    for (const key of Object.keys(mood)) {
      let num = MOOD_PULL * overall;
      let den = MOOD_PULL;
      polls.forEach((r, i) => {
        if (keyOf(r) !== key) return;
        num += w[i] * (r.demPct - r.repPct - edge[`D:${r.dem}`] + edge[`R:${r.rep}`]);
        den += w[i];
      });
      mood[key] = num / den;
    }
    for (const k of Object.keys(edge)) {
      const [side, id] = [k[0], k.slice(2)];
      let num = 0;
      let den = PULL;
      polls.forEach((r, i) => {
        if ((side === "D" ? r.dem : r.rep) !== id) return;
        const rest = r.demPct - r.repPct - mood[keyOf(r)] + (side === "D" ? edge[`R:${r.rep}`] : -edge[`D:${r.dem}`]);
        num += w[i] * (side === "D" ? rest : -rest);
        den += w[i];
      });
      edge[k] = num / den;
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(edge)) out[k.slice(2)] = { edge: v, polls: count[k.slice(2)] };
  return out;
}

const normalInverse = (p) => {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - 0.02425) return -normalInverse(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

// A win price over a nomination price is the market's odds of winning if nominated. It's
// noisy at long odds, so it fades out below a 10% nomination price and is capped.
export function marketEdges(quotes, spread = 7) {
  const out = {};
  for (const party of ["D", "R"]) {
    const rows = [];
    for (const src of ["poly", "kalshi"]) {
      const nom = new Map(quotes.filter((q) => q.source === `${src}_nom_${party}`).map((q) => [q.person, q.value]));
      const win = new Map(quotes.filter((q) => q.source === `${src}_win`).map((q) => [q.person, q.value]));
      for (const [person, n] of nom) {
        const w = win.get(person);
        if (n >= 0.02 && w > 0) rows.push({ person, nom: n, odds: clamp(w / n, 0.05, 0.95) });
      }
    }
    const byPerson = new Map();
    for (const r of rows) {
      const e = byPerson.get(r.person) ?? { z: 0, n: 0, nom: 0 };
      e.z += normalInverse(r.odds);
      e.n++;
      e.nom = Math.max(e.nom, r.nom);
      byPerson.set(r.person, e);
    }
    const all = [...byPerson.values()];
    const totalNom = all.reduce((s, e) => s + e.nom, 0) || 1;
    const avgZ = all.reduce((s, e) => s + (e.z / e.n) * e.nom, 0) / totalNom;
    for (const [person, e] of byPerson) {
      out[person] = clamp(((e.z / e.n - avgZ) * spread) * Math.min(1, e.nom / 0.1), -3, 3);
    }
  }
  return out;
}

export function buildPeople({ roster, facts, partyMedian, contests, national, house2026, matchups, quotes, netApproval, today, daysLeft }) {
  const fade = Math.min(1, daysLeft / 730);
  const share = FAR_OUT_SHARE + (1 - FAR_OUT_SHARE) * (1 - fade);
  const baseSd = BASE_SD.near + (BASE_SD.far - BASE_SD.near) * fade;
  const polled = pollEdges(matchups, today);
  const marketed = marketEdges(quotes);
  const distance = Math.max(0, -netApproval) * TRUMP_DISTANCE_PER_POINT;
  const inauguration = new Date("2029-01-20");
  const out = {};
  for (const p of roster) {
    const f = facts[p.id] ?? {};
    const pieces = [];
    const add = (label, value) => {
      if (value != null && Number.isFinite(value) && Math.abs(value) >= 0.01) pieces.push({ label, value: Math.round(value * 100) / 100 });
    };
    if (polled[p.id]) add(`Matchup polls (${polled[p.id].polls})`, (p.party === "D" ? 1 : 1) * clamp(polled[p.id].edge, -4, 4));
    add("Market odds if nominated", marketed[p.id] ?? null);
    const beat = overperformance(f.races, p.party, contests, national, house2026);
    if (beat != null) add("Past races", clamp(beat * RECORD_TRANSFER, -3, 3));
    if (f.nominate != null && !VOTING_SCORE_MISLEADS.has(p.id)) {
      const extra = Math.abs(f.nominate) - Math.abs(partyMedian[p.party]);
      add("Voting record", clamp(-extra * IDEOLOGY_PER_UNIT, -1.5, 1.5));
    }
    if (p.party === "R" && f.tie != null) add("Distance from Trump", (1 - f.tie) * distance);
    if (p.dob) {
      const age = (inauguration - new Date(p.dob)) / (365.25 * 864e5);
      if (age > AGE_START) add("Age", -Math.min(2, (age - AGE_START) * AGE_PER_YEAR));
    }
    const raw = pieces.reduce((s, x) => s + x.value, 0);
    const strength = clamp(raw * share, -STRENGTH_CAP, STRENGTH_CAP);
    if (Math.abs(raw - strength) >= 0.01) pieces.push({ label: "Too early to count in full", value: Math.round((strength - raw) * 100) / 100 });
    // The less we know, the wider this person's range.
    const unknown = (polled[p.id] ? 0 : 0.7) + (marketed[p.id] != null ? 0 : 0.9) + (f.races?.length ? 0 : 0.7);
    out[p.id] = {
      name: p.name,
      party: p.party,
      home: f.home ?? [],
      homeBonus: Math.round(clamp(1.5 + (beat == null ? 0 : Math.max(0, beat) * 0.15), 1.5, 4) * 100) / 100,
      pieces,
      strength: Math.round(strength * 100) / 100,
      sd: Math.round((baseSd + unknown) * 100) / 100,
      depth: (polled[p.id] ? 1 : 0) + (marketed[p.id] != null ? 1 : 0) + (f.races?.length ? 1 : 0),
      ineligible: INELIGIBLE[p.id] ?? null,
      photo: p.photo ?? null,
    };
  }
  return out;
}
