// Builds data/candidates.json: home states, ties to the Trump administration, statewide
// races with margins read from Wikipedia or AP, and congressional voting records.
// Run by hand when facts change: node tools/build_candidates.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { slug } from "../collect/names.mjs";

const UA = { "user-agent": "pres28-collector/1.0 (https://github.com/austinzeglis/pres28)" };
const NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii",
  IL: "Illinois", IN: "Indiana", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MO: "Missouri", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WI: "Wisconsin",
};

// S = Senate, G = governor. i = was the incumbent. Year 2026 reads from AP. A fifth value is a
// certified margin for the few whose results box can't be read: a runoff, an independent, a double ballot.
// tie: how closely voters will link them to the Trump administration, 0 to 1.
const FACTS = {
  "Gavin Newsom": { home: ["CA"], races: [[2022, "CA", "G", "i"], [2018, "CA", "G"]] },
  "Kamala Harris": { home: ["CA"] },
  "Josh Shapiro": { home: ["PA"], races: [[2026, "PA", "G", "i"], [2022, "PA", "G"]] },
  "Pete Buttigieg": { home: ["IN", "MI"] },
  "Alexandria Ocasio-Cortez": { home: ["NY"] },
  "Mark Kelly": { home: ["AZ"], races: [[2022, "AZ", "S", "i"]] },
  "J.B. Pritzker": { home: ["IL"], races: [[2026, "IL", "G", "i"], [2022, "IL", "G", "i"]] },
  "Andy Beshear": { home: ["KY"], races: [[2023, "KY", "G", "i"], [2019, "KY", "G"]] },
  "Wes Moore": { home: ["MD"], races: [[2026, "MD", "G", "i"], [2022, "MD", "G"]] },
  "Raphael Warnock": { home: ["GA"], races: [[2022, "GA", "S", "i", 2.8]] },
  "Ruben Gallego": { home: ["AZ"], races: [[2024, "AZ", "S"]] },
  "Cory Booker": { home: ["NJ"], races: [[2026, "NJ", "S", "i"], [2020, "NJ", "S", "i"]] },
  "Chris Murphy": { home: ["CT"], races: [[2024, "CT", "S", "i"]] },
  "Elissa Slotkin": { home: ["MI"], races: [[2024, "MI", "S"]] },
  "Ro Khanna": { home: ["CA"] },
  "Gretchen Whitmer": { home: ["MI"], races: [[2022, "MI", "G", "i"], [2018, "MI", "G"]] },
  "Jared Polis": { home: ["CO"], races: [[2022, "CO", "G", "i"], [2018, "CO", "G"]] },
  "Tim Walz": { home: ["MN"], races: [[2022, "MN", "G", "i"], [2018, "MN", "G"]] },
  "Amy Klobuchar": { home: ["MN"], races: [[2026, "MN", "G"], [2024, "MN", "S", "i"]] },
  "Rahm Emanuel": { home: ["IL"] },
  "Jon Ossoff": { home: ["GA"], races: [[2026, "GA", "S", "i"]] },
  "Tammy Duckworth": { home: ["IL"], races: [[2022, "IL", "S", "i"]] },
  "Brian Schatz": { home: ["HI"], races: [[2022, "HI", "S", "i"]] },
  "Chris Van Hollen": { home: ["MD"], races: [[2022, "MD", "S", "i"]] },
  "Tammy Baldwin": { home: ["WI"], races: [[2024, "WI", "S", "i"]] },
  "Mark Warner": { home: ["VA"], races: [[2026, "VA", "S", "i"]] },
  "Elizabeth Warren": { home: ["MA"], races: [[2024, "MA", "S", "i"]] },
  "John Fetterman": { home: ["PA"], races: [[2022, "PA", "S"]] },
  "Jasmine Crockett": { home: ["TX"] },
  "Pramila Jayapal": { home: ["WA"] },
  "Maura Healey": { home: ["MA"], races: [[2026, "MA", "G", "i"], [2022, "MA", "G"]] },
  "Katie Hobbs": { home: ["AZ"], races: [[2026, "AZ", "G", "i"], [2022, "AZ", "G"]] },
  "Josh Green": { home: ["HI"], races: [[2026, "HI", "G", "i"], [2022, "HI", "G"]] },
  "Josh Stein": { home: ["NC"], races: [[2024, "NC", "G"]] },
  "Roy Cooper": { home: ["NC"], races: [[2026, "NC", "S"], [2020, "NC", "G", "i"]] },
  "Gina Raimondo": { home: ["RI"], races: [[2018, "RI", "G", "i"]] },
  "Beto O'Rourke": { home: ["TX"], races: [[2022, "TX", "G"], [2018, "TX", "S"]] },
  "Stacey Abrams": { home: ["GA"], races: [[2022, "GA", "G"], [2018, "GA", "G"]] },
  "Xavier Becerra": { home: ["CA"], races: [[2026, "CA", "G"]] },
  "Julian Castro": { home: ["TX"] },
  "Phil Murphy": { home: ["NJ"], races: [[2021, "NJ", "G", "i"]] },
  "Deval Patrick": { home: ["MA"] },
  "Abigail Spanberger": { home: ["VA"], races: [[2025, "VA", "G"]] },
  "Andy Kim": { home: ["NJ"], races: [[2024, "NJ", "S"]] },
  "Chris Coons": { home: ["DE"], races: [[2026, "DE", "S", "i"]] },
  "Mitch Landrieu": { home: ["LA"] },
  "Michelle Lujan Grisham": { home: ["NM"], races: [[2022, "NM", "G", "i"]] },
  "Jason Crow": { home: ["CO"] },
  "Don Lemon": { home: ["LA"] },
  "Stephen A. Smith": { home: ["NY"] },
  "Mark Cuban": { home: ["TX"] },
  "Bernie Sanders": { home: ["VT"], races: [[2024, "VT", "S", "i", 30.9]] },
  "Catherine Cortez Masto": { home: ["NV"], races: [[2022, "NV", "S", "i"]] },
  "Debbie Stabenow": { home: ["MI"], races: [[2018, "MI", "S", "i"]] },
  "Eric Adams": { home: ["NY"] },
  "Eric Swalwell": { home: ["CA"] },
  "Hakeem Jeffries": { home: ["NY"] },
  "Gina McCarthy": { home: ["MA"] },
  "Andrew Yang": { home: ["NY"] },
  "Adam Schiff": { home: ["CA"], races: [[2024, "CA", "S", "", 17.8]] },
  "Sherrod Brown": { home: ["OH"], races: [[2026, "OH", "S"], [2018, "OH", "S", "i"]] },
  "Jeff Jackson": { home: ["NC"] },
  "Jamie Raskin": { home: ["MD"] },
  "Katie Porter": { home: ["CA"] },
  "James Talarico": { home: ["TX"], races: [[2026, "TX", "S"]] },
  "Abdul El-Sayed": { home: ["MI"], races: [[2026, "MI", "S"]] },
  "Michelle Obama": { home: ["IL"] },
  "Chelsea Clinton": { home: ["NY"] },
  "Jon Stewart": { home: ["NJ"] },

  "Donald Trump": { home: ["FL"], tie: 1 },
  "JD Vance": { home: ["OH"], tie: 1, races: [[2022, "OH", "S"]] },
  "Marco Rubio": { home: ["FL"], tie: 1, races: [[2022, "FL", "S", "i"], [2016, "FL", "S", "i"]] },
  "Ted Cruz": { home: ["TX"], tie: 0.5, races: [[2024, "TX", "S", "i"], [2018, "TX", "S", "i"]] },
  "Ron DeSantis": { home: ["FL"], tie: 0.5, races: [[2022, "FL", "G", "i"], [2018, "FL", "G"]] },
  "Donald Trump Jr.": { home: ["FL"], tie: 1 },
  "Tucker Carlson": { home: ["FL"], tie: 0.5 },
  "Pete Hegseth": { home: ["TN"], tie: 1 },
  "John Kennedy": { home: ["LA"], tie: 0.5 },
  "Sarah Huckabee Sanders": { home: ["AR"], tie: 0.75, races: [[2026, "AR", "G", "i"], [2022, "AR", "G"]] },
  "Brian Kemp": { home: ["GA"], tie: 0.25, races: [[2022, "GA", "G", "i"], [2018, "GA", "G"]] },
  "Thomas Massie": { home: ["KY"], tie: 0 },
  "Ivanka Trump": { home: ["FL"], tie: 1 },
  "Robert F. Kennedy Jr.": { home: ["CA"], tie: 1 },
  "Rand Paul": { home: ["KY"], tie: 0.25, races: [[2022, "KY", "S", "i"]] },
  "Don Bacon": { home: ["NE"], tie: 0.25 },
  "Glenn Youngkin": { home: ["VA"], tie: 0.5, races: [[2021, "VA", "G"]] },
  "Chris Christie": { home: ["NJ"], tie: 0 },
  "Josh Hawley": { home: ["MO"], tie: 0.75, races: [[2024, "MO", "S", "i"], [2018, "MO", "S"]] },
  "Marjorie Taylor Greene": { home: ["GA"], tie: 0.25 },
  "Katie Britt": { home: ["AL"], tie: 0.5, races: [[2022, "AL", "S"]] },
  "Tulsi Gabbard": { home: ["HI"], tie: 0.75 },
  "Nikki Haley": { home: ["SC"], tie: 0.25 },
  "Vivek Ramaswamy": { home: ["OH"], tie: 0.75 },
  "Byron Donalds": { home: ["FL"], tie: 0.75, races: [[2026, "FL", "G"]] },
  "Elise Stefanik": { home: ["NY"], tie: 0.75 },
  "Elon Musk": { home: ["TX"], tie: 0.75 },
  "Kristi Noem": { home: ["SD"], tie: 1, races: [[2022, "SD", "G", "i"]] },
  "Mike Pence": { home: ["IN"], tie: 0.25 },
  "Doug Burgum": { home: ["ND"], tie: 1, races: [[2020, "ND", "G", "i"]] },
  "Joe Kent": { home: ["WA"], tie: 0.75 },
  "Tom Cotton": { home: ["AR"], tie: 0.75, races: [[2026, "AR", "S", "i"]] },
  "John McEntee": { home: ["CT"], tie: 1 },
  "Tim Scott": { home: ["SC"], tie: 0.5, races: [[2022, "SC", "S", "i"]] },
  "Steve Bannon": { home: ["VA"], tie: 0.75 },
  "Greg Abbott": { home: ["TX"], tie: 0.5, races: [[2026, "TX", "G", "i"], [2022, "TX", "G", "i"]] },
  "Mike Pompeo": { home: ["KS"], tie: 0.5 },
  "Rick Scott": { home: ["FL"], tie: 0.5, races: [[2024, "FL", "S", "i"], [2018, "FL", "S"]] },
  "Spencer Cox": { home: ["UT"], tie: 0.25, races: [[2024, "UT", "G", "i"]] },
  "Lee Zeldin": { home: ["NY"], tie: 1, races: [[2022, "NY", "G"]] },
};

const STATES = JSON.parse(readFileSync("data/states.json", "utf8"));
const contests = new Map(STATES.contests.map((c) => [c.id, c]));

async function wikitext(page) {
  const u = `https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(page)}`;
  const data = await (await fetch(u, { headers: UA })).json();
  return data.parse?.wikitext?.["*"] ?? null;
}

const pageFor = (year, state, office) => {
  const name = NAMES[state];
  return office === "G" ? `${year} ${name} gubernatorial election` : `${year} United States Senate election in ${name}`;
};

// Reads the first results box: nominee and percentage by slot, with D and R labelled.
function fromInfobox(text, surname) {
  const box = text.slice(0, 12000);
  const slots = new Map();
  for (const m of box.matchAll(/\|\s*(nominee|candidate|party|percentage)(\d)\s*=\s*([^\n]*)/g)) {
    const s = slots.get(m[2]) ?? {};
    s[m[1] === "candidate" ? "nominee" : m[1]] = m[3];
    slots.set(m[2], s);
  }
  const list = [...slots.values()].filter((s) => s.percentage && (s.nominee || s.party));
  const pct = (s) => +(String(s.percentage).match(/[\d.]+/)?.[0] ?? NaN);
  const isD = (s) => /democrat/i.test(s.party ?? "");
  const isR = (s) => /republican/i.test(s.party ?? "");
  const me = list.find((s) => new RegExp(surname, "i").test(s.nominee ?? ""));
  const dem = list.find(isD);
  const rep = list.find(isR);
  if (!dem || !rep) return null;
  return { demMargin: pct(dem) - pct(rep), found: Boolean(me) };
}

const voteview = (await (await fetch("https://voteview.com/static/data/out/members/HS119_members.csv", { headers: UA })).text()).trim().split("\n");
const vvHead = voteview[0].split(",");
const col = (row, name) => row[vvHead.indexOf(name)];
const vvRows = voteview.slice(1).map((l) => l.match(/("([^"]*)"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "")));
const members = vvRows.map((r) => ({ name: col(r, "bioname"), state: col(r, "state_abbrev"), party: col(r, "party_code"), score: +col(r, "nominate_dim1"), chamber: col(r, "chamber") }))
  .filter((m) => Number.isFinite(m.score) && m.chamber !== "President");
const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const partyMedian = { D: median(members.filter((m) => m.party === "100").map((m) => m.score)), R: median(members.filter((m) => m.party === "200").map((m) => m.score)) };

const roster = JSON.parse(readFileSync("data/roster.json", "utf8"));
const out = {};
const problems = [];
for (const p of roster) {
  const facts = FACTS[p.name];
  if (!facts) problems.push(`no facts: ${p.name}`);
  const surname = p.name.replace(/ Jr\.?$/, "").split(" ").at(-1);
  const races = [];
  for (const [year, state, office, inc, fixed] of facts?.races ?? []) {
    let demMargin = fixed ?? null;
    if (fixed != null) {
      // read from the fact table
    } else if (year === 2026) {
      const r = contests.get(state)?.[office === "G" ? "governor26" : "senate26"];
      demMargin = r?.margin ?? null;
      if (r && !new RegExp(surname, "i").test(`${r.dem} ${r.rep}`)) problems.push(`${p.name}: AP lists ${r.dem}/${r.rep} in ${state} ${office} 2026`);
    } else {
      const text = await wikitext(pageFor(year, state, office));
      const got = text && fromInfobox(text, surname);
      demMargin = got?.demMargin ?? null;
      if (got && !got.found) problems.push(`${p.name}: not named in ${year} ${state} ${office}`);
    }
    if (demMargin == null || !Number.isFinite(demMargin)) {
      problems.push(`${p.name}: no margin for ${year} ${state} ${office}`);
      continue;
    }
    races.push({ year, state, office, incumbent: inc === "i", demMargin: Math.round(demMargin * 100) / 100 });
  }
  const m = members.find((x) => x.state === (facts?.home ?? [])[0] && new RegExp(`^${surname.toUpperCase()}`).test(x.name) && x.party === (p.party === "D" ? "100" : "200"))
    ?? members.find((x) => new RegExp(`^${surname.toUpperCase()},`).test(x.name) && x.party === (p.party === "D" ? "100" : "200") && (facts?.home ?? []).includes(x.state));
  out[slug(p.name)] = { home: facts?.home ?? [], tie: facts?.tie ?? null, races, nominate: m ? m.score : null };
}
writeFileSync("data/candidates.json", JSON.stringify({ built: new Date().toISOString(), partyMedian, people: out }, null, 1) + "\n");
console.log("party medians", partyMedian, "| people", Object.keys(out).length, "| with races", Object.values(out).filter((x) => x.races.length).length, "| with voting record", Object.values(out).filter((x) => x.nominate != null).length);
console.log("problems:", problems.length ? `\n  ${problems.join("\n  ")}` : "none");
for (const id of ["jon-ossoff", "josh-shapiro", "andy-beshear", "jd-vance", "ron-desantis", "greg-abbott", "alexandria-ocasio-cortez", "john-fetterman", "sherrod-brown", "james-talarico", "kamala-harris"]) {
  console.log(id, JSON.stringify(out[id].races.map((r) => [r.year, r.state, r.office, r.demMargin])), "voting", out[id].nominate);
}
