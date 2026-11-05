// Name handling shared by the roster builder and the collector.

export const fold = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Spellings the markets use for one person, in slug form.
const SAME_PERSON = {
  "donald-j-trump": "donald-trump",
  "donald-j-trump-jr": "donald-trump-jr",
  "john-n-kennedy": "john-kennedy",
  "dwayne-the-rock-johnson": "dwayne-johnson",
  "steven-bannon": "steve-bannon",
  "tim-waltz": "tim-walz",
  "rahm-emanual": "rahm-emanuel",
  "phill-murphy": "phil-murphy",
  "gregg-abbott": "greg-abbott",
  "s-huckabee-sanders": "sarah-huckabee-sanders",
  "sarah-sanders": "sarah-huckabee-sanders",
  "marjorie-greene": "marjorie-taylor-greene",
  "rfk-jr": "robert-f-kennedy-jr",
  "aoc": "alexandria-ocasio-cortez",
  "youngkin": "glenn-youngkin",
  "noem": "kristi-noem",
};

export function slug(name) {
  const base = fold(name)
    .toLowerCase()
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // "j-d-vance" and "jd-vance" are one person.
    .replace(/^([a-z])-([a-z])-/, "$1$2-");
  return SAME_PERSON[base] ?? base;
}

// Nicknames to legal first names, so a filing or voting record under a legal name still matches.
const LEGAL = {
  pete: ["peter"], josh: ["joshua"], mike: ["michael"], chris: ["christopher"], tim: ["timothy"], tom: ["thomas"], ron: ["ronald"], rick: ["richard"],
  greg: ["gregory"], jon: ["jonathan", "thomas"], andy: ["andrew"], don: ["donald"], doug: ["douglas"], wes: ["westley", "wesley"], ro: ["rohit"],
  ted: ["rafael", "edward"], jd: ["james"], rand: ["randal"], nikki: ["nimrata"], jb: ["jay"], beto: ["robert"], bernie: ["bernard"], tammy: ["ladda", "tamara"],
  steve: ["stephen"], jeff: ["jeffrey"], phil: ["philip"], debbie: ["deborah"], katie: ["katherine", "kathleen", "mary"], mitch: ["mitchell"], gina: ["regina"],
};
const SURNAME_END = (name) => fold(name).toLowerCase().replace(/[.,']/g, " ").replace(/\s+(jr|sr|ii|iii)\s*$/, "").trim().split(/\s+/).at(-1);

// Does a record like "VANCE, JAMES DAVID" or "OSSOFF, Thomas Jonathan (Jon)" belong to this person?
export function recordMatches(fullName, record) {
  const [lastPart = "", rest = ""] = fold(record).toLowerCase().split(",");
  const surname = SURNAME_END(fullName);
  const lastWords = lastPart.replace(/[.']/g, "").trim().split(/\s+/);
  if (lastWords.at(-1) !== surname && !lastPart.includes(surname)) return false;
  const isJr = /\bjr\b/.test(fold(fullName).toLowerCase());
  if (isJr !== /\bjr\b/.test(rest)) return false;
  const words = rest.replace(/[.()'"]/g, " ").split(/\s+/).filter((w) => w && !/^(mr|ms|mrs|dr|jr|sr)$/.test(w));
  const first = fold(fullName).toLowerCase().replace(/[.']/g, "").split(/\s+/)[0];
  return words.some((w) => w === first || (first.length >= 3 && w.startsWith(first)) || LEGAL[first]?.includes(w));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Office plus surname ("Gov. Moore", "Sen. Kelly") is safe for any name, unless two people
// on the roster share that surname, which needs the full name.
const OFFICE = "(?:Gov\\.|Governor|Sen\\.|Senator|Rep\\.|Representative|Secretary|Sec\\.|Vice President|VP|Vice-President|Mayor)";

// Other people and things that share a surname we match on.
const NOT_THEM = /\bBen Shapiro\b|\bHaley Stevens\b|\bDe La Cruz\b|\bCruz Azul\b|\bPenelope Cruz\b|\bChristie's\b/g;

// Returns a function from (title, text) to the ids of the people named.
export function buildMatcher(roster) {
  const count = new Map();
  for (const p of roster) {
    const s = fold(p.name).replace(/\s+Jr\.?$/, "").split(" ").at(-1);
    count.set(s, (count.get(s) ?? 0) + 1);
  }
  const rules = roster.map((p) => {
    const surname = fold(p.name).replace(/\s+Jr\.?$/, "").split(" ").at(-1);
    const keys = [...p.keys.map(esc)];
    if (count.get(surname) === 1) keys.push(`${OFFICE}\\s+(?:[A-Z][a-z.]+\\s+)?${esc(surname)}`);
    return {
      id: p.id,
      full: p.match.length ? new RegExp(`(?<![\\w-])(?:${p.match.map((m) => esc(fold(m))).join("|")})(?![\\w-])`, "i") : null,
      key: keys.length ? new RegExp(`(?<![\\w-])(?:${keys.join("|")})(?![\\w-])`) : null,
      guard: p.guard ? new RegExp(p.guard, "i") : null,
    };
  });
  return (title, text = "") => {
    const t = fold(title).replace(NOT_THEM, "");
    const all = `${t} ${fold(text).replace(NOT_THEM, "")}`;
    const found = [];
    for (const r of rules) {
      if (r.guard && !r.guard.test(all)) continue;
      if (r.full?.test(all) || r.key?.test(t)) found.push(r.id);
    }
    return found;
  };
}
