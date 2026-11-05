// Name handling shared by the roster builder and the collector.

export const fold = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Spellings the markets use for one person, in slug form.
const SAME_PERSON = {
  "donald-j-trump": "donald-trump",
  "donald-j-trump-jr": "donald-trump-jr",
  "john-n-kennedy": "john-kennedy",
  "dwayne-the-rock-johnson": "dwayne-johnson",
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

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns a function from (title, text) to the ids of the people named.
export function buildMatcher(roster) {
  const rules = roster.map((p) => ({
    id: p.id,
    full: p.match.length ? new RegExp(`(?<![\\w-])(?:${p.match.map((m) => esc(fold(m))).join("|")})(?![\\w-])`, "i") : null,
    key: p.keys.length ? new RegExp(`(?<![\\w-])(?:${p.keys.map(esc).join("|")})(?![\\w-])`) : null,
    guard: p.guard ? new RegExp(p.guard, "i") : null,
  }));
  return (title, text = "") => {
    const t = fold(title);
    const all = `${t} ${fold(text)}`;
    const found = [];
    for (const r of rules) {
      if (r.guard && !r.guard.test(all)) continue;
      if (r.full?.test(all) || r.key?.test(t)) found.push(r.id);
    }
    return found;
  };
}
