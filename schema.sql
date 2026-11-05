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
  created TEXT, answers TEXT
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
