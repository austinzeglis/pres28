// Stores what the collector sends and reports on its health. The collector runs
// on GitHub Actions because the free Workers plan allows only 10 ms of CPU and
// 50 outside requests per scheduled run.

const TABLES = {
  people: { verb: "REPLACE", cols: ["id", "name", "party", "on_list", "data"] },
  obs: { verb: "REPLACE", cols: ["person", "source", "ts", "value", "volume"] },
  polls: { verb: "IGNORE", cols: ["id", "source", "subject", "pollster", "start_date", "end_date", "population", "sample_size", "url", "partisan", "internal", "created", "answers"] },
  items: { verb: "IGNORE", cols: ["id", "kind", "source", "title", "url", "published", "seen", "people", "text"] },
  filings: { verb: "REPLACE", cols: ["id", "name", "party", "first_file", "has_funds", "person", "seen"] },
  runs: { verb: "REPLACE", cols: ["ts", "source", "ok", "rows_sent", "note"] },
  backfill: { verb: "REPLACE", cols: ["key", "rows_sent", "done_at"] },
};

const MAX_ROWS = 100;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
    return new Response("pres28 collector\n", { status: url.pathname === "/" ? 200 : 404 });
  },
};
