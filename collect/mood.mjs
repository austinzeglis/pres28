// The national mood before anyone is nominated: the long-run lean, pulled toward the
// latest vote and polling, with adjustments for the president's standing and for a
// party that has held the White House two terms. Each input is public at the time.

const MIDTERM_PULL = 0.25;
const TIME_FOR_CHANGE = 1.5;
const APPROVAL_PER_POINT = 0.05; // an assumption: too few elections to measure it
const TYPICAL_NET_APPROVAL = -10; // roughly where presidents sat two years before 2016, 2020 and 2024
const APPROVAL_CAP = 1.5;

// The latest generic ballot takes over from the midterm result as the election nears.
const genericShare = (daysLeft) => 0.25 + 0.5 * (1 - Math.min(1, (daysLeft ?? 730) / 730));

export function fundamentals(national, asOfYears, { midterm, generic, netApproval, daysLeft, inPartyTerms, inParty }) {
  const recent = asOfYears.slice(-5);
  const longRun = recent.reduce((s, y) => s + national[y], 0) / recent.length;
  const share = generic == null ? 0 : genericShare(daysLeft);
  const signal = (1 - share) * midterm + share * (generic ?? 0);
  let mood = longRun + MIDTERM_PULL * (signal - longRun);
  if (netApproval != null) {
    // A president below the usual level costs his party.
    const gap = TYPICAL_NET_APPROVAL - netApproval;
    const shift = Math.max(-APPROVAL_CAP, Math.min(APPROVAL_CAP, gap * APPROVAL_PER_POINT));
    mood += inParty === "R" ? shift : -shift;
  }
  if (inPartyTerms >= 2) mood += inParty === "D" ? -TIME_FOR_CHANGE : TIME_FOR_CHANGE;
  return mood;
}

// How the three reads of the mood combine. Weights are spread over whichever exist.
export function blendMood(reads) {
  const WEIGHT = { fundamentals: 0.4, markets: 0.4, polls: 0.2 };
  const have = Object.keys(WEIGHT).filter((k) => reads[k] != null);
  const total = have.reduce((s, k) => s + WEIGHT[k], 0);
  const pieces = have.map((k) => ({ key: k, weight: WEIGHT[k] / total, value: (reads[k] * WEIGHT[k]) / total }));
  return { center: pieces.reduce((s, p) => s + p.value, 0), pieces };
}

// Real candidates and what was known. Midterm is that cycle's House popular vote margin
// (D minus R), finalPolls the RealClearPolitics and FiveThirtyEight final averages,
// averaged. Net approval is the president's, about two years before the election. Actual
// electoral votes are as pledged on election night.
export const PAST_CASES = [
  {
    year: 2016, dem: "Clinton", rep: "Trump", midterm: -5.7, inParty: "D", inPartyTerms: 2, netApproval: -9,
    finalPolls: (3.2 + 3.6) / 2, actualEv: 232, demHome: ["NY"], repHome: ["NY"],
  },
  {
    year: 2020, dem: "Biden", rep: "Trump", midterm: 8.6, inParty: "R", inPartyTerms: 1, netApproval: -11,
    finalPolls: (7.2 + 8.4) / 2, actualEv: 306, demHome: ["DE", "PA"], repHome: ["FL"],
  },
  {
    year: 2024, dem: "Harris", rep: "Trump", midterm: -2.8, inParty: "D", inPartyTerms: 1, netApproval: -13,
    finalPolls: (-0.1 + 1.2) / 2, actualEv: 226, demHome: ["CA"], repHome: ["FL"],
  },
];
