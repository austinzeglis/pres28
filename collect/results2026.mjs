// The 2026 Senate, governor and House results as AP reports them. Margins are D minus R
// as a share of all votes. House is a two-party margin over seats both parties contested.
export async function fetchResults2026(getJson) {
  const out = { senate: {}, governor: {}, house: { dem: 0, rep: 0, seats: 0 } };
  for (const kind of ["senate", "governor", "house"]) {
    const data = await getJson(`https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-${kind}.json`);
    for (const race of data.races) {
      const parties = Object.fromEntries(Object.values(race.candidate_metadata ?? {}).map((c) => [c.nyt_id, c.party?.nyt_id ?? ""]));
      const unit = race.reporting_units?.find((r) => r.level === "state" || r.level === "district") ?? race.reporting_units?.[0];
      if (!unit) continue;
      const totals = { dem: 0, rep: 0, all: 0 };
      const names = {};
      for (const c of unit.candidates ?? []) {
        const v = c.votes?.total ?? 0;
        const p = String(parties[c.nyt_id] ?? "").toLowerCase();
        totals.all += v;
        if (p.startsWith("dem")) { totals.dem += v; names.dem ??= race.candidate_metadata[c.nyt_id]?.last_name; }
        if (p.startsWith("gop") || p.startsWith("rep") || p === "r") { totals.rep += v; names.rep ??= race.candidate_metadata[c.nyt_id]?.last_name; }
      }
      if (!totals.all || !totals.dem || !totals.rep) continue;
      if (kind === "house") {
        out.house.dem += totals.dem;
        out.house.rep += totals.rep;
        out.house.seats++;
      } else {
        out[kind][unit.state_postal] = {
          margin: Math.round(((totals.dem - totals.rep) / totals.all) * 1e4) / 100,
          dem: names.dem, rep: names.rep, eevp: unit.eevp ?? null,
        };
      }
    }
  }
  const { dem, rep } = out.house;
  out.houseMargin = Math.round(((dem - rep) / (dem + rep)) * 1e4) / 100;
  return out;
}
