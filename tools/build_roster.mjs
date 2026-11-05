// Builds data/roster.json from data/pool.tsv: adds Wikipedia titles and social
// accounts from Wikidata, plus the name rules used to attribute headlines.
// Run by hand when the pool changes: node tools/build_roster.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { slug } from "../collect/names.mjs";

const UA = { "user-agent": "pres28-collector/1.0 (https://github.com/austinzeglis/pres28)" };

// Wikipedia titles where the plain name is another person or a disambiguation page.
const WIKI = {
  "J.B. Pritzker": "JB Pritzker",
  "Josh Green": "Josh Green (politician)",
  "Jeff Jackson": "Jeff Jackson (politician)",
  "John Kennedy": "John Kennedy (Louisiana politician)",
  "John McEntee": "John McEntee (political aide)",
};

// Extra full-name spellings. These match anywhere in a headline or its summary.
const ALIASES = {
  "J.B. Pritzker": ["JB Pritzker", "J. B. Pritzker"],
  "JD Vance": ["J.D. Vance", "J. D. Vance"],
  "Alexandria Ocasio-Cortez": ["Ocasio-Cortez"],
  "Robert F. Kennedy Jr.": ["RFK Jr.", "RFK Jr", "Robert Kennedy Jr."],
  "Donald Trump Jr.": ["Don Jr.", "Donald J. Trump Jr."],
  "Donald Trump": ["Donald J. Trump"],
  "John Kennedy": ["John N. Kennedy", "John Neely Kennedy", "Sen. John Kennedy", "Senator John Kennedy"],
  "Julian Castro": ["Julián Castro"],
  "Beto O'Rourke": ["Robert O'Rourke"],
  "Sarah Huckabee Sanders": ["Sarah Sanders"],
  "Michelle Lujan Grisham": ["Lujan Grisham"],
  "Catherine Cortez Masto": ["Cortez Masto"],
};

// The name itself is too common to match, so only the aliases count.
const ALIAS_ONLY = new Set(["John Kennedy"]);

// One-word names that are safe in a headline, matched case-sensitively in titles only.
const KEYS = {
  "Gavin Newsom": ["Newsom"], "Kamala Harris": ["Kamala"], "Pete Buttigieg": ["Buttigieg"],
  "Alexandria Ocasio-Cortez": ["AOC"], "J.B. Pritzker": ["Pritzker"], "Andy Beshear": ["Beshear"],
  "Raphael Warnock": ["Warnock"], "Ruben Gallego": ["Gallego"], "Elissa Slotkin": ["Slotkin"],
  "Ro Khanna": ["Khanna"], "Gretchen Whitmer": ["Whitmer"], "Jared Polis": ["Polis"],
  "Tim Walz": ["Walz"], "Amy Klobuchar": ["Klobuchar"], "Jon Ossoff": ["Ossoff"],
  "Tammy Duckworth": ["Duckworth"], "Brian Schatz": ["Schatz"], "John Fetterman": ["Fetterman"],
  "Pramila Jayapal": ["Jayapal"], "Abigail Spanberger": ["Spanberger"], "Debbie Stabenow": ["Stabenow"],
  "Eric Swalwell": ["Swalwell"], "Hakeem Jeffries": ["Jeffries"], "Adam Schiff": ["Schiff"],
  "Jamie Raskin": ["Raskin"], "James Talarico": ["Talarico"], "Abdul El-Sayed": ["El-Sayed"],
  "JD Vance": ["Vance"], "Marco Rubio": ["Rubio"], "Ron DeSantis": ["DeSantis"],
  "Pete Hegseth": ["Hegseth"], "Thomas Massie": ["Massie"], "Glenn Youngkin": ["Youngkin"],
  "Josh Hawley": ["Hawley"], "Tulsi Gabbard": ["Gabbard"], "Vivek Ramaswamy": ["Ramaswamy"],
  "Elise Stefanik": ["Stefanik"], "Kristi Noem": ["Noem"], "Doug Burgum": ["Burgum"],
  "Mike Pompeo": ["Pompeo"], "Steve Bannon": ["Bannon"], "Lee Zeldin": ["Zeldin"],
};

// Would otherwise match most political news, so it needs one of these words too.
const GUARD = { "Donald Trump": "\\b2028\\b|third term" };

const [header, ...lines] = readFileSync("data/pool.tsv", "utf8").trim().split("\n").map((l) => l.split("\t"));
const pool = lines.map((cols) => Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""])));

// Wikidata, 50 titles at a time.
const entities = new Map();
const titles = pool.map((p) => WIKI[p.name] ?? p.name);
for (let i = 0; i < titles.length; i += 50) {
  const q = new URLSearchParams({
    action: "wbgetentities", sites: "enwiki", titles: titles.slice(i, i + 50).join("|"), redirects: "yes",
    props: "claims|descriptions|sitelinks", sitefilter: "enwiki", languages: "en", format: "json",
  });
  const res = await fetch(`https://www.wikidata.org/w/api.php?${q}`, { headers: UA });
  const data = await res.json();
  for (const e of Object.values(data.entities ?? {})) {
    if (e.sitelinks?.enwiki) entities.set(e.sitelinks.enwiki.title, e);
  }
  // Redirects come back under the target title, so record the normalised input too.
  for (const n of data.normalized ?? []) if (!entities.has(n.from)) entities.set(n.from, entities.get(n.to));
}

const claim = (e, prop) => {
  const v = e?.claims?.[prop]?.find((c) => c.rank !== "deprecated")?.mainsnak?.datavalue?.value;
  return typeof v === "string" ? v : v?.time ?? null;
};

const roster = pool.map((p) => {
  const title = WIKI[p.name] ?? p.name;
  const e = entities.get(title) ?? [...entities.values()].find((x) => x?.sitelinks?.enwiki?.title?.startsWith(title));
  const match = [...(ALIAS_ONLY.has(p.name) ? [] : [p.name]), ...(ALIASES[p.name] ?? [])];
  return {
    id: slug(p.name),
    name: p.name,
    party: p.party,
    on_list: p.list_id ? 1 : 0,
    list: p.list_id ? { id: +p.list_id, age: +p.age, currently: p.currently, born: p.born, past_runs: p.past_runs } : null,
    wikidata: e?.id ?? null,
    wiki: e?.sitelinks?.enwiki?.title ?? null,
    desc: e?.descriptions?.en?.value ?? null,
    dob: claim(e, "P569")?.slice(1, 11) ?? null,
    bluesky: claim(e, "P12361"),
    youtube: claim(e, "P2397"),
    x: claim(e, "P2002"),
    site: claim(e, "P856"),
    match,
    keys: KEYS[p.name] ?? [],
    guard: GUARD[p.name] ?? null,
  };
});

writeFileSync("data/roster.json", JSON.stringify(roster, null, 1) + "\n");

const count = (k) => roster.filter((r) => r[k]).length;
console.log(`people ${roster.length} | wiki ${count("wiki")} | bluesky ${count("bluesky")} | youtube ${count("youtube")} | x ${count("x")}`);
for (const r of roster) console.log(`${r.party} ${r.name} -> ${r.wiki} | ${r.desc}`);
