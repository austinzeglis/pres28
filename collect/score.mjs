// The blended strength index. Pure functions: no network, no storage.
import { slug } from "./names.mjs";

export const WEIGHTS = { markets: 0.45, polls: 0.45, attention: 0.1 };

const DAY = 864e5;
const days = (a, b) => (new Date(b) - new Date(a)) / DAY;
const NOT_A_PERSON = /^(other|others|someone else|undecided|unsure|not sure|none|no one|nobody|don.?t know|dk|refused|would not vote|wouldn.?t vote|no answer|another candidate|skipped)\b/i;

// ---------- polls ----------

// One poll can appear several times (subgroups, or versions with different names
// offered). Keep the widest field, then the largest sample.
export function cleanPolls(rows) {
  const best = new Map();
  for (const r of rows) {
    const answers = (typeof r.answers === "string" ? JSON.parse(r.answers) : r.answers)
      .filter((a) => !NOT_A_PERSON.test(a.choice) && a.pct > 0);
    if (answers.length < 2) continue;
    const total = answers.reduce((n, a) => n + a.pct, 0);
    const poll = {
      pollster: r.pollster,
      end: r.end_date,
      party: r.subject.includes("Democratic") ? "D" : "R",
      n: r.sample_size ?? 0,
      population: r.population,
      discounted: Boolean(r.partisan || r.internal),
      url: r.url,
      raw: Object.fromEntries(answers.map((a) => [slug(a.choice), a.pct])),
      shares: Object.fromEntries(answers.map((a) => [slug(a.choice), a.pct / total])),
    };
    const key = `${poll.party}|${poll.pollster}|${poll.end}`;
    const held = best.get(key);
    const size = (p) => Object.keys(p.shares).length * 1e6 + p.n;
    if (!held || size(poll) > size(held)) best.set(key, poll);
  }
  return [...best.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
}

function pollWeight(p, day) {
  const recency = 2 ** (-days(p.end, day) / 60);
  const sample = Math.sqrt(Math.min(p.n || 600, 2000) / 800);
  return recency * sample * (p.discounted ? 0.5 : 1) * (p.population === "a" ? 0.8 : 1);
}

// Fits one strength per person where a poll's share is a person's strength over
// the total strength of whoever that poll offered. So someone left out of a poll
// counts as missing, and a short list doesn't inflate the people on it.
function fitStrengths(polls) {
  const ids = [...new Set(polls.flatMap((p) => Object.keys(p.shares)))];
  let s = Object.fromEntries(ids.map((i) => [i, 1 / ids.length]));
  for (let iter = 0; iter < 60; iter++) {
    const num = Object.fromEntries(ids.map((i) => [i, 0]));
    const den = Object.fromEntries(ids.map((i) => [i, 0]));
    for (const p of polls) {
      const field = Object.keys(p.shares);
      const sum = field.reduce((n, i) => n + s[i], 0);
      for (const i of field) {
        num[i] += p.w * p.shares[i];
        den[i] += p.w / sum;
      }
    }
    const next = Object.fromEntries(ids.map((i) => [i, num[i] / den[i]]));
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    for (const i of ids) next[i] /= total;
    s = next;
  }
  return s;
}

// How far each pollster reads above or below the fit for each person, pulled
// toward zero when that pollster has few polls, then removed.
function withoutHouseEffects(polls, s) {
  const seen = new Map();
  for (const p of polls) {
    const field = Object.keys(p.shares);
    const sum = field.reduce((n, i) => n + s[i], 0);
    for (const i of field) {
      const key = `${p.pollster}|${i}`;
      const e = seen.get(key) ?? { total: 0, n: 0 };
      e.total += Math.log(p.shares[i] / (s[i] / sum));
      e.n += 1;
      seen.set(key, e);
    }
  }
  return polls.map((p) => {
    const adjusted = {};
    for (const [i, v] of Object.entries(p.shares)) {
      const e = seen.get(`${p.pollster}|${i}`);
      adjusted[i] = v / Math.exp(e.total / (e.n + 3));
    }
    const total = Object.values(adjusted).reduce((a, b) => a + b, 0);
    for (const i of Object.keys(adjusted)) adjusted[i] /= total;
    return { ...p, shares: adjusted };
  });
}

// Each person's share of the poll race as of a day. Polls older than 18 months don't count.
export function pollShares(polls, party, day) {
  const active = polls
    .filter((p) => p.party === party && p.end <= day && days(p.end, day) <= 540)
    .map((p) => ({ ...p, w: pollWeight(p, day) }));
  if (active.length < 2) return {};
  return fitStrengths(withoutHouseEffects(active, fitStrengths(active)));
}

// ---------- blending ----------

// Each market's prices become shares, which removes the extra that prices add up to.
export function marketShares(rows) {
  const bySource = new Map();
  for (const r of rows) {
    if (!(r.value > 0)) continue;
    const m = bySource.get(r.source) ?? new Map();
    m.set(r.person, r.value);
    bySource.set(r.source, m);
  }
  const out = {};
  for (const m of bySource.values()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    for (const [person, value] of m) (out[person] ??= []).push(value / total);
  }
  return Object.fromEntries(Object.entries(out).map(([p, v]) => [p, v.reduce((a, b) => a + b, 0) / v.length]));
}

// Attention: square roots, so one enormous name doesn't flatten everyone else.
export function attentionShares(people, wiki, news) {
  const shares = (values) => {
    const roots = people.map((id) => Math.sqrt(values[id] ?? 0));
    const total = roots.reduce((a, b) => a + b, 0);
    return total > 0 ? Object.fromEntries(people.map((id, i) => [id, roots[i] / total])) : null;
  };
  const w = shares(wiki);
  const n = shares(news);
  return Object.fromEntries(people.map((id) => {
    const parts = [w?.[id], n?.[id]].filter((x) => x != null);
    return [id, parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0];
  }));
}

// With both polls and markets, they get their weights. With one, it stands in for
// the other. With neither, only attention counts, which keeps the name low and marks it thin.
export function blend(m, p, a) {
  const { markets, polls, attention } = WEIGHTS;
  if (m != null && p != null) return markets * m + polls * p + attention * a;
  if (m != null || p != null) return (markets + polls) * (m ?? p) + attention * a;
  return attention * a;
}

// Ranks one party. inputs: { id: { m, p, a } }
export function rankParty(inputs) {
  const rows = Object.entries(inputs).map(([id, x]) => ({ id, ...x, blend: blend(x.m, x.p, x.a ?? 0) }));
  rows.sort((a, b) => b.blend - a.blend || a.id.localeCompare(b.id));
  const top = rows[0]?.blend || 1;
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.score = (100 * r.blend) / top;
    r.thin = r.m == null && r.p == null;
  });
  return { rows, top };
}
