const app = document.getElementById("app");
const tip = document.getElementById("tip");
const TZ = "America/Chicago";

const STATUS = { mentioned: "Mentioned", said_no: "Said no", exploring: "Exploring", building: "Building", declared: "Declared", out: "Out" };
const PARTY = { D: "Democrats", R: "Republicans" };
const COLOR = { D: "#2b63b5", R: "#c8402f", poly: "#00856b", kalshi: "#c26a12" };
const REFRESH_MS = 5 * 60 * 1000;

const state = { board: null, feed: { 2028: null, all: null }, scope: "2028", party: "", who: "", timer: null };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

function rowHtml(r, xMax) {
  const at = (v) => (v == null ? null : (100 * v) / xMax);
  const m = at(r.m);
  const p = at(r.p);
  const rise = r.r7 == null ? "" : r.r7 > 0 ? `▲${r.r7}` : r.r7 < 0 ? `▼${-r.r7}` : "=";
  return `<a class="row grid${r.thin ? " thin" : ""}" href="/p/${r.id}" data-id="${r.id}">
    <span class="rk">${r.rank}</span>
    <span class="nm">${esc(r.name)}${r.on_list ? "" : "<sup>+</sup>"}</span>
    <span class="st ${r.status}">${STATUS[r.status]}</span>
    <span class="plot">
      <i class="bar" style="width:${at(r.blend).toFixed(1)}%"></i>
      ${m != null && p != null ? `<i class="span" style="left:${Math.min(m, p).toFixed(1)}%;width:${Math.abs(m - p).toFixed(1)}%"></i>` : ""}
      ${m != null ? `<i class="m" style="left:${m.toFixed(1)}%"></i>` : ""}
      ${p != null ? `<i class="p" style="left:${p.toFixed(1)}%"></i>` : ""}
    </span>
    <span class="num sc">${r.score >= 10 ? r.score.toFixed(0) : r.score.toFixed(1)}</span>
    <span class="num src${r.m == null ? " nil" : ""}">${fmt1(r.m)}</span>
    <span class="num src${r.p == null ? " nil" : ""}">${fmt1(r.p)}</span>
    <span class="chg${r.r7 === 0 ? " flat" : ""}">${rise}</span>
  </a>`;
}

function boardHtml(party) {
  const { rows } = state.board[party];
  const xMax = Math.max(...rows.map((r) => Math.max(r.blend ?? 0, r.m ?? 0, r.p ?? 0))) || 1;
  return `<section class="board ${party}">
    <h2><i class="swatch"></i>${PARTY[party]}</h2>
    <div class="grid head">
      <span></span><span></span><span class="st-h">Status</span>
      <span class="key"><span><i class="m"></i>Mkts</span><span><i class="p"></i>Polls</span></span>
      <span class="num">Score</span><span class="num">Mkts</span><span class="num">Polls</span><span class="num">7d</span>
    </div>
    ${rows.map((r) => rowHtml(r, xMax)).join("")}
  </section>`;
}

const TALK = /presiden|white house|nominee|nomination|primary|primaries|caucus|2028 (run|bid|race|field|contender|hopeful|campaign|ticket|speculation|talk|chatter|buzz|field)/i;
const cleanTitle = (s) => s.title.replace(/\s+-\s+[^-]{2,60}$/, "");

function visibleStories() {
  const rows = state.feed[state.scope] ?? [];
  const lookup = peopleIndex();
  const seen = new Set();
  const out = [];
  for (const s of rows) {
    const people = JSON.parse(s.people ?? "[]");
    if (state.scope === "2028" && !(s.title.includes("2028") || (s.text ?? "").includes("2028")) ) continue;
    if (state.scope === "2028" && !TALK.test(`${s.title} ${s.text ?? ""}`)) continue;
    if (state.who && !people.includes(state.who)) continue;
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
  return `<article class="story"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(cleanTitle(s))}</a>
    <div class="meta"><span>${esc(s.source)}</span><span>${ago(s.published)}</span>${chips}</div></article>`;
}

function newsBody() {
  const lookup = peopleIndex();
  if (!state.feed[state.scope]) return `<div class="none">Loading</div>`;
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

function drawHome() {
  const b = state.board;
  document.title = "2028";
  const w = b.weights;
  app.innerHTML = `<header class="top">
      <a href="/"><h1>2028</h1></a>
      <span class="blend">Mkts ${w.markets * 100} · Polls ${w.polls * 100} · Attention ${w.attention * 100}</span>
      <span class="blend">+ added</span>
      <span class="blend">Polls: VoteHub, <a class="credit" href="https://en.wikipedia.org/wiki/Nationwide_opinion_polling_for_the_2028_Democratic_Party_presidential_primaries" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA)</span>
      <span class="when">${stamp(b.updated)}</span>
    </header>
    <main class="home">
      <div class="boards-d">${boardHtml("D")}</div>
      <div class="boards-r">${boardHtml("R")}</div>
      <aside class="news"><header><h2>Headlines</h2><div class="tabs"></div></header><div class="stories"></div></aside>
    </main>`;
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
    ${rows.length ? rows.map((s) => `<article class="story"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(cleanTitle(s))}</a><div class="meta"><span>${esc(s.source)}</span><span>${ago(s.published)}</span></div></article>`).join("") : `<div class="none">None</div>`}`;
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
    p.site && `<a href="${esc(p.site)}" target="_blank" rel="noopener">Site</a>`,
  ].filter(Boolean).join("");
  const facts = [
    p.list?.currently ?? p.desc,
    age != null ? `Age ${age}` : null,
    p.list?.born ? `Born ${p.list.born}` : null,
    p.list?.past_runs ? `Ran ${p.list.past_runs}` : null,
  ].filter(Boolean).map(esc).join(" · ");
  const rangeBtn = (key, label) => `<button data-range="${key}" class="${person.range === key ? "on" : ""}">${label}</button>`;

  app.innerHTML = `<header class="top"><a href="/"><h1>2028</h1></a><span class="when">${state.board ? stamp(state.board.updated) : ""}</span></header>
  <main class="person">
    <a class="back" href="/">← Boards</a>
    <div class="who-head">
      ${p.photo ? `<img src="${esc(p.photo)}" alt="">` : "<div></div>"}
      <div>
        <h1><i class="swatch ${p.party}"></i>${esc(p.name)}</h1>
        <div class="facts">${facts}</div>
        <div class="status"><b>${STATUS[st.status]}</b>${st.date ? `<span class="d">${esc(st.date)}</span>` : ""}${st.url ? `<a href="${esc(st.url)}" target="_blank" rel="noopener">${esc(st.headline)}</a>` : ""}</div>
        ${p.filings?.length ? `<div class="status"><b>FEC</b>${p.filings.map((f) => `<a href="https://www.fec.gov/data/candidate/${esc(f.id)}/" target="_blank" rel="noopener">${esc(f.name)}</a><span class="d">${esc(f.first_file ?? "")}</span>`).join(" ")}</div>` : ""}
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
        <section class="section"><h3>Polls <span class="right" style="font-weight:400;color:var(--ink2)">VoteHub, Wikipedia (CC BY-SA)</span></h3><div class="scroll"><table><thead><tr><th>Ended</th><th>Pollster</th><th class="r">%</th><th class="r">Sample</th><th class="r">Names</th></tr></thead><tbody>
          ${offered.length ? offered.map((x) => `<tr><td class="mono">${esc(x.end)}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.pollster)}</a>` : esc(x.pollster)}${x.discounted ? " *" : ""}</td><td class="r mono">${x.pct.toFixed(1)}</td><td class="r mono">${x.n || "–"}</td><td class="r mono">${x.field}</td></tr>`).join("") : `<tr><td colspan="5" class="none">None</td></tr>`}
        </tbody></table></div></section>
      </div>
      <section class="section news-person" id="stories">${storiesHtml()}</section>
    </div>
  </main>`;
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

// ---------- events and routing ----------

async function route() {
  hideTip();
  const match = location.pathname.match(/^\/p\/([^/]+)/);
  try {
    if (match) await personPage(decodeURIComponent(match[1]));
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
  if (who) { state.who = who.dataset.who; drawNews(); return; }
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

document.addEventListener("mousemove", (e) => {
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
