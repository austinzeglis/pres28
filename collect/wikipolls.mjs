// Reads the poll tables on Wikipedia's nationwide 2028 primary polling pages
// (CC BY-SA 4.0). The tables also name long shots in footnotes under "Other",
// which are kept because they tell us who was offered and how they did.
import { slug } from "./names.mjs";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function stripTemplates(s) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("{{", i)) { depth++; i++; continue; }
    if (s.startsWith("}}", i) && depth) { depth--; i++; continue; }
    if (!depth) out += s[i];
  }
  return out;
}

const plain = (s) =>
  stripTemplates(s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A cell can open with attributes or a shading template before a pipe.
function cellBody(raw) {
  let s = raw.replace(/^\s*\{\{\s*party shading[^}]*\}\}\s*\|?/i, "").trim();
  const attr = s.match(/^((?:\s*(?:style|rowspan|colspan|class|data-sort-value|align|nowrap)\b(?:="[^"]*"|=\S+)?)+)\s*\|(?!\|)/i);
  if (attr) s = s.slice(attr[0].length);
  return s.trim();
}

const rowspanOf = (raw) => +(raw.match(/rowspan="?(\d+)"?/i)?.[1] ?? 1);

function parseDates(text) {
  const t = text.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const year = (s) => s.match(/\b(20\d\d)\b/)?.[1];
  const month = (s) => {
    const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/i);
    return m ? MONTHS[m[1].toLowerCase()] : null;
  };
  const dayOf = (s) => s.replace(/\b20\d\d\b/, "").match(/\b(\d{1,2})\b/)?.[1];
  const [left, right = left] = t.split(/\s*-\s*/);
  const endYear = year(right) ?? year(left);
  const endMonth = month(right) ?? month(left);
  const endDay = dayOf(right);
  if (!endYear || !endMonth || !endDay) return null;
  const startMonth = month(left) ?? endMonth;
  const startDay = dayOf(left) ?? endDay;
  const startYear = year(left) ?? (startMonth > endMonth ? String(+endYear - 1) : endYear);
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { start: iso(startYear, startMonth, startDay), end: iso(endYear, endMonth, endDay) };
}

function parseSample(text) {
  const t = plain(text);
  return {
    n: +(t.match(/([\d,]{2,})/)?.[1]?.replaceAll(",", "") ?? 0) || null,
    population: t.match(/\((A|RV|LV|V)\)/i)?.[1]?.toLowerCase() ?? t.match(/\b(A|RV|LV)\b/)?.[1]?.toLowerCase() ?? null,
  };
}

// Returns a number, or null when the person wasn't offered. "<1%" counts as half a point.
function parsePct(text) {
  const t = plain(text);
  if (!t || /^[–—\-]+$/.test(t)) return null;
  const m = t.match(/([<>≤]?)\s*(\d+(?:\.\d+)?)\s*%?/);
  if (!m) return null;
  return m[1] ? +m[2] / 2 : +m[2];
}

// "Name 1.1%, 2% Name, A, B & C with 1%; D with >0.5%" -> [{ choice, pct }]
export function parseFootnote(text) {
  const out = [];
  const add = (name, pct) => {
    const clean = name.replace(/["“”]/g, "").replace(/^(and|&|for)\s+/i, "").replace(/\s+/g, " ").trim();
    if (clean && /^[\p{L}][\p{L} .'’-]+$/u.test(clean) && clean.split(" ").length <= 5) out.push({ choice: clean, pct });
  };
  const value = (s) => {
    const m = s.match(/([<>≤]?)\s*(\d+(?:\.\d+)?)\s*%/);
    return m ? (m[1] ? +m[2] / 2 : +m[2]) : null;
  };
  for (const seg of text.split(/;/)) {
    const w = seg.match(/^(.*?)\s+(?:with|at)\s+([<>≤]?\s*\d+(?:\.\d+)?\s*%)/i);
    if (w) {
      for (const name of w[1].split(/,|&|\band\b/)) add(name, value(w[2]));
      continue;
    }
    for (const part of seg.split(/,/)) {
      const after = part.match(/^\s*(.+?)\s+([<>≤]?\s*\d+(?:\.\d+)?\s*%)\s*$/);
      const before = part.match(/^\s*([<>≤]?\s*\d+(?:\.\d+)?\s*%)\s+(.+?)\s*$/);
      if (after) add(after[1], value(after[2]));
      else if (before) add(before[2], value(before[1]));
    }
  }
  return out;
}

function footnotes(raw) {
  const found = [];
  const re = /\{\{\s*efn\s*\|/gi;
  let m;
  while ((m = re.exec(raw))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < raw.length && depth) {
      if (raw.startsWith("{{", i)) { depth++; i += 2; continue; }
      if (raw.startsWith("}}", i)) { depth--; i += 2; continue; }
      i++;
    }
    const body = raw.slice(start, i - 2).replace(/^name\s*=\s*"?[^|"]*"?\s*\|?/i, "");
    found.push(plain(body));
  }
  return found;
}

const STATE_CODES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL",
  Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME",
  Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

// The statewide page has one "== Iowa caucus ==" style section per state.
export function parseStatePolls(wikitext, party) {
  const parts = wikitext.split(/^==[ ]*([^=\n]+?)[ ]*==[ ]*$/m);
  const polls = [];
  let skipped = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].replace(/\s+(primary|primaries|caucus|caucuses)$/i, "");
    const code = STATE_CODES[name];
    if (!code) continue;
    const found = parseWikiPolls(parts[i + 1], party, code);
    polls.push(...found.polls);
    skipped += found.skipped;
  }
  return { polls, skipped };
}

export function parseWikiPolls(wikitext, party, state = null) {
  const subject = `2028 ${party === "D" ? "Democratic" : "Republican"}`;
  const text = wikitext.replace(/<ref[^>]*\/>/g, "").replace(/<ref[\s\S]*?<\/ref>/g, "");
  const tables = text.match(/\{\|[\s\S]*?\n\|\}/g) ?? [];
  const polls = [];
  let skipped = 0;

  for (const table of tables) {
    const rows = table.split(/\n\|-[^\n]*/);
    const headRow = rows.find((r) => /!\s*Poll source/i.test(r));
    if (!headRow) continue;
    const heads = headRow.split(/\n\s*!/).slice(1).map((h) => plain(h));
    const otherAt = heads.findIndex((h) => /^other/i.test(h));
    const undecidedAt = heads.findIndex((h) => /^undecided/i.test(h));
    const lastName = otherAt > 0 ? otherAt : undecidedAt > 0 ? undecidedAt : heads.length;
    const carry = Array(heads.length).fill(null);

    for (const row of rows) {
      if (row === headRow || !/\n\s*\|/.test(`\n${row}`)) continue;
      if (/colspan/i.test(row)) continue; // the "elections held" divider rows
      const raw = `\n${row}`.split(/\n\s*\|(?![-}])/).slice(1);
      const cells = [];
      let r = 0;
      for (let col = 0; col < heads.length; col++) {
        if (carry[col]?.left > 0) {
          cells[col] = carry[col].value;
          carry[col].left--;
          continue;
        }
        const cell = raw[r++];
        if (cell == null) break;
        cells[col] = cell;
        const span = rowspanOf(cell.split("|")[0]);
        if (span > 1) carry[col] = { left: span - 1, value: cell };
      }
      if (cells.length < heads.length || cells.some((c) => c == null)) {
        skipped++;
        continue;
      }
      const source = cellBody(cells[0]);
      const link = source.match(/\[(https?:\/\/\S+)\s+([^\]]+)\]/);
      const pollster = plain(link ? link[2] : source);
      const dates = parseDates(plain(cellBody(cells[1])));
      if (!pollster || !dates) {
        skipped++;
        continue;
      }
      const { n, population } = parseSample(cellBody(cells[2]));
      const answers = [];
      for (let col = 3; col < lastName; col++) {
        const pct = parsePct(cellBody(cells[col]));
        if (pct != null) answers.push({ choice: heads[col], pct });
      }
      if (otherAt > 0) {
        for (const note of footnotes(cells[otherAt])) answers.push(...parseFootnote(note));
      }
      if (answers.length < 3) {
        skipped++;
        continue;
      }
      const partisan = source.match(/\((R|D)\)/)?.[1] ?? null;
      polls.push({
        id: `wikipedia:${party}:${state ? `${state}:` : ""}${dates.end}:${slug(pollster)}:${n ?? "x"}:${answers.length}`,
        source: "wikipedia",
        state,
        subject,
        pollster,
        start_date: dates.start,
        end_date: dates.end,
        population,
        sample_size: n,
        url: link?.[1] ?? null,
        partisan,
        internal: 0,
        answers,
      });
    }
  }
  return { polls, skipped };
}
