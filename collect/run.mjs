// The collector. GitHub Actions runs this hourly; everything goes to the Worker.
// TASKS=markets,feeds overrides the schedule, TASKS=all runs everything.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildMatcher, fold, slug } from "./names.mjs";

const { INGEST_URL, INGEST_KEY } = process.env;
if (!INGEST_URL || !INGEST_KEY) throw new Error("INGEST_URL and INGEST_KEY are required");

const roster = JSON.parse(readFileSync("data/roster.json", "utf8"));
const feeds = JSON.parse(readFileSync("data/feeds.json", "utf8")).feeds;
const matchPeople = buildMatcher(roster);

const now = new Date();
const stamp = now.toISOString();
const today = stamp.slice(0, 10);
const hourKey = stamp.slice(0, 13);
const hour = now.getUTCHours();

const BACKFILL_ROWS = +(process.env.BACKFILL_ROWS ?? 35000); // two runs a day stay well under D1's 100,000 writes
const HISTORY_START = "2024-11-06"; // the day after the last presidential election
// Wikimedia allows 200 requests a minute only with a contactable User-Agent, and about 10 without.
const UA = { "user-agent": "pres28-collector/1.0 (https://github.com/austinzeglis/pres28)" };
const WIKI_PACE_MS = 400; // 150 a minute

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- plumbing ----------

async function get(url, { timeout = 15000, headers = UA, tries = 2 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let wait = 1500 * attempt;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      if (res.ok) return res;
      if (attempt >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status}`);
      const after = +res.headers.get("retry-after");
      if (after > 0) wait = Math.min(after, 65) * 1000;
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    await sleep(wait);
  }
}
const getJson = async (url, opts) => (await get(url, opts)).json();
const getText = async (url, opts) => (await get(url, opts)).text();

async function pool(items, size, work) {
  const queue = items.entries();
  const worker = async () => {
    for (const [i, item] of queue) await work(item, i);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

async function send(table, rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += 100) batches.push(rows.slice(i, i + 100));
  let written = 0;
  await pool(batches, 4, async (batch) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${INGEST_URL}/ingest/${table}`, {
        method: "POST",
        headers: { authorization: `Bearer ${INGEST_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ rows: batch }),
        signal: AbortSignal.timeout(30000),
      }).catch((err) => ({ ok: false, status: err.message }));
      if (res.ok) {
        written += (await res.json()).written;
        return;
      }
      if (attempt >= 4) throw new Error(`ingest ${table}: ${res.status}`);
      await sleep(2000 * attempt);
    }
  });
  return written;
}

const report = [];
async function task(source, work) {
  const started = Date.now();
  let row;
  try {
    const { rows = 0, note = "" } = (await work()) ?? {};
    row = { ts: stamp, source, ok: 1, rows_sent: rows, note: `${note} ${Math.round((Date.now() - started) / 1000)}s`.trim() };
  } catch (err) {
    row = { ts: stamp, source, ok: 0, rows_sent: 0, note: String(err.message ?? err).slice(0, 300) };
  }
  report.push(row);
  console.log(`${row.ok ? "ok  " : "FAIL"} ${source}: ${row.rows_sent} rows; ${row.note}`);
  await send("runs", [row]).catch((err) => console.log(`could not record run: ${err.message}`));
}

// ---------- markets ----------

const POLY = [
  { source: "poly_nom_D", slug: "democratic-presidential-nominee-2028" },
  { source: "poly_nom_R", slug: "republican-presidential-nominee-2028" },
  { source: "poly_win", slug: "presidential-election-winner-2028" },
];
const KALSHI = [
  { source: "kalshi_nom_D", series: "KXPRESNOMD" },
  { source: "kalshi_nom_R", series: "KXPRESNOMR" },
  { source: "kalshi_win", series: "KXPRESPERSON" },
];
const markets = { poly: [], kalshi: [] };

async function loadPoly() {
  for (const m of POLY) {
    const [event] = await getJson(`https://gamma-api.polymarket.com/events?slug=${m.slug}`);
    if (!event) throw new Error(`no Polymarket event ${m.slug}`);
    for (const x of event.markets) {
      const name = x.groupItemTitle ?? "";
      const volume = +(x.volume ?? 0);
      // Unused slots are named "Person X", and dead markets can show stale prices.
      if (/^Person [A-Z]+$/.test(name) || !name || volume <= 0 || x.active === false || x.closed) continue;
      markets.poly.push({
        source: m.source,
        person: slug(name),
        name,
        value: +JSON.parse(x.outcomePrices)[0],
        volume,
        token: JSON.parse(x.clobTokenIds)[0],
      });
    }
  }
}

async function loadKalshi() {
  for (const m of KALSHI) {
    const data = await getJson(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${m.series}&with_nested_markets=true&limit=20`);
    const event = data.events?.find((e) => e.event_ticker.endsWith("-28"));
    if (!event) throw new Error(`no Kalshi event for ${m.series}`);
    for (const x of event.markets) {
      const name = x.yes_sub_title ?? "";
      const bid = +(x.yes_bid_dollars ?? 0);
      const ask = +(x.yes_ask_dollars ?? 0);
      const last = +(x.last_price_dollars ?? 0);
      const volume = +(x.volume_fp ?? 0);
      const value = bid > 0 && ask > 0 && ask < 1 ? (bid + ask) / 2 : last;
      if (!name || (value <= 0 && volume <= 0)) continue;
      markets.kalshi.push({ source: m.source, series: m.series, ticker: x.ticker, person: slug(name), name, value, volume });
    }
  }
}

const marketRow = (m) => ({ person: m.person, source: m.source, ts: hourKey, value: m.value, volume: m.volume });

async function taskPolymarket() {
  await loadPoly();
  const rows = markets.poly.map(marketRow);
  await send("obs", rows);
  return { rows: rows.length };
}

async function taskKalshi() {
  await loadKalshi();
  const rows = markets.kalshi.map(marketRow);
  await send("obs", rows);
  return { rows: rows.length };
}

// ---------- headlines ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    });
const clean = (s) => decode(decode(s ?? "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block, name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1];

function parseFeed(xml) {
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []).map((b) => {
    const guid = tag(b, "guid");
    const link =
      clean(tag(b, "link")) ||
      b.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i)?.[1] ||
      b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ||
      (guid && /^https?:/.test(clean(guid)) ? clean(guid) : "");
    const date = clean(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date"));
    const parsed = date ? new Date(date) : null;
    return {
      title: clean(tag(b, "title")),
      url: decode(link),
      published: parsed && !isNaN(parsed) ? parsed.toISOString() : null,
      text: clean(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "media:description")).slice(0, 400),
      source: clean(tag(b, "source")),
    };
  });
}

const itemId = (url) => createHash("sha1").update(url).digest("hex").slice(0, 20);
const TOPIC = /\b2028\b/;
const TOPIC_WORDS = /presiden|primar|nomin|candidate|contender|hopeful|white house|campaign|caucus|ticket|\bbid\b|\brun\b|running/i;

function toItem(raw, kind, source, forced = []) {
  if (!raw.title || !raw.url) return null;
  const people = [...new Set([...forced, ...matchPeople(raw.title, raw.text)])];
  const all = fold(`${raw.title} ${raw.text}`);
  if (!people.length && !(TOPIC.test(all) && TOPIC_WORDS.test(all))) return null;
  return {
    id: itemId(raw.url),
    kind,
    source: raw.source || source,
    title: raw.title.slice(0, 400),
    url: raw.url.slice(0, 1000),
    published: raw.published,
    seen: stamp,
    people: JSON.stringify(people),
    text: raw.text,
  };
}

const recent = (raw, days) => !raw.published || now - new Date(raw.published) < days * 864e5;

async function taskFeeds() {
  const items = new Map();
  const failed = [];
  await pool(feeds, 30, async (feed) => {
    try {
      const xml = await getText(feed.url, { timeout: 8000, tries: 1, headers: { "user-agent": "Mozilla/5.0 pres28-collector/1.0" } });
      for (const raw of parseFeed(xml)) {
        if (!recent(raw, 3)) continue;
        const it = toItem(raw, "feed", feed.name);
        if (it) items.set(it.id, it);
      }
    } catch {
      failed.push(feed.name);
    }
  });
  const rows = [...items.values()];
  await send("items", rows);
  if (failed.length > feeds.length / 2) throw new Error(`${failed.length}/${feeds.length} feeds failed`);
  return { rows: rows.length, note: `${feeds.length - failed.length}/${feeds.length} feeds ok` };
}

const GENERAL_QUERIES = ['"2028" presidential run', '"2028" Democratic primary', '"2028" Republican primary', '"exploratory committee" 2028'];

async function googleNews(query) {
  const u = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return parseFeed(await getText(u, { timeout: 12000, tries: 2, headers: { "user-agent": "Mozilla/5.0 pres28-collector/1.0" } }));
}

async function taskGoogleNews() {
  // Each person once a day, spread over the hours, plus the general searches every hour.
  const slice = roster.filter((_, i) => i % 24 === hour);
  const items = new Map();
  let failures = 0;
  const queries = [
    ...GENERAL_QUERIES.map((q) => ({ q: `${q} when:2d`, forced: [] })),
    ...slice.map((p) => ({ q: `"${p.name}" 2028 when:2d`, forced: [p.id] })),
  ];
  for (const { q, forced } of queries) {
    try {
      for (const raw of await googleNews(q)) {
        const it = toItem(raw, "gnews", "Google News", forced);
        if (it) items.set(it.id, it);
      }
    } catch {
      failures++;
    }
    await sleep(800);
  }
  if (failures === queries.length) throw new Error(`all ${failures} Google News searches failed`);
  const rows = [...items.values()];
  await send("items", rows);
  return { rows: rows.length, note: `${queries.length - failures}/${queries.length} searches ok` };
}

// ---------- candidates' own posts ----------

async function taskBluesky() {
  const people = roster.filter((p) => p.bluesky);
  const rows = [];
  let failures = 0;
  await pool(people, 8, async (p) => {
    try {
      const u = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(p.bluesky)}&limit=20&filter=posts_no_replies`;
      const { feed } = await getJson(u, { tries: 1 });
      for (const { post, reason } of feed ?? []) {
        if (reason) continue; // reposts
        const created = post.record?.createdAt;
        if (created && now - new Date(created) > 3 * 864e5) continue;
        const rkey = post.uri.split("/").pop();
        const url = `https://bsky.app/profile/${p.bluesky}/post/${rkey}`;
        const text = (post.record?.text ?? "").slice(0, 400);
        rows.push({ id: itemId(url), kind: "bluesky", source: p.bluesky, title: text.slice(0, 160) || "(post)", url, published: created ?? null, seen: stamp, people: JSON.stringify([p.id]), text });
      }
    } catch {
      failures++;
    }
  });
  await send("items", rows);
  return { rows: rows.length, note: `${people.length - failures}/${people.length} accounts ok` };
}

async function taskYouTube() {
  const people = roster.filter((p) => p.youtube);
  const rows = [];
  let failures = 0;
  await pool(people, 8, async (p) => {
    try {
      const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${p.youtube}`, { tries: 1 });
      for (const raw of parseFeed(xml)) {
        if (!recent(raw, 3) || !raw.title || !raw.url) continue;
        rows.push({ id: itemId(raw.url), kind: "youtube", source: p.name, title: raw.title.slice(0, 400), url: raw.url, published: raw.published, seen: stamp, people: JSON.stringify([p.id]), text: raw.text });
      }
    } catch {
      failures++;
    }
  });
  await send("items", rows);
  return { rows: rows.length, note: `${people.length - failures}/${people.length} channels ok` };
}

// ---------- daily ----------

async function taskPeople() {
  const rows = roster.map((p) => ({ id: p.id, name: p.name, party: p.party, on_list: p.on_list, data: JSON.stringify(p) }));
  await send("people", rows);
  return { rows: rows.length };
}

async function taskPolls() {
  const all = await getJson("https://api.votehub.com/polls", { timeout: 40000, headers: { "user-agent": "Mozilla/5.0 pres28-collector/1.0" } });
  const rows = all
    .filter((p) => p.poll_type === "presidential-primary" && /^2028 /.test(p.subject ?? ""))
    .map((p) => ({
      id: `votehub:${p.id}`, source: "votehub", subject: p.subject, pollster: p.pollster, start_date: p.start_date, end_date: p.end_date,
      population: p.population, sample_size: p.sample_size, url: p.url, partisan: p.partisan, internal: p.internal ? 1 : 0,
      created: p.created_at, answers: JSON.stringify(p.answers),
    }));
  if (!rows.length) throw new Error("no 2028 primary polls in the VoteHub response");
  await send("polls", rows);
  return { rows: rows.length };
}

const compact = (iso) => iso.slice(0, 10).replaceAll("-", "");
const pageviewsUrl = (title, from, to) =>
  `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replaceAll(" ", "_"))}/daily/${compact(from)}00/${compact(to)}00`;

async function pageviewRows(person, from, to) {
  const { items } = await getJson(pageviewsUrl(person.wiki, from, to), { tries: 3 });
  return (items ?? []).map((x) => ({
    person: person.id, source: "wiki_views",
    ts: `${x.timestamp.slice(0, 4)}-${x.timestamp.slice(4, 6)}-${x.timestamp.slice(6, 8)}`,
    value: x.views, volume: null,
  }));
}

async function taskWikipedia() {
  const from = new Date(now - 7 * 864e5).toISOString();
  const people = roster.filter((p) => p.wiki);
  const rows = [];
  let failures = 0;
  let firstError = "";
  for (const p of people) {
    try {
      rows.push(...(await pageviewRows(p, from, stamp)));
    } catch (err) {
      failures++;
      firstError ||= err.message;
    }
    await sleep(WIKI_PACE_MS);
  }
  if (rows.length) await send("obs", rows);
  if (failures > people.length / 2) throw new Error(`${failures}/${people.length} people failed: ${firstError}`);
  return { rows: rows.length, note: `${people.length - failures}/${people.length} people ok` };
}

async function taskFec() {
  const byName = new Map(roster.map((p) => [slug(p.name), p.id]));
  const rows = [];
  for (let page = 1; page <= 30; page++) {
    const u = `https://api.open.fec.gov/v1/candidates/?election_year=2028&office=P&per_page=100&page=${page}&api_key=${process.env.FEC_KEY ?? "DEMO_KEY"}`;
    const data = await getJson(u, { timeout: 25000, tries: 3 });
    for (const c of data.results ?? []) {
      const [last = "", rest = ""] = c.name.split(",");
      const first = rest.trim().split(/\s+/)[0] ?? "";
      rows.push({
        id: c.candidate_id, name: c.name, party: c.party, first_file: c.first_file_date,
        has_funds: c.has_raised_funds ? 1 : 0, person: byName.get(slug(`${first} ${last}`)) ?? null, seen: stamp,
      });
    }
    if (page >= (data.pagination?.pages ?? 0)) break;
  }
  if (!rows.length) throw new Error("no FEC filers returned");
  await send("filings", rows);
  return { rows: rows.length, note: `${rows.filter((r) => r.person).length} match the roster` };
}

// ---------- history ----------

async function polyHistory(m) {
  const { history } = await getJson(`https://clob.polymarket.com/prices-history?market=${m.token}&interval=max&fidelity=1440`);
  const byDay = new Map((history ?? []).map((h) => [new Date(h.t * 1000).toISOString().slice(0, 10), h.p]));
  return [...byDay].map(([ts, value]) => ({ person: m.person, source: m.source, ts, value, volume: null }));
}

async function kalshiHistory(m) {
  const end = Math.floor(now / 1000);
  const start = end - 760 * 86400;
  const u = `https://api.elections.kalshi.com/trade-api/v2/series/${m.series}/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1440`;
  const { candlesticks } = await getJson(u, { tries: 3 });
  const rows = [];
  for (const c of candlesticks ?? []) {
    const bid = +(c.yes_bid?.close_dollars ?? 0);
    const ask = +(c.yes_ask?.close_dollars ?? 0);
    const value = c.price?.close_dollars != null ? +c.price.close_dollars : bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    if (value == null) continue;
    rows.push({ person: m.person, source: m.source, ts: new Date((c.end_period_ts - 1) * 1000).toISOString().slice(0, 10), value, volume: +(c.volume_fp ?? 0) });
  }
  return rows;
}

async function taskBackfill() {
  if (!markets.poly.length) await loadPoly();
  if (!markets.kalshi.length) await loadKalshi();
  const res = await get(`${INGEST_URL}/backfill`, { headers: { authorization: `Bearer ${INGEST_KEY}` } });
  const done = new Set(await res.json());

  const nominee = (m) => m.source.includes("_nom_");
  const jobs = [
    ...markets.poly.filter(nominee).map((m) => ({ key: `poly:${m.source}:${m.person}`, load: () => polyHistory(m), table: "obs" })),
    ...markets.kalshi.filter(nominee).map((m) => ({ key: `kalshi:${m.source}:${m.person}`, load: () => kalshiHistory(m), table: "obs" })),
    ...roster.filter((p) => p.wiki).map((p) => ({
      key: `wiki:${p.id}`,
      table: "obs",
      load: async () => {
        await sleep(WIKI_PACE_MS);
        return pageviewRows(p, HISTORY_START, stamp);
      },
    })),
    // Google returns its best matches for each name, the nearest thing to old chatter.
    ...roster.map((p) => ({
      key: `gnews:${p.id}`,
      table: "items",
      load: async () => {
        await sleep(800);
        return (await googleNews(`"${p.name}" 2028`)).map((raw) => toItem(raw, "gnews", "Google News", [p.id])).filter(Boolean);
      },
    })),
  ].filter((j) => !done.has(j.key));

  let sent = 0;
  let finished = 0;
  let failed = 0;
  for (const job of jobs) {
    if (sent >= BACKFILL_ROWS) break;
    try {
      const rows = await job.load();
      if (rows.length) await send(job.table, rows);
      await send("backfill", [{ key: job.key, rows_sent: rows.length, done_at: stamp }]);
      sent += rows.length;
      finished++;
    } catch (err) {
      failed++;
      console.log(`backfill ${job.key}: ${err.message}`);
    }
  }
  return { rows: sent, note: `${finished} jobs done, ${failed} failed, ${jobs.length - finished - failed} left` };
}

// ---------- schedule ----------

const TASKS = {
  polymarket: taskPolymarket,
  kalshi: taskKalshi,
  feeds: taskFeeds,
  gnews: taskGoogleNews,
  bluesky: taskBluesky,
  youtube: taskYouTube,
  people: taskPeople,
  polls: taskPolls,
  wikipedia: taskWikipedia,
  fec: taskFec,
  backfill: taskBackfill,
};

function chosen() {
  const asked = process.env.TASKS?.trim();
  if (asked === "all") return Object.keys(TASKS);
  if (asked) return asked.split(",").map((s) => s.trim());
  const list = ["polymarket", "kalshi", "feeds", "gnews", "bluesky", "youtube"];
  if (hour === 6) list.push("people", "polls", "wikipedia", "fec");
  if (hour === 6 || hour === 18) list.push("backfill");
  return list;
}

for (const name of chosen()) {
  if (!TASKS[name]) throw new Error(`unknown task ${name}`);
  await task(name, TASKS[name]);
}

// Only a total failure fails the job, which is what makes GitHub send an email.
if (report.every((r) => !r.ok)) process.exit(1);
