// Stores what the collector sends and reports on its health. The collector runs
// on GitHub Actions because the free Workers plan allows only 10 ms of CPU and
// 50 outside requests per scheduled run.

const TABLES = {
  people: { verb: "REPLACE", cols: ["id", "name", "party", "on_list", "data"] },
  obs: { verb: "REPLACE", cols: ["person", "source", "ts", "value", "volume"] },
  polls: { verb: "REPLACE", cols: ["id", "source", "subject", "pollster", "start_date", "end_date", "population", "sample_size", "url", "partisan", "internal", "created", "answers"] },
  items: { verb: "IGNORE", cols: ["id", "kind", "source", "title", "url", "published", "seen", "people", "text"] },
  filings: { verb: "REPLACE", cols: ["id", "name", "party", "first_file", "has_funds", "person", "seen"] },
  runs: { verb: "REPLACE", cols: ["ts", "source", "ok", "rows_sent", "note"] },
  backfill: { verb: "REPLACE", cols: ["key", "rows_sent", "done_at"] },
  snapshots: { verb: "REPLACE", cols: ["key", "json", "updated"] },
};

const MAX_ROWS = 100;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The site's data changes hourly, so browsers can hold it briefly.
const site = (text, maxAge = 120) =>
  new Response(text, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` } });

const STORY_COLUMNS = "i.title, i.url, i.source, i.published, i.kind";

async function feed(env, scope) {
  const now = new Date().toISOString();
  const where = scope === "all"
    ? "kind IN ('feed', 'gnews')"
    : "(kind = 'gnews' OR (kind = 'feed' AND (title LIKE '%2028%' OR text LIKE '%2028%')))";
  const { results } = await env.DB
    .prepare(`SELECT title, url, source, published, kind, people, substr(text, 1, 200) AS text FROM items WHERE published <= ? AND ${where} ORDER BY published DESC LIMIT 400`)
    .bind(now).all();
  return site(JSON.stringify(results));
}

async function person(env, id) {
  const snap = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?").bind(`person:${id}`).first();
  if (!snap) return json({ error: "not found" }, 404);
  const now = new Date().toISOString();
  const query = (kinds) => env.DB
    .prepare(`SELECT ${STORY_COLUMNS} FROM item_people p JOIN items i ON i.id = p.id WHERE p.person = ? AND p.published <= ? AND p.kind IN (${kinds}) ORDER BY p.published DESC LIMIT 150`)
    .bind(id, now);
  const [stories, posts] = await env.DB.batch([query("'feed','gnews'"), query("'bluesky','youtube'")]);
  return site(`{"person":${snap.json},"stories":${JSON.stringify(stories.results)},"posts":${JSON.stringify(posts.results)}}`);
}

async function exported(env, path) {
  const [what, arg] = path.split("/").map(decodeURIComponent);
  if (what === "person") {
    const [obs, news] = await env.DB.batch([
      env.DB.prepare("SELECT source, substr(ts, 1, 10) AS d, avg(value) AS v FROM obs WHERE person = ? GROUP BY source, d").bind(arg),
      env.DB.prepare("SELECT substr(published, 1, 10) AS d, count(*) AS n FROM item_people WHERE person = ? AND kind IN ('feed', 'gnews') GROUP BY d").bind(arg),
    ]);
    return json({ obs: obs.results, news: news.results });
  }
  if (what === "polls") return json((await env.DB.prepare("SELECT * FROM polls").all()).results);
  if (what === "filings") return json((await env.DB.prepare("SELECT id, name, party, first_file, has_funds, person FROM filings WHERE person IS NOT NULL").all()).results);
  if (what === "snapshot") {
    const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?").bind(arg).first();
    return new Response(row?.json ?? "null", { headers: { "content-type": "application/json" } });
  }
  return json({ error: "unknown export" }, 404);
}

async function ingest(env, table, rows) {
  const def = TABLES[table];
  if (!def) return json({ error: "unknown table" }, 404);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
    return json({ error: `send 1-${MAX_ROWS} rows` }, 400);
  }
  const marks = def.cols.map(() => "?").join(",");
  const stmt = env.DB.prepare(`INSERT OR ${def.verb} INTO ${table}(${def.cols.join(",")}) VALUES(${marks})`);
  const results = await env.DB.batch(rows.map((r) => stmt.bind(...def.cols.map((c) => r[c] ?? null))));
  return json({ written: results.reduce((n, x) => n + (x.meta?.rows_written ?? 0), 0) });
}

async function status(env, deep) {
  const runs = await env.DB.prepare("SELECT ts, source, ok, rows_sent, note FROM runs ORDER BY ts DESC LIMIT 60").all();
  const backfill = await env.DB.prepare("SELECT count(*) AS jobs, coalesce(sum(rows_sent), 0) AS rows_sent FROM backfill").first();
  const out = { runs: runs.results, backfill };
  if (deep) {
    // Full scans cost reads, so these counts sit behind the key.
    const obs = await env.DB.prepare("SELECT source, count(*) AS n, count(DISTINCT person) AS people, min(ts) AS first, max(ts) AS last FROM obs GROUP BY source").all();
    const items = await env.DB.prepare("SELECT kind, count(*) AS n, max(published) AS last FROM items GROUP BY kind").all();
    const polls = await env.DB.prepare("SELECT subject, count(*) AS n, max(end_date) AS last FROM polls GROUP BY subject").all();
    const filings = await env.DB.prepare("SELECT count(*) AS n, sum(has_funds) AS with_funds, count(person) AS matched FROM filings").first();
    const people = await env.DB.prepare("SELECT count(*) AS n FROM people").first();
    Object.assign(out, { obs: obs.results, items: items.results, polls: polls.results, filings, people: people.n });
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authed = request.headers.get("authorization") === `Bearer ${env.INGEST_KEY}`;

    if (request.method === "POST" && url.pathname.startsWith("/ingest/")) {
      if (!authed) return json({ error: "unauthorized" }, 401);
      const { rows } = await request.json();
      return ingest(env, url.pathname.slice("/ingest/".length), rows);
    }
    if (request.method === "GET" && url.pathname.startsWith("/export/")) {
      if (!authed) return json({ error: "unauthorized" }, 401);
      return exported(env, url.pathname.slice("/export/".length));
    }
    if (request.method === "GET" && url.pathname === "/api/board") {
      const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = 'board'").first();
      return row ? site(row.json) : json({ error: "not ready" }, 503);
    }
    if (request.method === "GET" && url.pathname === "/api/feed") return feed(env, url.searchParams.get("scope"));
    if (request.method === "GET" && url.pathname.startsWith("/api/person/")) {
      return person(env, decodeURIComponent(url.pathname.slice("/api/person/".length)));
    }
    if (request.method === "GET" && url.pathname === "/backfill") {
      if (!authed) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare("SELECT key FROM backfill").all();
      return json(results.map((r) => r.key));
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const deep = url.searchParams.has("deep");
      if (deep && !authed) return json({ error: "unauthorized" }, 401);
      return status(env, deep);
    }
    return json({ error: "not found" }, 404);
  },
};
