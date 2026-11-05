import { buildMatchup, hashSeed, simulate } from "./sim.js?v=12";

const app = document.getElementById("app");
const tip = document.getElementById("tip");
const TZ = "America/Chicago";

const STATUS = { mentioned: "Mentioned", said_no: "Said no", exploring: "Exploring", building: "Building", declared: "Declared", out: "Out" };
const PARTY = { D: "Democrats", R: "Republicans" };
const COLOR = { D: "#2b63b5", R: "#c8402f", poly: "#00856b", kalshi: "#c26a12" };
const REFRESH_MS = 5 * 60 * 1000;

const state = { board: null, feed: { 2028: null, all: null }, personFeed: new Map(), scope: "2028", party: "", who: "" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Links come from outside feeds, so only ordinary web addresses are used as links.
const link = (u) => (/^https?:\/\//i.test(u ?? "") ? esc(u) : "#");
const fmt1 = (x) => (x == null ? "–" : x >= 10 ? x.toFixed(0) : x.toFixed(1));
const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};
const stamp = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " CT";
const shortDate = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${d}T12:00:00Z`));
function ago(iso) {
  if (!iso) return "";
  const mins = (Date.now() - new Date(iso)) / 6e4;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  if (mins < 43200) return `${Math.round(mins / 1440)}d`;
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", year: "numeric" }).format(new Date(iso));
}

// ---------- tooltip ----------

function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, innerWidth - box.width - 8)}px`;
  tip.style.top = `${Math.min(y + 14, innerHeight - box.height - 8)}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------- home ----------

function rowHtml(r) {
  const rise = r.r7 == null ? "" : r.r7 > 0 ? `▲${r.r7}` : r.r7 < 0 ? `▼${-r.r7}` : "=";
  return `<a class="row grid${r.thin ? " thin" : ""}" href="/p/${r.id}" data-id="${r.id}">
    <span class="rk">${r.rank}</span>
    <span class="nm">${esc(r.name)}${r.on_list ? "" : "<sup>+</sup>"}</span>
    <span class="st ${r.status}">${STATUS[r.status]}</span>
    <span class="plot"><i class="bar" style="width:${r.score}%"></i></span>
    <span class="num sc">${r.score >= 10 ? r.score.toFixed(0) : r.score.toFixed(1)}</span>
    <span class="num src${r.m == null ? " nil" : ""}">${fmt1(r.m)}</span>
    <span class="num src${r.p == null ? " nil" : ""}">${fmt1(r.p)}</span>
    <span class="chg${r.r7 === 0 ? " flat" : ""}">${rise}</span>
  </a>`;
}

function boardHtml(party) {
  const { rows } = state.board[party];
  return `<section class="board ${party}">
    <h2><i class="swatch"></i>${PARTY[party]}</h2>
    <div class="grid head">
      <span></span><span></span><span class="st-h">Status</span>
      <span></span>
      <span class="num">Score</span><span class="num">Mkts</span><span class="num">Polls</span><span class="num">7d</span>
    </div>
    ${rows.map(rowHtml).join("")}
  </section>`;
}

const TALK = /presiden|white house|nominee|nomination|primary|primaries|caucus|2028 (run|bid|race|field|contender|hopeful|campaign|ticket|speculation|talk|chatter|buzz|field)/i;
const cleanTitle = (s) => s.title.replace(/\s+-\s+[^-]{2,60}$/, "");

function visibleStories() {
  // Someone's own stories go far beyond the newest few hundred.
  const rows = (state.who ? state.personFeed.get(state.who) : state.feed[state.scope]) ?? [];
  const lookup = peopleIndex();
  const seen = new Set();
  const out = [];
  for (const s of rows) {
    const people = JSON.parse(s.people ?? "[]");
    if (state.scope === "2028" && !(s.title.includes("2028") || (s.text ?? "").includes("2028")) ) continue;
    if (state.scope === "2028" && !TALK.test(`${s.title} ${s.text ?? ""}`)) continue;
    if (state.party && !people.some((id) => lookup[id]?.party === state.party)) continue;
    const key = cleanTitle(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, people });
    if (out.length >= 120) break;
  }
  return out;
}

function peopleIndex() {
  const index = {};
  for (const party of ["D", "R"]) for (const r of state.board?.[party].rows ?? []) index[r.id] = { name: r.name, party };
  return index;
}

function storyHtml(s, lookup) {
  const chips = s.people.slice(0, 4).map((id) => {
    const p = lookup[id];
    return p ? `<button class="who" data-who="${id}"><i class="${p.party}"></i>${esc(p.name.split(" ").slice(-1)[0] === "Jr." ? p.name.split(" ").slice(-2).join(" ") : p.name.split(" ").slice(-1)[0])}</button>` : "";
  }).join("");
  return `<article class="story"><a href="${link(s.url)}" target="_blank" rel="noopener">${esc(cleanTitle(s))}</a>
    <div class="meta"><span>${esc(s.source)}</span><span>${ago(s.published)}</span>${chips}</div></article>`;
}

function newsBody() {
  const lookup = peopleIndex();
  if (state.who ? !state.personFeed.has(state.who) : !state.feed[state.scope]) return `<div class="none">Loading</div>`;
  const list = visibleStories();
  return list.length ? list.map((s) => storyHtml(s, lookup)).join("") : `<div class="none">No headlines</div>`;
}

function newsTabs() {
  const who = state.who ? peopleIndex()[state.who]?.name : "";
  const tab = (attr, val, label, on) => `<button data-${attr}="${val}" class="${on ? "on" : ""}">${label}</button>`;
  return `${tab("scope", "2028", "2028", state.scope === "2028")}${tab("scope", "all", "All mentions", state.scope === "all")}
    <i class="gap"></i>
    ${tab("party", "", "Both", !state.party)}${tab("party", "D", "D", state.party === "D")}${tab("party", "R", "R", state.party === "R")}
    ${who ? `<i class="gap"></i><button data-who="" class="on">${esc(who)} ×</button>` : ""}`;
}

function drawNews() {
  const tabs = app.querySelector(".news .tabs");
  const body = app.querySelector(".news .stories");
  if (!tabs || !body) return;
  tabs.innerHTML = newsTabs();
  body.innerHTML = newsBody();
}

const nav = (here) => `<nav class="nav"><a href="/" class="${here === "home" ? "on" : ""}">Boards</a><a href="/states" class="${here === "states" ? "on" : ""}">States</a><a href="/matchup" class="${here === "matchup" ? "on" : ""}">Matchup</a></nav>`;

function drawHome() {
  const b = state.board;
  document.title = "2028";
  const w = b.weights;
  app.innerHTML = `<header class="top">
      <a href="/"><h1>2028</h1></a>
      ${nav("home")}
      <span class="when">${stamp(b.updated)}</span>
    </header>
    <main class="home">
      <div class="boards-d">${boardHtml("D")}</div>
      <div class="boards-r">${boardHtml("R")}</div>
      <aside class="news"><header><h2>Headlines</h2><div class="tabs"></div></header><div class="stories"></div></aside>
    </main>
    <footer class="foot">Score: markets ${w.markets * 100}, polls ${w.polls * 100}, attention ${w.attention * 100} · + added beyond the original list · Polls: VoteHub, <a class="credit" href="https://en.wikipedia.org/wiki/Nationwide_opinion_polling_for_the_2028_Democratic_Party_presidential_primaries" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA)</footer>`;
  drawNews();
}

async function loadFeed(scope) {
  state.feed[scope] = await getJson(`/api/feed?scope=${scope === "all" ? "all" : "2028"}`);
}

async function home() {
  state.board = await getJson("/api/board");
  drawHome();
  await loadFeed(state.scope);
  drawNews();
}

// Only redraws when the data really changed, so scrolling and hover aren't disturbed.
async function refresh() {
  if (document.hidden || location.pathname !== "/") return;
  const fresh = await getJson("/api/board").catch(() => null);
  if (!fresh || fresh.updated === state.board?.updated) return;
  state.board = fresh;
  const scrollY = window.scrollY;
  const inner = app.querySelector(".stories")?.scrollTop ?? 0;
  drawHome();
  await loadFeed(state.scope).catch(() => {});
  drawNews();
  window.scrollTo(0, scrollY);
  const box = app.querySelector(".stories");
  if (box) box.scrollTop = inner;
}

// ---------- charts ----------

function niceMax(v) {
  if (v <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * unit >= v) return k * unit;
  return 10 * unit;
}
const compact = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));
const dayNum = (d) => Date.parse(`${d}T12:00:00Z`);

// One axis. series: [{ name, color, points: [[day, value, extraTooltip?]] , dots?, bars? }]
function chart(el, { series, height = 170, yMax, unit = "", from }) {
  const width = Math.max(el.clientWidth, 240);
  const pad = { l: 32, r: 8, t: 8, b: 18 };
  const live = series.map((s) => ({ ...s, points: s.points.filter((p) => !from || p[0] >= from) })).filter((s) => s.points.length);
  if (!live.length) {
    el.innerHTML = `<div class="none">No data</div>`;
    return;
  }
  const all = live.flatMap((s) => s.points);
  const x0 = Math.min(...all.map((p) => dayNum(p[0])));
  const x1 = Math.max(...all.map((p) => dayNum(p[0])), x0 + 864e5);
  const top = yMax ?? niceMax(Math.max(...all.map((p) => p[1])));
  const X = (d) => pad.l + ((dayNum(d) - x0) / (x1 - x0)) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);

  const grid = [0, top / 2, top].map((v) => `<line class="grid-line" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="label" x="${pad.l - 5}" y="${Y(v) + 3}" text-anchor="end">${compact(v)}${unit}</text>`).join("");
  const span = x1 - x0;
  const months = [];
  const step = span > 400 * 864e5 ? 3 : span > 150 * 864e5 ? 2 : 1;
  const c = new Date(x0);
  c.setUTCDate(1);
  c.setUTCMonth(c.getUTCMonth() + 1);
  while (c.getTime() <= x1) {
    if (c.getUTCMonth() % step === 0) months.push(c.getTime());
    c.setUTCMonth(c.getUTCMonth() + 1);
  }
  const xLabels = months.map((t) => {
    const px = pad.l + ((t - x0) / (x1 - x0)) * (width - pad.l - pad.r);
    const d = new Date(t);
    const label = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return `<text class="label" x="${px}" y="${height - 5}" text-anchor="middle">${label}</text>`;
  }).join("");

  const marks = live.map((s) => {
    if (s.dots) return s.points.map((p) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4" fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`).join("");
    if (s.bars) {
      const w = Math.max(1, ((width - pad.l - pad.r) / (span / 864e5)) * 0.8);
      return s.points.map((p) => `<rect x="${X(p[0]) - w / 2}" y="${Y(p[1])}" width="${w}" height="${Math.max(0, Y(0) - Y(p[1]))}" fill="${s.color}"/>`).join("");
    }
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
  }).join("");

  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" height="${height}" role="img">${grid}${xLabels}${marks}<line class="cross" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"/></svg>`;
  const cross = el.querySelector(".cross");
  const svg = el.querySelector("svg");
  const days = [...new Set(all.map((p) => p[0]))].sort();
  svg.addEventListener("mousemove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    let best = days[0];
    let dist = Infinity;
    for (const d of days) {
      const gap = Math.abs(X(d) - px);
      if (gap < dist) { dist = gap; best = d; }
    }
    cross.setAttribute("x1", X(best));
    cross.setAttribute("x2", X(best));
    cross.setAttribute("visibility", "visible");
    const lines = live.flatMap((s) => {
      const hits = s.points.filter((p) => p[0] === best);
      return hits.map((p) => `<span>${esc(p[2] ?? s.name)}</span><span>${compact(Math.round(p[1] * 10) / 10)}${unit}</span>`);
    }).join("");
    showTip(`<b>${shortDate(best)}</b><div class="kv">${lines}</div>`, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
}

// ---------- person ----------

const PLANS_A = /2028|presiden|white house/i;
const PLANS_B = /\b(run|runs|running|bid|campaign|weigh|weighs|weighing|consider|considers|considering|rule|rules|ruled|ruling|announce|announces|exploratory|committee|PAC|won.t|not running|eyeing|eyes|hints?)\b/i;

const person = { data: null, tab: "all", range: "all" };

function ageOf(p) {
  if (p.dob) {
    const now = new Date();
    const b = new Date(`${p.dob}T00:00:00Z`);
    let age = now.getUTCFullYear() - b.getUTCFullYear();
    if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) age--;
    if (Number.isFinite(age)) return age;
  }
  return p.list?.age ?? null;
}

function storiesHtml() {
  const { stories, posts } = person.data;
  const plans = stories.filter((s) => PLANS_A.test(s.title) && PLANS_B.test(s.title));
  const list = person.tab === "plans" ? plans : person.tab === "posts" ? posts : stories;
  const tab = (key, label, n) => `<button data-tab="${key}" class="${person.tab === key ? "on" : ""}">${label} ${n}</button>`;
  const seen = new Set();
  const rows = list.filter((s) => {
    const k = cleanTitle(s).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return `<div class="tabs" style="margin-bottom:4px">${tab("all", "Stories", stories.length)}${tab("plans", "About running", plans.length)}${tab("posts", "Own posts", posts.length)}</div>
    ${rows.length ? rows.map((s) => `<article class="story"><a href="${link(s.url)}" target="_blank" rel="noopener">${esc(cleanTitle(s))}</a><div class="meta"><span>${esc(s.source)}</span><span>${ago(s.published)}</span></div></article>`).join("") : `<div class="none">None</div>`}`;
}

function rangeFrom() {
  const last = person.data.person.series?.days.at(-1);
  if (!last || person.range === "all") return null;
  const n = person.range === "1m" ? 31 : person.range === "3m" ? 92 : 366;
  return new Date(dayNum(last) - n * 864e5).toISOString().slice(0, 10);
}

function drawCharts() {
  const p = person.data.person;
  const from = rangeFrom();
  const s = p.series;
  chart(app.querySelector("#c-score"), {
    height: 210, yMax: 100, from,
    series: [{ name: "Score", color: COLOR[p.party], points: s.days.map((d, i) => [d, s.score[i]]) }],
  });
  const asPct = (rows) => rows.map(([d, v]) => [d, v * 100]);
  chart(app.querySelector("#c-markets"), {
    unit: "%", from,
    series: [
      { name: "Polymarket", color: COLOR.poly, points: asPct(p.sources.poly) },
      { name: "Kalshi", color: COLOR.kalshi, points: asPct(p.sources.kalshi) },
    ],
  });
  chart(app.querySelector("#c-polls"), {
    unit: "%", from,
    series: [{ name: "Poll", color: COLOR[p.party], dots: true, points: p.polls.filter((x) => x.pct != null).map((x) => [x.end, x.pct, x.pollster]).reverse() }],
  });
  chart(app.querySelector("#c-wiki"), { from, series: [{ name: "Views", color: "#565b66", points: p.sources.wiki }] });
  chart(app.querySelector("#c-news"), { from, series: [{ name: "Stories", color: "#565b66", bars: true, points: p.sources.news }] });
}

function drawPerson(row) {
  const p = person.data.person;
  document.title = `${p.name} · 2028`;
  const st = p.status;
  const age = ageOf(p);
  const offered = p.polls.filter((x) => x.pct != null);
  const last = (a) => a?.at(-1) ?? null;
  const m = row?.m ?? last(p.series?.m);
  const pl = row?.p ?? last(p.series?.p);
  const a = row?.a ?? last(p.series?.a);
  const both = m != null && pl != null;
  const one = (m != null) !== (pl != null);
  const contrib = (v, w) => (v == null ? null : v * w);
  const mc = contrib(m, both ? 0.45 : 0.9);
  const pc = contrib(pl, both ? 0.45 : 0.9);
  const ac = contrib(a, 0.1);
  const total = [mc, pc, ac].reduce((n, v) => n + (v ?? 0), 0);
  const links = [
    p.wiki && `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(p.wiki.replaceAll(" ", "_"))}" target="_blank" rel="noopener">Wikipedia</a>`,
    p.x && `<a href="https://x.com/${esc(p.x)}" target="_blank" rel="noopener">X</a>`,
    p.bluesky && `<a href="https://bsky.app/profile/${esc(p.bluesky)}" target="_blank" rel="noopener">Bluesky</a>`,
    p.youtube && `<a href="https://www.youtube.com/channel/${esc(p.youtube)}" target="_blank" rel="noopener">YouTube</a>`,
    p.site && `<a href="${link(p.site)}" target="_blank" rel="noopener">Site</a>`,
  ].filter(Boolean).join("");
  const facts = [
    p.currently ?? p.list?.currently ?? p.desc,
    age != null ? `Age ${age}` : null,
    p.list?.born ? `Born ${p.list.born}` : null,
    p.list?.past_runs ? `Ran ${p.list.past_runs}` : null,
  ].filter(Boolean).map(esc).join(" · ");
  const rangeBtn = (key, label) => `<button data-range="${key}" class="${person.range === key ? "on" : ""}">${label}</button>`;

  app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a>${nav("")}<span class="when">${state.board ? stamp(state.board.updated) : ""}</span></header>
  <main class="person">
    <a class="back" href="/">← Boards</a>
    <div class="who-head">
      ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : "<div></div>"}
      <div>
        <h1><i class="swatch ${p.party}"></i>${esc(p.name)}</h1>
        <div class="facts">${facts}</div>
        <div class="status"><b>${STATUS[st.status]}</b>${st.date ? `<span class="d">${esc(st.date)}</span>` : ""}${st.url ? `<a href="${link(st.url)}" target="_blank" rel="noopener">${esc(st.headline)}</a>` : ""}</div>
        ${p.filings?.length ? `<div class="status"><b>Possible FEC match</b>${p.filings.map((f) => `<a href="https://www.fec.gov/data/candidate/${esc(f.id)}/" target="_blank" rel="noopener">${esc(f.name)}</a><span class="d">${esc(f.first_file ?? "")}</span>`).join(" ")}</div>` : ""}
        <div class="links">${links}</div>
      </div>
      <div class="big">
        <div class="n">${row ? (row.score >= 10 ? row.score.toFixed(0) : row.score.toFixed(1)) : "–"}</div>
        <div class="l">${row ? `#${row.rank} of ${state.board[p.party].rows.length} ${PARTY[p.party]}` : ""}</div>
      </div>
    </div>
    <div class="cols">
      <div>
        <section class="section"><h3>Score <span class="tabs right">${rangeBtn("1m", "1M")}${rangeBtn("3m", "3M")}${rangeBtn("1y", "1Y")}${rangeBtn("all", "All")}</span></h3><div class="chart" id="c-score"></div></section>
        <section class="section"><h3>Blend</h3>
          <table><thead><tr><th>Source</th><th class="r">Share</th><th class="r">Weight</th><th class="r">Points</th></tr></thead><tbody>
            <tr><td>Markets${m == null ? "" : ""}</td><td class="r mono">${m == null ? "–" : m.toFixed(2)}</td><td class="r mono">${m == null ? "–" : one ? "90" : "45"}</td><td class="r mono">${mc == null ? "–" : mc.toFixed(2)}</td></tr>
            <tr><td>Polls</td><td class="r mono">${pl == null ? "–" : pl.toFixed(2)}</td><td class="r mono">${pl == null ? "–" : one ? "90" : "45"}</td><td class="r mono">${pc == null ? "–" : pc.toFixed(2)}</td></tr>
            <tr><td>Attention</td><td class="r mono">${a == null ? "–" : a.toFixed(2)}</td><td class="r mono">10</td><td class="r mono">${ac == null ? "–" : ac.toFixed(2)}</td></tr>
            <tr class="total"><td>Total</td><td></td><td></td><td class="r mono">${total.toFixed(2)}</td></tr>
          </tbody></table>
        </section>
        <div class="minis">
          <section class="section"><h3>Markets</h3><div class="legend"><span><i style="background:${COLOR.poly}"></i>Polymarket ${row?.poly != null ? row.poly.toFixed(1) + "%" : ""}</span><span><i style="background:${COLOR.kalshi}"></i>Kalshi ${row?.kalshi != null ? row.kalshi.toFixed(1) + "%" : ""}</span></div><div class="chart" id="c-markets"></div></section>
          <section class="section"><h3>Polls <span class="right" style="font-weight:400;color:var(--ink2)">${offered.length} of ${p.polls.length} offered</span></h3><div class="legend"><span>&nbsp;</span></div><div class="chart" id="c-polls"></div></section>
          <section class="section"><h3>Wikipedia views</h3><div class="chart" id="c-wiki"></div></section>
          <section class="section"><h3>Stories per day</h3><div class="chart" id="c-news"></div></section>
        </div>
        ${p.statePolls?.length ? `<section class="section"><h3>State polls </h3><div class="scroll"><table><thead><tr><th>Ended</th><th>State</th><th>Pollster</th><th class="r">%</th><th class="r">Sample</th><th class="r">Names</th></tr></thead><tbody>
          ${p.statePolls.map((x) => `<tr><td class="mono">${esc(x.end)}</td><td class="mono">${esc(x.state)}</td><td>${x.url ? `<a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.pollster)}</a>` : esc(x.pollster)}</td><td class="r mono">${x.pct.toFixed(1)}</td><td class="r mono">${x.n || "–"}</td><td class="r mono">${x.field}</td></tr>`).join("")}
        </tbody></table></div></section>` : ""}
        <section class="section"><h3>Polls</h3><div class="scroll"><table><thead><tr><th>Ended</th><th>Pollster</th><th class="r">%</th><th class="r">Sample</th><th class="r">Names</th></tr></thead><tbody>
          ${offered.length ? offered.map((x) => `<tr><td class="mono">${esc(x.end)}</td><td>${x.url ? `<a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.pollster)}</a>` : esc(x.pollster)}${x.discounted ? " *" : ""}</td><td class="r mono">${x.pct.toFixed(1)}</td><td class="r mono">${x.n || "–"}</td><td class="r mono">${x.field}</td></tr>`).join("") : `<tr><td colspan="5" class="none">None</td></tr>`}
        </tbody></table></div></section>
      </div>
      <section class="section news-person" id="stories">${storiesHtml()}</section>
    </div>
  </main>
  <footer class="foot">State polls are not in the score · Polls: VoteHub, Wikipedia (CC BY-SA)</footer>`;
  drawCharts();
}

async function personPage(id) {
  person.data = null;
  person.tab = "all";
  person.range = "all";
  hideTip();
  app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a></header><main class="person"><div class="none">Loading</div></main>`;
  const [data, board] = await Promise.all([getJson(`/api/person/${encodeURIComponent(id)}`), state.board ?? getJson("/api/board")]);
  state.board = board;
  person.data = data;
  const row = board[data.person.party].rows.find((r) => r.id === id);
  drawPerson(row);
}

// ---------- states ----------

function stateBlock(party, code, data, date) {
  const name = data.names[code] ?? code;
  const when = date ? shortDate(date).replace(/, \d{4}$/, "") : "";
  const s = data[party][code];
  if (!s) {
    return `<section class="state empty"><h3>${esc(name)}<span class="right">${esc(when)}</span></h3><div class="none">No polls</div></section>`;
  }
  const max = Math.max(...s.top.map((t) => t.share), 1);
  const rows = s.top.map((t) => {
    const label = t.onRoster ? `<a href="/p/${t.id}">${esc(t.name)}</a>` : esc(t.name);
    return `<div class="srow"><span class="nm">${label}</span><span class="plot"><i class="bar" style="width:${((100 * t.share) / max).toFixed(1)}%"></i></span><span class="num sc">${t.share.toFixed(1)}</span></div>`;
  }).join("");
  const polls = s.polls.map((p) => `<tr><td class="mono">${esc(p.end)}</td><td>${p.url ? `<a href="${link(p.url)}" target="_blank" rel="noopener">${esc(p.pollster)}</a>` : esc(p.pollster)}</td><td>${p.top.map((t) => `${esc(t.name.endsWith("Jr.") ? t.name.split(" ").slice(-2).join(" ") : t.name.split(" ").at(-1))} ${t.pct}`).join(", ")}</td><td class="r mono">${p.n || "–"}</td></tr>`).join("");
  return `<section class="state"><h3>${esc(name)}<span class="right">${esc(when)}${when ? " · " : ""}${s.count} ${s.count === 1 ? "poll" : "polls"} · ${esc(s.latest)}</span></h3>
    ${rows}
    <table class="spolls"><thead><tr><th>Ended</th><th>Pollster</th><th>Top 3 (%)</th><th class="r">Sample</th></tr></thead><tbody>${polls}</tbody></table></section>`;
}

function statesColumn(party, data) {
  const early = data.early[party];
  const earlySet = new Set(early.map((e) => e.state));
  const others = Object.keys(data[party]).filter((c) => !earlySet.has(c)).sort((a, b) => (data.names[a] < data.names[b] ? -1 : 1));
  return `<section class="board ${party}">
    <h2><i class="swatch"></i>${PARTY[party]}</h2>
    <h4 class="group">Early states</h4>
    ${early.map((e) => stateBlock(party, e.state, data, e.date)).join("")}
    <h4 class="group">Other states</h4>
    ${others.map((c) => stateBlock(party, c, data)).join("")}
  </section>`;
}

async function statesPage() {
  document.title = "States · 2028";
  const data = await getJson("/api/states");
  app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a>${nav("states")}<span class="when">${stamp(data.updated)}</span></header>
    <main class="states">${statesColumn("D", data)}${statesColumn("R", data)}</main>
    <footer class="foot">State polls are not in the score · Shares exclude undecided · Polls: <a class="credit" href="https://en.wikipedia.org/wiki/Statewide_opinion_polling_for_the_2028_Democratic_Party_presidential_primaries" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA)</footer>`;
}

// ---------- matchup ----------

const DRAWS = 100000;
const WORKER_PATIENCE_MS = 5000;
const match = { model: null, map: null, dem: null, rep: null, cache: new Map(), worker: null, waiting: null };
const SHADE = [[0.9, "#1f4f96"], [0.7, "#5a8bd0"], [0.55, "#aac4e8"], [0.45, "#e4e5e8"], [0.3, "#f0b7ae"], [0.1, "#d9705f"], [0, "#b2331f"]];
const shadeOf = (p) => SHADE.find(([min]) => p >= min)[1];
const signed = (x, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`;
const leanText = (x) => (Math.abs(x) < 0.05 ? "Even" : x > 0 ? `D+${x.toFixed(1)}` : `R+${(-x).toFixed(1)}`);
const lastName = (name) => (name.endsWith("Jr.") ? name.split(" ").slice(-2).join(" ") : name.split(" ").at(-1));

// Runs off the page's thread, so the page stays responsive. If the browser can't, or the
// background thread doesn't answer, it runs here instead: slower to paint, same result.
const answers = new Map();

function startWorker() {
  if (match.worker) return match.worker;
  match.worker = new Worker("/simworker.js?v=12", { type: "module" });
  match.worker.onmessage = ({ data }) => answers.get(data.key)?.(data.result);
  match.worker.onerror = (e) => {
    console.error("simulation thread", e.message);
    match.worker = null;
    for (const retry of answers.values()) retry(null);
  };
  return match.worker;
}

function simulateMatchup(key, params) {
  const seed = hashSeed(`${key}|${match.model.updated}`);
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      answers.delete(key);
      // Nobody is waiting on a pick the person has already moved past.
      if (result || match.waiting !== key) resolve(result);
      else resolve(simulate(params, DRAWS, seed));
    };
    const timer = setTimeout(() => finish(null), WORKER_PATIENCE_MS);
    answers.set(key, finish);
    try {
      startWorker().postMessage({ key, params, draws: DRAWS, seed });
    } catch (err) {
      console.error("simulation thread", err);
      finish(null);
    }
  });
}

function pickerHtml(party, chosen) {
  const rows = state.board[party].rows;
  const options = rows.map((r) => {
    const flag = match.model.people[r.id]?.ineligible ? " (ineligible)" : "";
    return `<option value="${r.id}"${r.id === chosen ? " selected" : ""}>${r.rank}. ${esc(r.name)}${flag}</option>`;
  }).join("");
  return `<label class="pick ${party}"><i class="swatch"></i><select data-pick="${party}">${options}</select></label>`;
}

function evChart(r, dem, rep) {
  const bins = [];
  for (let e = 0; e <= 530; e += 10) bins.push({ from: e, count: r.evHist.slice(e, e + 10).reduce((a, b) => a + b, 0) });
  const max = Math.max(...bins.map((b) => b.count)) || 1;
  const W = 760;
  const H = 150;
  const x = (ev) => 4 + (ev / 540) * (W - 8);
  const bars = bins.map((b) => {
    const h = (b.count / max) * (H - 24);
    const fill = b.from + 5 >= 270 ? "var(--D)" : "var(--R)";
    return `<rect class="evbar" data-tip="${b.from}-${b.from + 9}|${((100 * b.count) / DRAWS).toFixed(1)}" x="${x(b.from).toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${Math.max(1, x(10) - x(0) - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`;
  }).join("");
  const labels = [0, 100, 200, 270, 400, 538].map((v) => `<text class="label" x="${x(v)}" y="${H - 5}" text-anchor="middle">${v}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Electoral votes for ${esc(dem.name)} across all simulations">${bars}<line x1="${x(270)}" x2="${x(270)}" y1="0" y2="${H - 18}" stroke="var(--ink)" stroke-width="1"/>${labels}</svg>`;
}

function mapHtml(r) {
  const byId = new Map(r.states.map((s) => [s.id, s]));
  const paths = Object.entries(match.map.states).map(([id, g]) => {
    const s = byId.get(id);
    if (!s) return "";
    return `<path class="st-map" data-state="${id}" d="${g.d}" fill="${shadeOf(s.demWin)}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${match.map.w} ${match.map.h}" role="img" aria-label="Win chance by state">${paths}</svg>`;
}

function drawMatchup(result, built) {
  const { model } = match;
  const dem = model.people[match.dem];
  const rep = model.people[match.rep];
  const statesById = new Map(model.map.contests.map((c) => [c.id, c]));
  const box = app.querySelector("#mresult");
  if (!result) {
    box.innerHTML = `<div class="none">Simulating</div>`;
    return;
  }
  const rowOf = (party, id) => state.board[party].rows.find((x) => x.id === id);
  const chance = (rowOf("D", match.dem)?.m ?? 0) * (rowOf("R", match.rep)?.m ?? 0) / 1e4;
  const tips = [...result.states].sort((a, b) => b.tip - a.tip).slice(0, 9);
  const flags = (p) => [p.depth === 0 ? "Thin data" : "", p.ineligible ?? ""].filter(Boolean).map((t) => `<span class="flag">${esc(t)}</span>`).join("");
  const partRow = (p, top) => `<tr class="${top ? "ptop" : "psub"}"><td>${esc(p.label)}</td><td class="r mono">${signed(p.value, 2)}</td></tr>`;
  const piecesOf = (pieces, sign) => (pieces ?? []).map((x) => partRow({ label: x.label, value: sign * x.value }, false)).join("");
  const parts = built.parts.map((p) => partRow(p, true) + piecesOf(p.pieces, p.against ? -1 : 1)).join("");
  const home = (id, who) => (who.home?.includes(statesById.get(id)?.parentId) ? ` (${esc(lastName(who.name))} home)` : "");

  const pollRow = (m) => `<tr><td class="mono">${esc(m.end)}</td><td>${m.url ? `<a href="${link(m.url)}" target="_blank" rel="noopener">${esc(m.pollster)}</a>` : esc(m.pollster)}</td><td>${esc(m.state ?? "National")}${m.third ? ` · with ${esc(m.third)}` : ""}</td><td class="r mono">${m.demPct}</td><td class="r mono">${m.repPct}</td><td class="r mono">${m.n ? m.n.toLocaleString() : "–"}</td></tr>`;
  const related = built.polls.length ? [] : model.matchups.filter((m) => (m.dem === match.dem || m.rep === match.rep) && !m.state && !m.third).slice(0, 10);
  const relatedRow = (m) => `<tr><td class="mono">${esc(m.end)}</td><td>${m.url ? `<a href="${link(m.url)}" target="_blank" rel="noopener">${esc(m.pollster)}</a>` : esc(m.pollster)}</td><td>${esc(lastName(model.people[m.dem]?.name ?? m.dem))} ${m.demPct}, ${esc(lastName(model.people[m.rep]?.name ?? m.rep))} ${m.repPct}</td><td class="r mono">${m.n ? m.n.toLocaleString() : "–"}</td></tr>`;
  const legend = SHADE.map(([min, c], i) => {
    const top = i === 0 ? 100 : Math.round(SHADE[i - 1][0] * 100);
    return `<span><i style="background:${c}"></i>${Math.round(min * 100)}–${top}</span>`;
  }).join("");
  const districts = result.states.filter((s) => s.id.includes("-")).map((s) => `<span>${esc(s.id)} ${Math.round(100 * s.demWin)}%</span>`).join("");

  box.innerHTML = `
    <div class="mtop">
      <div class="D"><div class="mname">${esc(dem.name)} ${flags(dem)}</div><div class="mbig">${(100 * result.demWin).toFixed(1)}%</div><div class="msub">${result.evMedian} electoral votes</div></div>
      <div class="R right"><div class="mname">${flags(rep)} ${esc(rep.name)}</div><div class="mbig">${(100 * result.repWin).toFixed(1)}%</div><div class="msub">${538 - result.evMedian} electoral votes</div></div>
    </div>
    <div class="msplit"><i style="width:${(100 * result.demWin).toFixed(2)}%;background:var(--D)"></i><i style="flex:1;background:var(--R)"></i></div>
    <div class="mstats">
      <span>Popular vote <b>${leanText(result.popularMedian)}</b> (${leanText(result.popularLow)} to ${leanText(result.popularHigh)})</span>
      <span>Electoral range <b>${result.evLow}–${result.evHigh}</b></span>
      <span>Tie <b>${(100 * result.tie).toFixed(1)}%</b></span>
      <span>Market chance of this matchup <b>${(100 * chance).toFixed(1)}%</b></span>
      ${model.mood.modelShare != null && model.mood.marketShare != null ? `<span>Democrats across likely pairings: model <b>${(100 * model.mood.modelShare).toFixed(0)}%</b>, party markets <b>${(100 * model.mood.marketShare).toFixed(0)}%</b></span>` : ""}
    </div>
    <div class="mcols">
      <div>
        <section class="section"><h3>${esc(lastName(dem.name))} electoral votes</h3><div class="chart" id="evchart">${evChart(result, dem, rep)}</div></section>
        <section class="section"><h3>${esc(lastName(dem.name))} win chance by state</h3><div class="mapwrap">${mapHtml(result)}</div><div class="mlegend">${legend}</div><div class="mdist">${districts}</div></section>
      </div>
      <div>
        <section class="section"><h3>States most likely to decide it</h3><table><thead><tr><th>State</th><th class="r">Votes</th><th class="r">${esc(lastName(dem.name))} %</th><th class="r">Margin</th><th class="r">Decides %</th></tr></thead><tbody>
          ${tips.map((s) => `<tr><td>${esc(statesById.get(s.id)?.name ?? s.id)}${home(s.id, dem)}${home(s.id, rep)}</td><td class="r mono">${s.ev}</td><td class="r mono">${(100 * s.demWin).toFixed(0)}</td><td class="r mono">${leanText(s.margin)}</td><td class="r mono">${(100 * s.tip).toFixed(1)}</td></tr>`).join("")}
        </tbody></table></section>
        <section class="section"><h3>What went in <span class="right mnote">Points toward ${esc(lastName(dem.name))}</span></h3><table class="parts"><tbody>${parts}</tbody></table></section>
      </div>
    </div>
    <section class="section"><h3>Polls of this matchup <span class="right mnote">${built.polls.length}</span></h3>
      ${built.polls.length ? `<div class="scroll"><table><thead><tr><th>Ended</th><th>Pollster</th><th>Where</th><th class="r">${esc(lastName(dem.name))}</th><th class="r">${esc(lastName(rep.name))}</th><th class="r">Sample</th></tr></thead><tbody>${built.polls.map(pollRow).join("")}</tbody></table></div>` : `<div class="none">None</div>`}
    </section>
    ${related.length ? `<section class="section"><h3>Their polls against others</h3><div class="scroll"><table><thead><tr><th>Ended</th><th>Pollster</th><th>Result</th><th class="r">Sample</th></tr></thead><tbody>${related.map(relatedRow).join("")}</tbody></table></div></section>` : ""}`;
  match.lastResult = result;
}

async function runMatchup() {
  const key = `${match.dem}|${match.rep}`;
  const built = buildMatchup(match.model, match.dem, match.rep);
  drawMatchup(match.cache.get(key) ?? null, built);
  if (match.cache.has(key)) return;
  match.waiting = key;
  const result = await simulateMatchup(key, built.params);
  if (result) match.cache.set(key, result);
  if (result && match.waiting === key) drawMatchup(result, built);
}

async function matchupPage(demId, repId) {
  document.title = "Matchup · 2028";
  const [model, board, map] = await Promise.all([
    match.model ?? getJson("/api/model"),
    state.board ?? getJson("/api/board"),
    match.map ?? getJson("/us-map.json"),
  ]);
  Object.assign(match, { model, map });
  state.board = board;
  const known = (id, party) => model.people[id]?.party === party && board[party].rows.some((r) => r.id === id);
  match.dem = known(demId, "D") ? demId : board.D.rows[0].id;
  match.rep = known(repId, "R") ? repId : board.R.rows[0].id;
  app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a>${nav("matchup")}<span class="when">${stamp(model.updated)}</span></header>
    <main class="matchup">
      <div class="mpicks">${pickerHtml("D", match.dem)}<span class="mvs">vs</span>${pickerHtml("R", match.rep)}</div>
      <div id="mresult"></div>
    </main>
    <footer class="foot">If these two are the nominees · ${DRAWS.toLocaleString()} simulated elections · National mood ${leanText(model.mood.center)} · Polls: <a class="credit" href="https://en.wikipedia.org/wiki/2028_United_States_presidential_election" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA)</footer>`;
  await runMatchup();
}

// ---------- events and routing ----------

async function route() {
  hideTip();
  const onPerson = location.pathname.match(/^\/p\/([^/]+)/);
  const onMatchup = location.pathname.match(/^\/matchup(?:\/([^/]+)\/([^/]+))?\/?$/);
  try {
    if (onPerson) await personPage(decodeURIComponent(onPerson[1]));
    else if (onMatchup) await matchupPage(onMatchup[1], onMatchup[2]);
    else if (location.pathname === "/states") await statesPage();
    else await home();
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a></header><div class="person none">Data unavailable</div>`;
  }
}

document.addEventListener("click", async (e) => {
  const scope = e.target.closest("[data-scope]");
  const party = e.target.closest("[data-party]");
  const who = e.target.closest("[data-who]");
  const tab = e.target.closest("[data-tab]");
  const range = e.target.closest("[data-range]");
  if (scope) {
    state.scope = scope.dataset.scope;
    drawNews();
    if (!state.feed[state.scope]) {
      await loadFeed(state.scope);
      drawNews();
    }
    return;
  }
  if (party) { state.party = party.dataset.party; drawNews(); return; }
  if (who) {
    state.who = who.dataset.who;
    drawNews();
    if (state.who && !state.personFeed.has(state.who)) {
      state.personFeed.set(state.who, await getJson(`/api/feed?person=${encodeURIComponent(state.who)}`).catch(() => []));
      drawNews();
    }
    return;
  }
  if (tab) {
    person.tab = tab.dataset.tab;
    app.querySelector("#stories").innerHTML = storiesHtml();
    return;
  }
  if (range) {
    person.range = range.dataset.range;
    range.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === range));
    drawCharts();
    return;
  }
  const link = e.target.closest("a[href^='/']");
  if (link && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    history.pushState(null, "", link.getAttribute("href"));
    route();
  }
});

document.addEventListener("change", (e) => {
  const pick = e.target.closest?.("[data-pick]");
  if (!pick) return;
  if (pick.dataset.pick === "D") match.dem = pick.value;
  else match.rep = pick.value;
  history.replaceState(null, "", `/matchup/${match.dem}/${match.rep}`);
  runMatchup();
});

document.addEventListener("mousemove", (e) => {
  const stateShape = e.target.closest?.(".st-map");
  if (stateShape && match.lastResult) {
    const s = match.lastResult.states.find((x) => x.id === stateShape.dataset.state);
    const c = match.model.map.contests.find((x) => x.id === s.id);
    showTip(`<b>${esc(c.name)}</b><div class="kv"><span>${esc(lastName(match.model.people[match.dem].name))}</span><span>${(100 * s.demWin).toFixed(1)}%</span><span>Margin</span><span>${leanText(s.margin)}</span><span>Votes</span><span>${s.ev}</span><span>Decides</span><span>${(100 * s.tip).toFixed(1)}%</span></div>`, e.clientX, e.clientY);
    return;
  }
  const evBar = e.target.closest?.(".evbar");
  if (evBar) {
    const [range, pct] = evBar.dataset.tip.split("|");
    showTip(`<b>${range} electoral votes</b><div class="kv"><span>Simulations</span><span>${pct}%</span></div>`, e.clientX, e.clientY);
    return;
  }
  const row = e.target.closest?.(".row");
  if (!row) {
    if (!e.target.closest?.(".chart svg")) hideTip();
    return;
  }
  const lookup = state.board && [...state.board.D.rows, ...state.board.R.rows].find((r) => r.id === row.dataset.id);
  if (!lookup) return;
  const v = (x, s = "%") => (x == null ? "–" : `${x.toFixed(1)}${s}`);
  showTip(`<b>${esc(lookup.name)}</b><div class="kv">
    <span>Score</span><span>${lookup.score.toFixed(1)}</span>
    <span>7d score</span><span>${lookup.d7 == null ? "–" : (lookup.d7 > 0 ? "+" : "") + lookup.d7.toFixed(1)}</span>
    <span>Polymarket</span><span>${v(lookup.poly)}</span>
    <span>Kalshi</span><span>${v(lookup.kalshi)}</span>
    <span>Polls</span><span>${v(lookup.p)}</span>
    <span>Attention</span><span>${v(lookup.a)}</span>
    <span>Status</span><span>${STATUS[lookup.status]}</span>
  </div>`, e.clientX, e.clientY);
});

window.addEventListener("popstate", route);
window.addEventListener("resize", () => { if (person.data && location.pathname.startsWith("/p/")) drawCharts(); });

setInterval(refresh, REFRESH_MS);
document.addEventListener("visibilitychange", refresh);
route();
