// The election simulator. No page or network code, so the browser, the collector
// and the back-test all run the same thing. All margins are Democrat minus Republican.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function normals(random) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u;
    let v;
    let r;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      r = u * u + v * v;
    } while (r >= 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    spare = v * f;
    return u * f;
  };
}

function chiSquare(normal, df) {
  let chi = 0;
  for (let i = 0; i < df; i++) {
    const z = normal();
    chi += z * z;
  }
  return chi;
}

// Heavier tails than a bell curve, because surprise years happen. Scaled to unit spread.
function studentT(normal, df) {
  return (normal() / Math.sqrt(chiSquare(normal, df) / df)) * Math.sqrt((df - 2) / df);
}

// params: { nationalMean, nationalSd, nationalDf, candidateSd, nRef, factorSd: [..], districtShare,
//   contests: [{ id, ev, base, elasticity, sigma, load: [..], parent: index|null, weight }] }
export function simulate(params, draws = 100000, seed = 1) {
  const normal = normals(rng(seed));
  const { contests, factorSd } = params;
  const n = contests.length;
  const k = factorSd.length;
  const evDem = new Uint32Array(539);
  const stateWins = new Float64Array(n);
  const stateMargin = new Float64Array(n);
  const stateMargin2 = new Float64Array(n);
  const tipCount = new Float64Array(n);
  const popular = new Float32Array(draws);
  const margins = new Float64Array(n);
  const idio = new Float64Array(n);
  const f = new Float64Array(k);
  const order = contests.map((_, i) => i);
  const totalWeight = contests.reduce((a, c) => a + (c.weight ?? 0), 0) || 1;
  let demWins = 0;
  let repWins = 0;
  let ties = 0;

  for (let d = 0; d < draws; d++) {
    const N = params.nationalMean + params.nationalSd * studentT(normal, params.nationalDf) + params.candidateSd * normal();
    // Some years rearrange the map far more than others, as 2016 did.
    const turbulence = params.turbulenceDf ? Math.sqrt((params.turbulenceDf - 2) / chiSquare(normal, params.turbulenceDf)) : 1;
    for (let j = 0; j < k; j++) f[j] = factorSd[j] * turbulence * normal();

    let ev = 0;
    let pop = 0;
    for (let i = 0; i < n; i++) {
      const c = contests[i];
      // A district moves with its state, plus its own local drift.
      let shock;
      if (c.parent == null) {
        shock = normal() * c.sigma * turbulence;
        idio[i] = shock;
      } else {
        shock = idio[c.parent] * params.districtShare + normal() * c.sigma * turbulence;
      }
      let m = c.base + c.elasticity * (N - params.nRef) + shock;
      for (let j = 0; j < k; j++) m += c.load[j] * f[j];
      margins[i] = m;
      stateMargin[i] += m;
      stateMargin2[i] += m * m;
      if (m > 0) {
        stateWins[i]++;
        ev += c.ev;
      }
      pop += (c.weight ?? 0) * m;
    }
    evDem[ev]++;
    popular[d] = pop / totalWeight;

    const demWon = ev >= 270;
    if (demWon) demWins++;
    else if (ev <= 268) repWins++;
    else ties++;

    // The state that put the winner over 270, walking from their best state down.
    if (ev !== 269) {
      order.sort(demWon ? (a, b) => margins[b] - margins[a] : (a, b) => margins[a] - margins[b]);
      let tally = 0;
      for (const i of order) {
        if (demWon ? margins[i] <= 0 : margins[i] >= 0) break;
        tally += contests[i].ev;
        if (tally >= 270) {
          tipCount[i]++;
          break;
        }
      }
    }
  }

  popular.sort();
  const q = (p) => popular[Math.min(draws - 1, Math.floor(p * draws))];
  const evQuantile = (p) => {
    let cum = 0;
    for (let e = 0; e <= 538; e++) {
      cum += evDem[e];
      if (cum >= p * draws) return e;
    }
    return 538;
  };

  return {
    draws,
    demWin: demWins / draws,
    repWin: repWins / draws,
    tie: ties / draws,
    evMedian: evQuantile(0.5),
    evLow: evQuantile(0.1),
    evHigh: evQuantile(0.9),
    evHist: Array.from(evDem),
    popularMedian: q(0.5),
    popularLow: q(0.1),
    popularHigh: q(0.9),
    states: contests.map((c, i) => ({
      id: c.id,
      ev: c.ev,
      demWin: stateWins[i] / draws,
      margin: stateMargin[i] / draws,
      sd: Math.sqrt(Math.max(0, stateMargin2[i] / draws - (stateMargin[i] / draws) ** 2)),
      tip: tipCount[i] / draws,
    })),
  };
}

// Turns the daily model and two names into simulator settings, and says what each piece did.
export function buildMatchup(model, demId, repId) {
  const dem = model.people[demId];
  const rep = model.people[repId];
  const polls = (model.matchups ?? []).filter((m) => m.dem === demId && m.rep === repId);
  const today = model.updated.slice(0, 10);
  const ageOf = (m) => (Date.parse(today) - Date.parse(m.end)) / 864e5;
  // Direct polls of a pairing count more as the election nears: two years out, it takes
  // about nine fresh polls to outweigh everything else we know.
  const trust = 1 + model.daysLeft / 90;

  const parts = [{ label: "National mood", value: model.mood.center }];
  let mean = model.mood.center + dem.strength - rep.strength;
  parts.push({ label: `${dem.name} edge`, value: dem.strength, pieces: dem.pieces });
  parts.push({ label: `${rep.name} edge`, value: -rep.strength, pieces: rep.pieces });

  const two = polls.filter((m) => !m.state && !m.third);
  if (two.length) {
    const w = two.map((m) => 2 ** (-ageOf(m) / 90));
    const total = w.reduce((a, b) => a + b, 0);
    const avg = two.reduce((s, m, i) => s + w[i] * (m.demPct - m.repPct), 0) / total;
    const pull = (total / (total + trust)) * (avg - mean);
    mean += pull;
    parts.push({ label: `Polls of this matchup (${two.length})`, value: pull });
  }

  const statePolls = polls.filter((m) => m.state && !m.third);
  const contests = model.map.contests.map((c) => {
    let base = c.base;
    const homeState = (who, sign) => {
      if (who.home?.includes(c.parentId)) return sign * (c.district ? who.homeBonus * 0.5 : who.homeBonus);
      const mine = who.home?.map((h) => model.map.contests.find((x) => x.id === h)?.division);
      return mine?.includes(c.division) ? sign * 0.4 : 0;
    };
    base += homeState(dem, 1) + homeState(rep, -1);
    if (!c.district) {
      const here = statePolls.filter((m) => m.state === c.id);
      if (here.length) {
        const w = here.map((m) => 2 ** (-ageOf(m) / 90));
        const total = w.reduce((a, b) => a + b, 0);
        const avg = here.reduce((s, m, i) => s + w[i] * (m.demPct - m.repPct), 0) / total;
        const expected = base + c.elasticity * (mean - model.map.nRef);
        base += (total / (total + trust)) * (avg - expected);
      }
    }
    return { ...c, base };
  });

  return {
    params: {
      nationalMean: mean,
      nationalSd: model.mood.sd,
      nationalDf: model.mood.df,
      candidateSd: Math.sqrt(dem.sd ** 2 + rep.sd ** 2),
      nRef: model.map.nRef,
      factorSd: model.map.factorSd,
      districtShare: model.map.districtShare,
      turbulenceDf: model.map.turbulenceDf,
      contests,
    },
    parts,
    polls,
  };
}
