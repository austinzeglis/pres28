// The collector. GitHub Actions runs this hourly; everything goes to the Worker.
// TASKS=markets,feeds overrides the schedule, TASKS=all runs everything.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildMatcher, fold, slug } from "./names.mjs";
import { parseMatchups, parseStatePolls, parseWikiPolls } from "./wikipolls.mjs";
import { buildPeople } from "./candidates.mjs";
import { buildMap, finishParams } from "./states_model.mjs";
import { fundamentals } from "./mood.mjs";
import { buildMatchup, simulate } from "../public/sim.js";
import { WEIGHTS, attentionShares, cleanPolls, marketShares, pollShares, rankParty } from "./score.mjs";

const { INGEST_URL, INGEST_KEY } = process.env;
if (!INGEST_URL || !INGEST_KEY) throw new Error("INGEST_URL and INGEST_KEY are required");

const feeds = JSON.parse(readFileSync("data/feeds.json", "utf8")).feeds;

// The roster is the original list plus anyone the collector has added since.
const roster = JSON.parse(readFileSync("data/roster.json", "utf8"));
{
  const res = await fetch(`${INGEST_URL}/export/people`, { headers: { authorization: `Bearer ${INGEST_KEY}` } }).catch(() => null);
  const stored = res?.ok ? await res.json() : [];
  const known = new Set(roster.map((p) => p.id));
  for (const p of stored) if (p.discovered && !known.has(p.id)) roster.push(p);
}
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

async function send(table, rows, size = 100) {
  const batches = [];
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size));
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

// A new or dead market can show any price at all. One opened with $2.57 traded, a
// 1-cent bid and a 51-cent ask, and read as 26%. A price has to earn its way in.
const MIN_TRADED = 1000;
const MAX_SPREAD = 0.1;
const priceIsReal = (traded, bid, ask) =>
  traded >= MIN_TRADED && !(bid > 0 && ask > 0 && ask - bid > MAX_SPREAD);

async function loadPoly() {
  for (const m of POLY) {
    const [event] = await getJson(`https://gamma-api.polymarket.com/events?slug=${m.slug}`);
    if (!event) throw new Error(`no Polymarket event ${m.slug}`);
    for (const x of event.markets) {
      const name = x.groupItemTitle ?? "";
      const volume = +(x.volume ?? 0);
      // Unused slots are named "Person X", and dead markets can show stale prices.
      if (/^Person\b/.test(name) || !name || !x.outcomePrices || x.active === false || x.closed) continue;
      if (!priceIsReal(volume, +(x.bestBid ?? 0), +(x.bestAsk ?? 0))) continue;
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
      if (!name || value <= 0 || !priceIsReal(volume, bid, ask)) continue;
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
      const xml = await getText(feed.url, { timeout: 8000, tries: 1 });
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
  return parseFeed(await getText(u, { timeout: 12000, tries: 2 }));
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
  // Only the original list: anyone added later keeps the record of how they joined.
  const rows = roster.filter((p) => !p.discovered).map((p) => ({ id: p.id, name: p.name, party: p.party, on_list: p.on_list, data: JSON.stringify(p) }));
  await send("people", rows);
  return { rows: rows.length };
}

async function taskPolls() {
  const all = await getJson("https://api.votehub.com/polls", { timeout: 40000 });
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

async function taskWikiPolls() {
  const rows = [];
  let skipped = 0;
  for (const [page, party] of [["Democratic", "D"], ["Republican", "R"]]) {
    const u = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&page=Nationwide_opinion_polling_for_the_2028_${page}_Party_presidential_primaries`;
    const data = await getJson(u, { timeout: 30000, tries: 3 });
    const parsed = parseWikiPolls(data.parse.wikitext["*"], party);
    // A format change would show up here, before bad rows reach the score.
    if (parsed.polls.length < 50) throw new Error(`only ${parsed.polls.length} ${page} polls parsed`);
    skipped += parsed.skipped;
    rows.push(...parsed.polls.map((p) => ({ ...p, created: today, answers: JSON.stringify(p.answers) })));
  }
  await send("polls", rows);
  return { rows: rows.length, note: `newest ${rows.map((r) => r.end_date).sort().at(-1)}, ${skipped} rows skipped` };
}

async function taskStatePolls() {
  const rows = [];
  let skipped = 0;
  for (const [page, party] of [["Democratic", "D"], ["Republican", "R"]]) {
    const u = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&page=Statewide_opinion_polling_for_the_2028_${page}_Party_presidential_primaries`;
    const data = await getJson(u, { timeout: 30000, tries: 3 });
    const parsed = parseStatePolls(data.parse.wikitext["*"], party);
    if (parsed.polls.length < 10) throw new Error(`only ${parsed.polls.length} ${page} state polls parsed`);
    skipped += parsed.skipped;
    rows.push(...parsed.polls.map((p) => ({ ...p, created: today, answers: JSON.stringify(p.answers) })));
  }
  await send("polls", rows);
  return { rows: rows.length, note: `${new Set(rows.map((r) => r.state)).size} states, newest ${rows.map((r) => r.end_date).sort().at(-1)}, ${skipped} rows skipped` };
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
  ].filter((j) => !done.has(j.key) && (!process.env.BACKFILL_ONLY || j.key.startsWith(process.env.BACKFILL_ONLY)));

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

// ---------- new people ----------

// Someone joins when markets price them seriously or recent polls keep offering them.
// From then on they get everything: history, news, polls, a score and a page.
const JOIN_PRICE = 0.005;
const JOIN_POLLS = 2;
const JOIN_POLL_DAYS = 180;

async function lookupPeople(names) {
  const found = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const titles = names.slice(i, i + 50).join("|");
    const q = new URLSearchParams({ action: "wbgetentities", sites: "enwiki", titles, redirects: "yes", normalize: "1", props: "claims|descriptions|sitelinks", sitefilter: "enwiki", languages: "en", format: "json" });
    const data = await getJson(`https://www.wikidata.org/w/api.php?${q}`);
    for (const e of Object.values(data.entities ?? {})) {
      const title = e.sitelinks?.enwiki?.title;
      if (title && !/disambiguation/i.test(e.descriptions?.en?.value ?? "")) found.set(title, e);
    }
  }
  const photos = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const q = new URLSearchParams({ action: "query", prop: "pageimages", piprop: "thumbnail", pithumbsize: "240", pilimit: "50", redirects: "1", titles: names.slice(i, i + 50).join("|"), format: "json" });
    const data = await getJson(`https://en.wikipedia.org/w/api.php?${q}`);
    for (const page of Object.values(data.query?.pages ?? {})) if (page.thumbnail) photos.set(page.title, page.thumbnail.source);
  }
  const claim = (e, prop) => {
    const v = e?.claims?.[prop]?.find((c) => c.rank !== "deprecated")?.mainsnak?.datavalue?.value;
    return typeof v === "string" ? v : v?.time ?? null;
  };
  return (name) => {
    const e = found.get(name);
    return {
      wikidata: e?.id ?? null, wiki: e ? name : null, desc: e?.descriptions?.en?.value ?? null, photo: photos.get(name) ?? null,
      dob: claim(e, "P569")?.slice(1, 11) ?? null, bluesky: claim(e, "P12361"), youtube: claim(e, "P2397"), x: claim(e, "P2002"), site: claim(e, "P856"),
    };
  };
}

async function taskDiscover() {
  if (!markets.poly.length) await loadPoly();
  if (!markets.kalshi.length) await loadKalshi();
  const known = new Set(roster.map((p) => p.id));
  const candidates = new Map();
  const consider = (id, name, party, why, strength) => {
    if (known.has(id)) return;
    const held = candidates.get(id);
    if (!held || strength > held.strength) candidates.set(id, { id, name, party, why, strength });
  };

  for (const m of [...markets.poly, ...markets.kalshi]) {
    const party = m.source.match(/_nom_([DR])$/)?.[1];
    if (party && m.value >= JOIN_PRICE && m.person.includes("-")) consider(m.person, m.name, party, `priced ${(m.value * 100).toFixed(1)}% on ${m.source.startsWith("poly") ? "Polymarket" : "Kalshi"}`, m.value);
  }

  const rows = await exportJson("polls");
  const names = new Map();
  for (const r of rows) for (const a of JSON.parse(r.answers)) names.set(slug(a.choice), a.choice);
  const offered = new Map();
  for (const p of cleanPolls(rows.filter((r) => !r.state))) {
    if ((now - new Date(p.end)) / 864e5 > JOIN_POLL_DAYS) continue;
    for (const id of Object.keys(p.raw)) {
      const key = `${p.party}|${id}`;
      offered.set(key, (offered.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of offered) {
    const [party, id] = key.split("|");
    if (count >= JOIN_POLLS) consider(id, names.get(id) ?? id, party, `offered in ${count} polls in ${JOIN_POLL_DAYS} days`, count / 1000);
  }

  const joining = [...candidates.values()];
  if (!joining.length) return { rows: 0, note: "no new people" };
  const details = await lookupPeople(joining.map((c) => c.name));
  const added = joining.map((c) => ({
    id: c.id, name: c.name, party: c.party, on_list: 0, list: null, ...details(c.name),
    match: [c.name], keys: [], guard: null, discovered: { date: today, why: c.why },
  }));
  await send("people", added.map((p) => ({ id: p.id, name: p.name, party: p.party, on_list: 0, data: JSON.stringify(p) })));
  roster.push(...added);
  return { rows: added.length, note: added.map((p) => `${p.name} (${p.party})`).join(", ").slice(0, 280) };
}

// ---------- scoring ----------

const HISTORY_FIRST_DAY = "2025-07-20"; // both markets are open from here
const RECOMPUTE_POLLS_EVERY = 7; // days, or when a new poll arrives

const pct = (x) => (x == null ? null : Math.round(x * 1e4) / 100);
const round1 = (x) => Math.round(x * 10) / 10;
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

async function exportJson(path) {
  const res = await get(`${INGEST_URL}/export/${path}`, { timeout: 30000, tries: 3, headers: { authorization: `Bearer ${INGEST_KEY}` } });
  return res.json();
}

function loadStatuses() {
  const [, ...lines] = readFileSync("data/status.tsv", "utf8").trim().split("\n");
  const out = {};
  for (const line of lines) {
    const [person, status, date, headline, url] = line.split("\t");
    out[person] = { status, date, headline, url };
  }
  return out;
}

function cleanStates(rows) {
  const out = [];
  const states = new Set(rows.map((r) => r.state).filter(Boolean));
  for (const state of states) out.push(...cleanPolls(rows.filter((r) => r.state === state)));
  return out;
}

const STATE_NAMES = JSON.parse(readFileSync("data/calendar.json", "utf8"));

function statesSnapshot(statePolls) {
  const nameOf = new Map(roster.map((p) => [p.id, p.name]));
  const pretty = (id) => nameOf.get(id) ?? id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const out = { updated: stamp, early: STATE_NAMES.early, names: STATE_NAMES.names };
  for (const party of ["D", "R"]) {
    out[party] = {};
    for (const state of new Set(statePolls.filter((x) => x.party === party).map((x) => x.state))) {
      const list = statePolls.filter((x) => x.party === party && x.state === state);
      const fit = pollShares(list, party, today);
      const shares = Object.keys(fit).length ? fit : list.at(-1).shares;
      out[party][state] = {
        count: list.length,
        latest: list.at(-1).end,
        top: Object.entries(shares).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, v]) => ({ id, name: pretty(id), onRoster: nameOf.has(id), share: pct(v) })),
        polls: [...list].reverse().slice(0, 12).map((x) => ({
          end: x.end, pollster: x.pollster, url: x.url, n: x.n,
          top: Object.entries(x.raw).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => ({ name: pretty(id), pct: v })),
        })),
      };
    }
  }
  return out;
}

async function taskRescore() {
  if (!markets.poly.length) await loadPoly();
  if (!markets.kalshi.length) await loadKalshi();
  const pollRows = await exportJson("polls");
  // State polls are kept out of the national score: each state is its own small race.
  const polls = cleanPolls(pollRows.filter((r) => !r.state));
  const statePolls = cleanStates(pollRows);
  const filings = await exportJson("filings");

  // Everyone with a price counts toward market shares, on the roster or not.
  const ids = new Set(roster.map((p) => p.id));
  for (const m of [...markets.poly, ...markets.kalshi]) if (m.source.includes("_nom_")) ids.add(m.person);
  const raw = new Map();
  await pool([...ids], 6, async (id) => raw.set(id, await exportJson(`person/${encodeURIComponent(id)}`)));

  const lookup = new Map(); // person -> source -> day -> value
  const newsBy = new Map();
  for (const [id, data] of raw) {
    const bySource = new Map();
    for (const o of data.obs) {
      if (!bySource.has(o.source)) bySource.set(o.source, new Map());
      bySource.get(o.source).set(o.d, o.v);
    }
    lookup.set(id, bySource);
    newsBy.set(id, new Map(data.news.map((n) => [n.d, n.n])));
  }

  const carried = (series, day) => {
    for (let back = 0; back <= 5; back++) {
      const v = series?.get(addDays(day, -back));
      if (v != null) return v;
    }
    return null;
  };
  const sum7 = (series, day) => {
    let total = 0;
    for (let back = 0; back < 7; back++) total += series?.get(addDays(day, -back)) ?? 0;
    return total;
  };

  const inputs = { day: today };
  const series = new Map();
  for (const party of ["D", "R"]) {
    const members = roster.filter((p) => p.party === party).map((p) => p.id);
    const sources = [`poly_nom_${party}`, `kalshi_nom_${party}`];
    let polled = {};
    let pollsAt = null;
    let pollCount = -1;
    const partyRows = [];
    for (let day = HISTORY_FIRST_DAY; day <= today; day = addDays(day, 1)) {
      const rows = [];
      for (const [id, bySource] of lookup) {
        for (const source of sources) {
          const value = carried(bySource.get(source), day);
          if (value != null) rows.push({ person: id, source, value });
        }
      }
      const mkt = marketShares(rows);

      const count = polls.filter((p) => p.party === party && p.end <= day).length;
      if (count !== pollCount || !pollsAt || day === today || addDays(pollsAt, RECOMPUTE_POLLS_EVERY) <= day) {
        polled = pollShares(polls, party, day);
        pollsAt = day;
        pollCount = count;
      }

      const wiki = {};
      const news = {};
      for (const id of members) {
        wiki[id] = sum7(lookup.get(id)?.get("wiki_views"), day);
        news[id] = sum7(newsBy.get(id), day);
      }
      const attn = attentionShares(members, wiki, news);
      const one = {};
      for (const id of members) one[id] = { m: mkt[id] ?? null, p: polled[id] ?? null, a: attn[id] };
      const ranked = rankParty(one);
      for (const r of ranked.rows) {
        if (!series.has(r.id)) series.set(r.id, { days: [], score: [], rank: [], m: [], p: [], a: [] });
        const x = series.get(r.id);
        x.days.push(day);
        x.score.push(round1(r.score));
        x.rank.push(r.rank);
        x.m.push(pct(r.m));
        x.p.push(pct(r.p));
        x.a.push(pct(r.a));
      }
      partyRows.push(ranked);
    }

    const latest = partyRows.at(-1).rows;
    inputs[party] = {
      polled: polled, // includes people off the roster, so shares stay honest
      members: Object.fromEntries(latest.map((r) => {
        const x = series.get(r.id);
        const at = x.days.length - 8;
        return [r.id, { p: r.p, a: r.a, score7: at >= 0 ? x.score[at] : null, rank7: at >= 0 ? x.rank[at] : null, spark: x.score.slice(-60) }];
      })),
    };
  }

  const statuses = loadStatuses();
  const snapshots = [
    { key: "inputs", json: JSON.stringify(inputs), updated: stamp },
    { key: "states", json: JSON.stringify(statesSnapshot(statePolls)), updated: stamp },
  ];
  const pairs = (m) => (m ? [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, Math.round(v * 1e4) / 1e4]) : []);
  for (const p of roster) {
    const by = lookup.get(p.id);
    const src = (name) => pairs(by?.get(name));
    snapshots.push({
      key: `person:${p.id}`,
      updated: stamp,
      json: JSON.stringify({
        id: p.id, name: p.name, party: p.party, on_list: p.on_list, list: p.list, dob: p.dob, wiki: p.wiki, desc: p.desc, photo: p.photo,
        bluesky: p.bluesky, youtube: p.youtube, x: p.x, site: p.site,
        status: statuses[p.id] ?? { status: "mentioned" },
        filings: filings.filter((f) => f.person === p.id),
        series: series.get(p.id),
        sources: {
          poly: src(`poly_nom_${p.party}`),
          kalshi: src(`kalshi_nom_${p.party}`),
          wiki: src("wiki_views"),
          news: pairs(newsBy.get(p.id)),
        },
        polls: polls
          .filter((x) => x.party === p.party)
          .map((x) => ({ pollster: x.pollster, end: x.end, pct: x.raw[p.id] ?? null, n: x.n, url: x.url, source: x.source, discounted: x.discounted, field: Object.keys(x.raw).length }))
          .reverse(),
        statePolls: statePolls
          .filter((x) => x.party === p.party && x.raw[p.id] != null)
          .map((x) => ({ state: x.state, pollster: x.pollster, end: x.end, pct: x.raw[p.id], n: x.n, url: x.url, field: Object.keys(x.raw).length }))
          .sort((a, b) => (a.end < b.end ? 1 : -1)),
      }),
    });
  }
  await send("snapshots", snapshots, 1);
  return { rows: snapshots.length, note: `${polls.length} polls after merging repeats` };
}

// Runs hourly: fresh market prices over the polls and attention from the daily rescore.
async function taskBoard() {
  if (!markets.poly.length) await loadPoly();
  if (!markets.kalshi.length) await loadKalshi();
  const inputs = await exportJson("snapshot/inputs");
  if (!inputs?.D) throw new Error("no inputs yet: rescore has not run");
  const statuses = loadStatuses();
  const meta = new Map(roster.map((p) => [p.id, p]));
  const board = { updated: stamp, inputsDay: inputs.day, weights: WEIGHTS };
  for (const party of ["D", "R"]) {
    const live = [...markets.poly, ...markets.kalshi].filter((m) => m.source.endsWith(`_nom_${party}`));
    const mkt = marketShares(live);
    const one = {};
    for (const [id, x] of Object.entries(inputs[party].members)) one[id] = { m: mkt[id] ?? null, p: x.p, a: x.a };
    const { rows, top } = rankParty(one);
    board[party] = {
      top: pct(top),
      rows: rows.map((r) => {
        const x = inputs[party].members[r.id];
        const p = meta.get(r.id);
        const st = statuses[r.id];
        const priceOf = (kind) => live.find((m) => m.person === r.id && m.source.startsWith(kind))?.value ?? null;
        return {
          id: r.id, name: p.name, rank: r.rank, score: round1(r.score), blend: pct(r.blend),
          m: pct(r.m), p: pct(r.p), a: pct(r.a), thin: r.thin ? 1 : 0, on_list: p.on_list,
          poly: pct(priceOf("poly")), kalshi: pct(priceOf("kalshi")),
          d7: x.score7 == null ? null : round1(r.score - x.score7),
          r7: x.rank7 == null ? null : x.rank7 - r.rank,
          status: st?.status ?? "mentioned", statusDate: st?.date ?? null,
          spark: [...x.spark, round1(r.score)],
        };
      }),
    };
  }
  await send("snapshots", [{ key: "board", json: JSON.stringify(board), updated: stamp }], 1);
  return { rows: 1, note: `leaders ${board.D.rows[0].name}, ${board.R.rows[0].name}` };
}

// ---------- the matchup model ----------

const ELECTION_DAY = "2028-11-07";
const ALL_YEARS = [2008, 2012, 2016, 2020, 2024];
const MOOD_SD = { far: 5.5, near: 3 }; // national spread two years out, and in the final weeks
const MOOD_MARKET_SHARE = 0.5;
const STATE_2026_PULL = 0.1;

async function recentAverage(all, type, read, days) {
  const rows = all.filter((p) => p.poll_type === type && (now - new Date(p.end_date)) / 864e5 <= days).map(read).filter((x) => x != null);
  return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
}

async function partyMarkets() {
  const out = {};
  try {
    const [event] = await getJson("https://gamma-api.polymarket.com/events?slug=which-party-wins-2028-us-presidential-election");
    for (const m of event.markets) {
      const name = m.groupItemTitle ?? m.question ?? "";
      if (!m.outcomePrices) continue;
      if (/democrat/i.test(name)) out.polyD = +JSON.parse(m.outcomePrices)[0];
      if (/republican/i.test(name)) out.polyR = +JSON.parse(m.outcomePrices)[0];
    }
  } catch (err) {
    console.log(`polymarket party: ${err.message}`);
  }
  try {
    const data = await getJson("https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXPRESPARTY&with_nested_markets=true&limit=5");
    const event = data.events?.find((e) => e.event_ticker.endsWith("2028"));
    for (const m of event?.markets ?? []) {
      if (/democrat/i.test(m.yes_sub_title)) out.kalshiD = +m.last_price_dollars;
      if (/republican/i.test(m.yes_sub_title)) out.kalshiR = +m.last_price_dollars;
    }
  } catch (err) {
    console.log(`kalshi party: ${err.message}`);
  }
  const shares = [];
  if (out.polyD && out.polyR) shares.push(out.polyD / (out.polyD + out.polyR));
  if (out.kalshiD && out.kalshiR) shares.push(out.kalshiD / (out.kalshiD + out.kalshiR));
  out.demShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
  return out;
}

async function taskModel() {
  if (!markets.poly.length) await loadPoly();
  if (!markets.kalshi.length) await loadKalshi();
  const stateData = JSON.parse(readFileSync("data/states.json", "utf8"));
  const fit = JSON.parse(readFileSync("data/state_fit.json", "utf8"));
  const facts = JSON.parse(readFileSync("data/candidates.json", "utf8"));
  const { national, contests: allContests, house2026 } = stateData;
  const contestById = new Map(allContests.map((c) => [c.id, c]));

  // The map, with a small pull from how each state just voted in 2026.
  const map = finishParams(buildMap(allContests, national, ALL_YEARS, fit.cfg), fit.stray);
  for (const c of map.contests) {
    const src = contestById.get(c.id);
    const races = [src.senate26?.margin, src.governor26?.margin].filter((x) => x != null);
    if (!races.length) continue;
    const seen = races.reduce((a, b) => a + b, 0) / races.length;
    const expected = src.results[2024] - national[2024] + house2026;
    c.base += STATE_2026_PULL * Math.max(-10, Math.min(10, seen - expected));
  }

  // Polls of pairings.
  const page = await getJson("https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&page=2028_United_States_presidential_election", { timeout: 30000, tries: 3 });
  const partyOf = (id) => roster.find((p) => p.id === id)?.party;
  const matchups = parseMatchups(page.parse.wikitext["*"], partyOf);
  if (matchups.length < 20) throw new Error(`only ${matchups.length} matchup polls parsed`);

  // The mood from polling and approval.
  const votehub = await getJson("https://api.votehub.com/polls", { timeout: 40000 });
  const pctOf = (p, re) => p.answers.find((a) => re.test(a.choice))?.pct ?? null;
  const generic = await recentAverage(votehub, "generic-ballot", (p) => {
    const d = pctOf(p, /^dem/i);
    const r = pctOf(p, /^rep/i);
    return d != null && r != null ? d - r : null;
  }, 60);
  const netApproval = await recentAverage(votehub.filter((p) => /trump/i.test(p.subject ?? "")), "approval", (p) => {
    const a = pctOf(p, /^(approve|yes)/i);
    const b = pctOf(p, /^(disapprove|no)/i);
    return a != null && b != null ? a - b : null;
  }, 45);

  const daysLeft = Math.round((new Date(ELECTION_DAY) - now) / 864e5);
  const people = buildPeople({
    roster, facts: facts.people, partyMedian: facts.partyMedian,
    contests: contestById, national, house2026, matchups,
    quotes: [...markets.poly, ...markets.kalshi], netApproval: netApproval ?? 0, today, daysLeft,
  });

  const fade = Math.min(1, daysLeft / 730);
  const moodSd = MOOD_SD.near + (MOOD_SD.far - MOOD_SD.near) * fade;
  const fund = fundamentals(national, ALL_YEARS, { midterm: house2026, inPartyTerms: 1, inParty: "R" });
  const party = await partyMarkets();

  const lightContests = map.contests.map((c) => ({
    id: c.id, ev: c.ev, name: c.name, division: c.division, district: c.district, parentId: c.parentId, parent: c.parent,
    base: Math.round(c.base * 100) / 100, elasticity: c.elasticity, sigma: Math.round(c.sigma * 100) / 100,
    load: c.load.map((x) => Math.round(x * 1000) / 1000), weight: c.weight,
  }));
  const model = {
    updated: stamp, election: ELECTION_DAY, daysLeft,
    map: { nRef: map.nRef, factorSd: map.factorSd, districtShare: map.districtShare, turbulenceDf: fit.turbulenceDf, contests: lightContests },
    mood: { center: fund, sd: moodSd, df: 5, fundamentals: fund, market: null, marketShare: party.demShare, party, generic, netApproval, house2026 },
    people,
    matchups,
  };

  // What national mood makes a typical nomination-weighted pairing match the party markets?
  if (party.demShare) {
    const top = (side) => {
      const list = [...markets.poly, ...markets.kalshi].filter((m) => m.source.endsWith(`_nom_${side}`) && people[m.person]);
      const totals = new Map();
      for (const m of list) totals.set(m.person, (totals.get(m.person) ?? 0) + m.value);
      const sum = [...totals.values()].reduce((a, b) => a + b, 0);
      return [...totals].map(([id, v]) => ({ id, w: v / sum })).sort((a, b) => b.w - a.w).slice(0, 5);
    };
    const dems = top("D");
    const reps = top("R");
    const chance = (center) => {
      let total = 0;
      let weight = 0;
      model.mood.center = center;
      for (const d of dems) {
        for (const r of reps) {
          const w = d.w * r.w;
          const { params } = buildMatchup(model, d.id, r.id);
          total += w * simulate(params, 3000, 11).demWin;
          weight += w;
        }
      }
      return total / weight;
    };
    let low = -12;
    let high = 14;
    for (let i = 0; i < 9; i++) {
      const mid = (low + high) / 2;
      if (chance(mid) < party.demShare) low = mid;
      else high = mid;
    }
    model.mood.market = (low + high) / 2;
    model.mood.center = MOOD_MARKET_SHARE * model.mood.market + (1 - MOOD_MARKET_SHARE) * fund;
  }
  model.mood.center = Math.round(model.mood.center * 100) / 100;

  await send("snapshots", [{ key: "model", json: JSON.stringify(model), updated: stamp }], 1);
  const m = model.mood;
  return { rows: 1, note: `mood D${m.center >= 0 ? "+" : ""}${m.center} (fundamentals ${m.fundamentals.toFixed(1)}, markets ${m.market?.toFixed(1)}), ${matchups.length} matchup polls` };
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
  wikipolls: taskWikiPolls,
  statepolls: taskStatePolls,
  wikipedia: taskWikipedia,
  fec: taskFec,
  backfill: taskBackfill,
  discover: taskDiscover,
  rescore: taskRescore,
  board: taskBoard,
  model: taskModel,
};

function chosen() {
  const asked = process.env.TASKS?.trim();
  if (asked === "all") return Object.keys(TASKS);
  if (asked) return asked.split(",").map((s) => s.trim());
  const list = ["polymarket", "kalshi", "feeds", "gnews", "bluesky", "youtube"];
  if (hour === 6) list.push("people", "wikipedia", "fec");
  if (hour === 6 || hour === 18) list.push("polls", "wikipolls", "statepolls", "discover", "backfill", "rescore", "model");
  list.push("board");
  return list;
}

for (const name of chosen()) {
  if (!TASKS[name]) throw new Error(`unknown task ${name}`);
  await task(name, TASKS[name]);
}

// Only a total failure fails the job, which is what makes GitHub send an email.
if (report.every((r) => !r.ok)) process.exit(1);
