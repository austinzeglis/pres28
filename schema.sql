-- Primary keys only, with no extra indexes: each index would add a billable
-- write per row on D1's free plan (100,000 row writes a day).

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT, party TEXT, on_list INTEGER, data TEXT
) WITHOUT ROWID;

-- One number per person, source and time. ts is YYYY-MM-DD for daily values
-- (history, Wikipedia traffic) and YYYY-MM-DDTHH for hourly market snapshots.
CREATE TABLE IF NOT EXISTS obs (
  person TEXT, source TEXT, ts TEXT, value REAL, volume REAL,
  PRIMARY KEY (person, source, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY, source TEXT, subject TEXT, pollster TEXT, start_date TEXT, end_date TEXT,
  population TEXT, sample_size INTEGER, url TEXT, partisan TEXT, internal INTEGER,
  created TEXT, answers TEXT, state TEXT
) WITHOUT ROWID;

-- Headlines and posts. kind is feed, gnews, bluesky or youtube. people is a JSON array of ids.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, kind TEXT, source TEXT, title TEXT, url TEXT,
  published TEXT, seen TEXT, people TEXT, text TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS filings (
  id TEXT PRIMARY KEY, name TEXT, party TEXT, first_file TEXT, has_funds INTEGER,
  person TEXT, seen TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS runs (
  ts TEXT, source TEXT, ok INTEGER, rows_sent INTEGER, note TEXT,
  PRIMARY KEY (ts, source)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS backfill (
  key TEXT PRIMARY KEY, rows_sent INTEGER, done_at TEXT
) WITHOUT ROWID;

-- Finds a person's stories without scanning items. Filled by the trigger below.
CREATE TABLE IF NOT EXISTS item_people (
  person TEXT, published TEXT, id TEXT, kind TEXT,
  PRIMARY KEY (person, published, id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS items_people AFTER INSERT ON items BEGIN
  INSERT OR IGNORE INTO item_people(person, published, id, kind)
  SELECT je.value, coalesce(NEW.published, NEW.seen), NEW.id, NEW.kind FROM json_each(NEW.people) je;
END;

CREATE INDEX IF NOT EXISTS items_published ON items(published);

-- Ready-made JSON for the site: board, inputs, person:<id>. Rewriting these costs
-- a handful of writes, where per-day score rows would cost tens of thousands.
CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY, json TEXT, updated TEXT
) WITHOUT ROWID;
