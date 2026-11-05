// Builds data/states.json: every contest with its electoral votes, presidential
// results 2008-2024, 2026 statewide results and demographics.
// Run by hand when inputs change: node tools/build_states.mjs
import { writeFileSync } from "node:fs";
import { fetchResults2026 } from "../collect/results2026.mjs";

const UA = { "user-agent": "pres28-collector/1.0 (https://github.com/austinzeglis/pres28)" };

const NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const CODE = Object.fromEntries(Object.entries(NAMES).map(([c, n]) => [n, c]));

// The 2020 census map, in force through 2028.
const EV = {
  AL: 9, AK: 3, AZ: 11, AR: 6, CA: 54, CO: 10, CT: 7, DE: 3, DC: 3, FL: 30, GA: 16, HI: 4, ID: 4, IL: 19, IN: 11, IA: 6, KS: 6, KY: 8, LA: 8, ME: 2, MD: 10, MA: 11,
  MI: 15, MN: 10, MS: 6, MO: 10, MT: 4, NE: 2, NV: 6, NH: 4, NJ: 14, NM: 5, NY: 28, NC: 16, ND: 3, OH: 17, OK: 7, OR: 8, PA: 19, RI: 4, SC: 9, SD: 3, TN: 11, TX: 40,
  UT: 6, VT: 3, VA: 13, WA: 12, WV: 4, WI: 10, WY: 3, "ME-1": 1, "ME-2": 1, "NE-1": 1, "NE-2": 1, "NE-3": 1,
};

const DIVISION = {
  "New England": ["CT", "ME", "MA", "NH", "RI", "VT"], "Mid Atlantic": ["NJ", "NY", "PA"], "East North Central": ["IL", "IN", "MI", "OH", "WI"],
  "West North Central": ["IA", "KS", "MN", "MO", "NE", "ND", "SD"], "South Atlantic": ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV"],
  "East South Central": ["AL", "KY", "MS", "TN"], "West South Central": ["AR", "LA", "OK", "TX"], Mountain: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"], Pacific: ["AK", "CA", "HI", "OR", "WA"],
};
const divisionOf = Object.fromEntries(Object.entries(DIVISION).flatMap(([d, list]) => list.map((c) => [c, d])));

async function wikitext(page) {
  const u = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(page)}`;
  const data = await (await fetch(u, { headers: UA })).json();
  if (!data.parse) throw new Error(`no page ${page}`);
  return data.parse.wikitext["*"].replace(/<ref[^>]*\/>/g, "").replace(/<ref[\s\S]*?<\/ref>/g, "");
}

const pctOf = (cell) => {
  const m = cell.replace(/'''/g, "").match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? +m[1] : null;
};

// [year, is the Democrat in the first candidate column?]
const YEARS = [[2008, true], [2012, true], [2016, true], [2020, true], [2024, false]];

function contestOf(cell) {
  const dist = cell.match(/(ME|NE)[-–]\s?(\d)/) ?? cell.match(/\b(Maine|Nebraska)(?:'s)?[^|\]]*?(1st|2nd|3rd)\b/);
  if (dist) {
    const st = dist[1] === "Maine" ? "ME" : dist[1] === "Nebraska" ? "NE" : dist[1];
    return `${st}-${dist[2][0]}`;
  }
  const link = cell.match(/\[\[[^\]|]*\|([^\]]+)\]\]/)?.[1] ?? cell.match(/\[\[([^\]]+)\]\]/)?.[1] ?? cell;
  const clean = link.replace(/'''/g, "").replace(/\s*\(.*$/, "").replace(/†.*/, "").replace(/,.*/, "").replace(/\s*(at-large|statewide)\s*$/i, "").trim();
  return CODE[clean] ?? (/^D\.?C\.?$|Washington,? D/.test(clean) ? "DC" : null);
}

async function presidential() {
  const results = {};
  for (const [year, demFirst] of YEARS) {
    const text = await wikitext(`${year} United States presidential election`);
    const start = text.indexOf("Results by state");
    const body = text.slice(start);
    const rows = body.split(/\n\|-[^\n]*/);
    let found = 0;
    for (const row of rows) {
      const cells = `\n${row}`.split(/\n\s*\|\s*(?:style="[^"]*"\s*\|\s*)?/).slice(1).flatMap((c) => c.split("||"));
      if (cells.length < 7) continue;
      const id = contestOf(cells[0]);
      if (!id || !(id in EV)) continue;
      const pcts = cells.slice(1).map(pctOf);
      const firstPct = pcts.findIndex((p) => p != null);
      const secondPct = pcts.findIndex((p, i) => p != null && i > firstPct);
      if (firstPct < 0 || secondPct < 0) continue;
      const a = pcts[firstPct];
      const b = pcts[secondPct];
      const margin = demFirst ? a - b : b - a;
      (results[id] ??= {})[year] = Math.round(margin * 100) / 100;
      found++;
      if (found > 80) break;
    }
    console.log(`${year}: ${found} rows`);
  }
  return { results };
}

// Certified popular vote margins, D minus R, as a share of all votes.
const NATIONAL_MARGIN = { 2008: 7.27, 2012: 3.86, 2016: 2.1, 2020: 4.45, 2024: -1.48 };

// Race, Hispanic origin and age from the census's open population estimates file.
async function populationFile() {
  const u = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/state/asrh/sc-est2023-alldata6.csv";
  const res = await fetch(u, { headers: UA });
  if (!res.ok) throw new Error(`census file ${res.status}`);
  const text = await res.text();
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const col = Object.fromEntries(head.split(",").map((h, i) => [h, i]));
  const sum = {};
  for (const line of lines) {
    const c = line.split(",");
    const name = c[col.NAME];
    if (+c[col.SEX] !== 0) continue;
    const code = CODE[name];
    if (!code) continue;
    const pop = +c[col.POPESTIMATE2023];
    const age = +c[col.AGE];
    const hisp = +c[col.ORIGIN];
    const race = +c[col.RACE];
    const s = (sum[code] ??= { total: 0, hisp: 0, nhWhite: 0, black: 0, asian: 0, native: 0, ageSum: 0, over65: 0 });
    if (hisp === 0) {
      s.total += pop;
      s.ageSum += pop * age;
      if (age >= 65) s.over65 += pop;
      if (race === 3) s.native += pop;
      if (race === 2) s.black += pop;
      if (race === 4) s.asian += pop;
    }
    if (hisp === 2) s.hisp += pop;
    if (hisp === 1 && race === 1) s.nhWhite += pop;
  }
  const out = {};
  for (const [code, s] of Object.entries(sum)) {
    out[code] = {
      pop: s.total,
      white: s.nhWhite / s.total, black: s.black / s.total, hispanic: s.hisp / s.total, asian: s.asian / s.total, native: s.native / s.total,
      meanAge: s.ageSum / s.total, over65: s.over65 / s.total,
    };
  }
  return out;
}

// One number per state from a Wikipedia table, taking the nth percentage in the row.
async function wikiColumn(page, nth = 0) {
  const body = await wikitext(page);
  const out = {};
  for (const row of body.split(/\n\|-[^\n]*/)) {
    const name = Object.keys(CODE).find((n) => new RegExp(`(\\[\\[|\\||\\{\\{[^}|]*\\|)\\s*${n}\\b`).test(row.slice(0, 200)));
    if (!name || out[CODE[name]] != null) continue;
    const pct = [...row.slice(row.indexOf(name) + name.length).matchAll(/(\d+(?:\.\d+)?)\s*%/g)][nth];
    if (pct) out[CODE[name]] = +pct[1] / 100;
  }
  return out;
}

const { results } = await presidential();
// The 2012 page lists these two only by district, so these are the certified statewide margins.
results.ME[2012] ??= 15.29;
results.NE[2012] ??= -21.77;
for (const id of Object.keys(EV)) {
  const have = Object.keys(results[id] ?? {}).join(",");
  if (!id.includes("-") && have !== "2008,2012,2016,2020,2024") throw new Error(`gap ${id}: ${have}`);
}
const r26 = await fetchResults2026(async (u) => (await fetch(u, { headers: UA })).json());
console.log(`2026: ${Object.keys(r26.senate).length} Senate, ${Object.keys(r26.governor).length} governor, House margin ${r26.houseMargin} over ${r26.house.seats} contested seats`);
const pop = await populationFile();
const college = await wikiColumn("List of U.S. states and territories by educational attainment", 1); // bachelor's or higher
const urban = await wikiColumn("Urbanization in the United States");
console.log(`demographics: pop ${Object.keys(pop).length}, college ${Object.keys(college).length}, urban ${Object.keys(urban).length}`);

const contests = Object.entries(EV).map(([id, ev]) => {
  const parent = id.split("-")[0];
  return {
    id, ev, parent, name: id.includes("-") ? `${NAMES[parent]} ${id.split("-")[1]}` : NAMES[id], district: id.includes("-"),
    division: divisionOf[parent], results: results[id] ?? {}, senate26: id.includes("-") ? null : r26.senate[id] ?? null, governor26: id.includes("-") ? null : r26.governor[id] ?? null,
    demo: { ...pop[parent], college: college[parent] ?? null, urban: urban[parent] ?? null },
  };
});

writeFileSync("data/states.json", JSON.stringify({ built: new Date().toISOString(), national: NATIONAL_MARGIN, house2026: r26.houseMargin, contests }, null, 1) + "\n");
const total = contests.reduce((n, c) => n + c.ev, 0);
console.log(`contests ${contests.length}, electoral votes ${total}`);
for (const id of ["PA", "GA", "ME-2", "NE-2", "DC", "TX", "WY"]) {
  const c = contests.find((x) => x.id === id);
  console.log(id, JSON.stringify(c.results), "sen26", c.senate26?.margin, "gov26", c.governor26?.margin, "college", c.demo.college, "urban", c.demo.urban, "black", c.demo.black?.toFixed(3));
}
