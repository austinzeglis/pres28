// The national mood before anyone is nominated: long-run lean, pulled toward the
// latest midterm, with a penalty when one party has held the White House two terms.
// Each input is something that was public two years before that election.

const LONG_RUN_CAP = 5; // past results before the test year, averaged
const MIDTERM_PULL = 0.25;
const TIME_FOR_CHANGE = 1.5;

export function fundamentals(national, asOfYears, { midterm, inPartyTerms, inParty }) {
  const recent = asOfYears.slice(-LONG_RUN_CAP);
  const longRun = recent.reduce((s, y) => s + national[y], 0) / recent.length;
  let mood = longRun + MIDTERM_PULL * (midterm - longRun);
  if (inPartyTerms >= 2) mood += inParty === "D" ? -TIME_FOR_CHANGE : TIME_FOR_CHANGE;
  return mood;
}

// Real candidates and what was known. Midterm is that cycle's House popular vote margin
// (D minus R), finalPolls the RealClearPolitics and FiveThirtyEight final averages,
// averaged. Actual electoral votes are as pledged on election night.
export const PAST_CASES = [
  {
    year: 2016, dem: "Clinton", rep: "Trump", midterm: -5.7, inParty: "D", inPartyTerms: 2,
    finalPolls: (3.2 + 3.6) / 2, actualEv: 232, demHome: ["NY"], repHome: ["NY"],
  },
  {
    year: 2020, dem: "Biden", rep: "Trump", midterm: 8.6, inParty: "R", inPartyTerms: 1,
    finalPolls: (7.2 + 8.4) / 2, actualEv: 306, demHome: ["DE", "PA"], repHome: ["FL"],
  },
  {
    year: 2024, dem: "Harris", rep: "Trump", midterm: -2.8, inParty: "D", inPartyTerms: 1,
    finalPolls: (-0.1 + 1.2) / 2, actualEv: 226, demHome: ["CA"], repHome: ["FL"],
  },
];
