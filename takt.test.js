/**
 * takt.test.js — run with: node takt.test.js
 * Matches the style of engine.test.js / store.test.js so it slots into the same suite.
 */
import {
  bayPlan, seedMapping, bayHours, standardBayHours, bayCapacity,
  bayCycleDays, achievableTakt, requiredTakt, paceGap,
  simulateLine, flowlineSeries,
  stageRouting, traveledWork, moveReadyBlockers, dwellPulses,
} from './takt.js';

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; } else { failed++; console.log(`  FAIL ${name}`); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const group = (n) => console.log(`\n${n}`);

// Simple working calendar: 5-day week, no holidays. Day 0 = Mon.
const addWorkdays = (d, n) => {
  let day = d, left = Math.round(n);
  while (left > 0) { day += 1; if (day % 7 !== 5 && day % 7 !== 6) left -= 1; }
  return day;
};
const workdaysBetween = (a, b) => { let n = 0; for (let d = a; d < b; d++) if (d % 7 !== 5 && d % 7 !== 6) n++; return n; };

// ----------------------------------------------------------------- mapping
group('bay ↔ stage mapping');
{
  const bays = bayPlan([1, 2, 3], { 1: ['s1', 's2'], 2: ['s3'] });
  ok('one entry per bay', bays.length === 3);
  ok('positions are 1-based and ordered', bays.map((b) => b.position).join() === '1,2,3');
  ok('mapped stages attach', bays[0].stages.join() === 's1,s2');
  ok('unmapped bay degrades to empty, not undefined', Array.isArray(bays[2].stages) && bays[2].stages.length === 0);
  ok('string keys also resolve', bayPlan([7], { '7': ['x'] })[0].stages.join() === 'x');

  const seed = seedMapping([1, 2, 3], ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  ok('seed covers every stage exactly once',
    Object.values(seed).flat().sort().join() === ['a','b','c','d','e','f','g'].sort().join());
  ok('seed front-loads the remainder', seed[1].length === 3 && seed[2].length === 2 && seed[3].length === 2);
  ok('seed with no bays is empty', Object.keys(seedMapping([], ['a'])).length === 0);
  ok('more bays than stages leaves later bays empty', seedMapping([1,2,3], ['a']) [3].length === 0);
}

// ----------------------------------------------------------------- work content
group('work content');
{
  const bays = bayPlan([1, 2], { 1: ['fr', 'ro'], 2: ['pt'] });
  const build = { stageHours: { fr: 100, ro: 40, pt: 60 } };
  const hoursOf = (b, s) => b.stageHours?.[s] || 0;
  ok('bay hours sum the bay stages', bayHours(build, bays[0], hoursOf) === 140);
  ok('second bay independent', bayHours(build, bays[1], hoursOf) === 60);
  ok('missing stage counts as zero', bayHours({ stageHours: {} }, bays[0], hoursOf) === 0);

  // Standard hours must ignore builds that never reached a bay, or a late bay
  // looks free — the same trap as the Build Hours average row.
  const refs = [
    { stageHours: { fr: 100, ro: 40, pt: 60 } },
    { stageHours: { fr: 120, ro: 40, pt: 80 } },
    { stageHours: { fr: 110, ro: 30 } },              // never reached Paint
  ];
  const std = standardBayHours(bays, refs, hoursOf);
  ok('bay 1 averages all three', near(std[1], (140 + 160 + 140) / 3));
  ok('bay 2 averages only builds with hours there', near(std[2], (60 + 80) / 2));
  ok('no reference data yields 0, not NaN', standardBayHours(bays, [], hoursOf)[1] === 0);
}

// ----------------------------------------------------------------- capacity
group('crew capacity');
{
  const bays = bayPlan([1, 2], { 1: ['fr'], 2: ['pt'] });
  const crew = [
    { role: 'Framing', weeklyHours: 40 },
    { role: 'Framing', weeklyHours: 30 },
    { role: 'Paint', weeklyHours: 40 },
    { role: 'Floater', weeklyHours: 40 },   // covers both
    { role: null, weeklyHours: 40 },        // no role: contributes nowhere
  ];
  const stagesForRole = (r) => ({ Framing: ['fr'], Paint: ['pt'], Floater: ['fr', 'pt'] }[r] || []);
  ok('bay 1 sums framers plus the floater', bayCapacity(bays[0], crew, stagesForRole) === 110);
  ok('bay 2 sums painter plus the floater', bayCapacity(bays[1], crew, stagesForRole) === 80);
  ok('roleless crew contribute nothing', bayCapacity(bays[0], [{ role: null, weeklyHours: 40 }], stagesForRole) === 0);
  ok('empty crew is 0', bayCapacity(bays[0], [], stagesForRole) === 0);
}

// ----------------------------------------------------------------- takt maths
group('cycle time and takt');
{
  ok('160h at 80h/wk over 5 days = 10 days', near(bayCycleDays(160, 80, 5), 10));
  ok('doubling capacity halves cycle time', near(bayCycleDays(160, 160, 5), 5));
  ok('zero hours is zero days', bayCycleDays(0, 80) === 0);
  ok('hours with no capacity is infeasible, not slow', bayCycleDays(10, 0) === Infinity);
  ok('4-day week stretches cycle time', near(bayCycleDays(160, 80, 4), 8));

  const bays = bayPlan([1, 2, 3], { 1: ['a'], 2: ['b'], 3: ['c'] });
  const hours = { 1: 40, 2: 120, 3: 40 };   // bay 2 is clearly the constraint
  const caps = { 1: 40, 2: 40, 3: 40 };
  const a = achievableTakt(bays, (b) => hours[b.id], (b) => caps[b.id], 5);
  ok('bottleneck is the worst bay', a.bottleneck.bay.id === 2);
  ok('pulse interval equals bottleneck cycle time', near(a.pulseDays, 15));
  ok('bottleneck balance is 1.0', near(a.rows.find((r) => r.bay.id === 2).balance, 1));
  ok('a third-loaded bay reports balance 1/3', near(a.rows.find((r) => r.bay.id === 1).balance, 1 / 3));
  ok('line efficiency = work / (stations x bottleneck)', near(a.lineEfficiency, (5 + 15 + 5) / (3 * 15)));
  ok('balanced line is 100% efficient',
    near(achievableTakt(bays, () => 40, () => 40, 5).lineEfficiency, 1));

  const starved = achievableTakt(bays, (b) => hours[b.id], (b) => (b.id === 2 ? 0 : 40), 5);
  ok('a bay with hours but no crew is named', starved.starvedBays.join() === '2');
  ok('starved line has infinite pulse', starved.pulseDays === Infinity);
}

// ----------------------------------------------------------------- required vs achievable
group('required takt and the gap');
{
  // 6 bays left, 30 workdays available -> 5 workdays per bay.
  const req = requiredTakt(6, 0, 42, workdaysBetween);
  ok('required pulse = workdays / bays remaining', near(req.pulseDays, 30 / 6));
  ok('nothing remaining is already done', requiredTakt(0, 0, 10, workdaysBetween).pulseDays === Infinity);
  ok('no days left is flagged infeasible', requiredTakt(3, 0, 0, workdaysBetween).feasible === false);

  const bays = bayPlan([1, 2], { 1: ['a'], 2: ['b'] });
  const fast = achievableTakt(bays, () => 40, () => 80, 5);       // 2.5 days/bay
  const slow = achievableTakt(bays, () => 160, () => 40, 5);      // 20 days/bay

  const okGap = paceGap(req, fast);
  ok('achievable faster than required is ok', okGap.status === 'ok');
  ok('slack is reported', near(okGap.slackDays, 5 - 2.5));

  const shortGap = paceGap(req, slow, 5, 40);
  ok('achievable slower than required is short', shortGap.status === 'short');
  ok('shortfall in days is reported', near(shortGap.shortfallDays, 20 - 5));
  ok('names the bottleneck bay', shortGap.bottleneckBay === 1);
  // Need 160h inside 5 days at 5 workdays/wk -> 160h/wk; have 40 -> short 120h/wk = 3 people.
  ok('extra weekly hours computed', near(shortGap.extraWeeklyHours, 120));
  ok('converted to headcount', near(shortGap.extraPeople, 3));

  ok('no days left is impossible', paceGap(requiredTakt(3, 5, 5, workdaysBetween), fast).status === 'impossible');
  ok('finished build reports done', paceGap(requiredTakt(0, 0, 10, workdaysBetween), fast).status === 'done');
}

// ----------------------------------------------------------------- traveled work
group('traveled work and move-ready criteria');
{
  // 4 bays; framing+sheathing in bay 1, rough-in in bay 2, finish in bay 3, QC in bay 4.
  const bays = bayPlan([1, 2, 3, 4], { 1: ['fr', 'sh'], 2: ['ri'], 3: ['fi'], 4: ['qc'] });
  const routing = stageRouting(bays, ['fr', 'qc']);   // framing and QC gate the move

  ok('routing maps every mapped stage', routing.size === 5);
  ok('stage knows its planned bay', routing.get('ri').bay === 2);
  ok('stage knows its planned position', routing.get('fi').position === 3);
  ok('move-ready flag is set where listed', routing.get('fr').moveReady === true);
  ok('non-critical stage is travelable', routing.get('sh').moveReady === false);
  ok('unmapped stage is absent', routing.get('nope') === undefined);

  const hours = { fr: 80, sh: 40, ri: 60, fi: 120, qc: 20 };
  const hoursOf = (b, s2) => hours[s2] || 0;
  const doneSet = (arr) => (b, s2) => arr.includes(s2);

  // Build in bay 3 with sheathing (bay 1) and rough-in (bay 2) still open.
  let tw = traveledWork({}, 3, routing, hoursOf, doneSet(['fr', 'fi']));
  ok('carries the two overdue stages', tw.count === 2);
  ok('carried hours sum correctly', tw.hours === 40 + 60);
  ok('oldest debt listed first', tw.stages[0].stageId === 'sh');
  ok('carried stage reports its planned bay', tw.stages[0].plannedBay === 1);
  ok('work not yet due is excluded', !tw.stages.some((x) => x.stageId === 'qc'));

  tw = traveledWork({}, 3, routing, hoursOf, doneSet(['fr', 'sh', 'ri', 'fi']));
  ok('fully caught up carries nothing', tw.count === 0 && tw.hours === 0);

  tw = traveledWork({}, 1, routing, hoursOf, doneSet([]));
  ok('at bay 1 only bay 1 work is due', tw.count === 2 && tw.hours === 120);

  // Move-ready gating
  ok('incomplete critical stage blocks the move',
    moveReadyBlockers({}, bays[0], routing, doneSet(['sh'])).join() === 'fr');
  ok('completing the critical stage clears the move',
    moveReadyBlockers({}, bays[0], routing, doneSet(['fr'])).length === 0);
  ok('travelable stage never blocks',
    moveReadyBlockers({}, bays[0], routing, doneSet(['fr'])).includes('sh') === false);
  ok('bay with no critical stages is always clear',
    moveReadyBlockers({}, bays[1], routing, doneSet([])).length === 0);
}

// ----------------------------------------------------------------- dwell
group('dwell from work content');
{
  // 160h at 80h/wk, weekly pulse (5 workdays) -> 80h per pulse -> 2 pulses.
  ok('dwell rounds up to whole pulses', dwellPulses(160, 80, 5, 5) === 2);
  ok('work inside one pulse is one pulse', dwellPulses(70, 80, 5, 5) === 1);
  ok('no work still occupies one pulse', dwellPulses(0, 80, 5, 5) === 1);
  ok('no capacity is infeasible', dwellPulses(10, 0, 5, 5) === Infinity);

  // The counterintuitive one: halving the pulse interval halves capacity per
  // pulse, so dwell in PULSES doubles and elapsed time does not improve.
  const weekly = dwellPulses(160, 80, 5, 5);
  const twiceWeekly = dwellPulses(160, 80, 2.5, 5);
  ok('shorter pulse needs more pulses', twiceWeekly === weekly * 2);
  ok('elapsed days are unchanged without more capacity',
    near(weekly * 5, twiceWeekly * 2.5));
  ok('adding capacity is what actually speeds it up', dwellPulses(160, 160, 2.5, 5) === 2);
}

// ----------------------------------------------------------------- pulse simulation
group('pulse simulation');
{
  const bays = bayPlan([1, 2, 3], {});
  const run = (builds, dwellFor) => simulateLine({
    bays, builds, start: 0, dwellFor, advanceDate: (d, n) => addWorkdays(d, n),
  });

  // Single build, one pulse per bay: 3 bays -> done on pulse 3.
  let s = run([{ id: 'a', position: 1 }], () => 1);
  ok('single build clears the line in one pulse per bay', s.builds[0].completedPulse === 3);
  ok('it is marked finished', s.builds[0].finished === true);
  ok('timeline records every bay', s.builds[0].timeline.filter((t) => t.entered).length === 3);
  ok('nothing blocks a lone build', s.blocks.length === 0);

  // Two builds nose to tail: the follower must never overtake.
  s = run([{ id: 'a', position: 2 }, { id: 'b', position: 1 }], () => 1);
  const posByPulse = (id) => s.builds.find((x) => x.build.id === id).timeline.map((t) => `${t.pulse}:${t.position}`);
  ok('front build finishes first', s.builds.find((x) => x.build.id === 'a').completedPulse
      < s.builds.find((x) => x.build.id === 'b').completedPulse);
  ok('follower never occupies a bay ahead of the leader', (() => {
    const A = s.builds.find((x) => x.build.id === 'a').timeline;
    const B = s.builds.find((x) => x.build.id === 'b').timeline;
    for (const bp of B) {
      const ap = [...A].reverse().find((t) => t.pulse <= bp.pulse);
      if (ap && !ap.exited && bp.position >= ap.position) return false;
    }
    return true;
  })());

  // A slow build in front must block the one behind, and say so.
  s = run([{ id: 'slow', position: 2 }, { id: 'fast', position: 1 }],
          (b) => (b.id === 'slow' ? 3 : 1));
  ok('blocking is recorded', s.blocks.length > 0);
  ok('block names who was held up', s.blocks[0].build.id === 'fast');
  ok('block names who was in the way', s.blocks[0].blockedBy.id === 'slow');
  ok('held build still finishes eventually', s.builds.find((x) => x.build.id === 'fast').finished === true);

  // Queueing to enter: a build with no position waits for Bay 1.
  s = run([{ id: 'onLine', position: 1 }, { id: 'waiting' }], () => 2);
  ok('waiting build is queued, not dropped', s.builds.some((x) => x.build.id === 'waiting'));
  ok('entry blocking is flagged', s.blocks.some((x) => x.waitingToEnter && x.build.id === 'waiting'));
  ok('waiting build enters after the bay clears',
    s.builds.find((x) => x.build.id === 'waiting').timeline.some((t) => t.position === 1));

  // Dwell longer than one pulse stretches elapsed time proportionally.
  const one = run([{ id: 'x', position: 1 }], () => 1).builds[0].completedPulse;
  const two = run([{ id: 'x', position: 1 }], () => 2).builds[0].completedPulse;
  ok('doubling dwell doubles pulses to clear', two === one * 2);

  // Guard rails.
  ok('empty build list terminates', run([], () => 1).builds.length === 0);
  ok('dwell of 0 is clamped to 1 pulse', run([{ id: 'z', position: 1 }], () => 0).builds[0].completedPulse === 3);
  const capped = simulateLine({ bays, builds: [{ id: 'q', position: 1 }], start: 0,
    dwellFor: () => 999, advanceDate: (d, n) => d + n, maxPulses: 10 });
  ok('runaway dwell hits the pulse limit instead of hanging', capped.hitPulseLimit === true);

  // Dates advance on the working calendar, skipping weekends.
  s = run([{ id: 'd', position: 1 }], () => 1);
  ok('completion date lands on a weekday', s.builds[0].completedDate % 7 !== 5 && s.builds[0].completedDate % 7 !== 6);
}

// ----------------------------------------------------------------- flowline
group('flowline series');
{
  const bays = bayPlan([1, 2, 3], {});
  const sim = simulateLine({
    bays, builds: [{ id: 'a', position: 1 }, { id: 'b' }], start: 0,
    dwellFor: () => 1, advanceDate: (d, n) => addWorkdays(d, n),
  });
  const series = flowlineSeries(sim);
  ok('one series per build', series.length === 2);
  ok('points carry date and position', series[0].points.every((p) => p.date !== undefined && p.position >= 1));
  ok('positions are monotonic per build', series.every((s2) => {
    const ps = s2.points.filter((p) => !p.exited).map((p) => p.position);
    return ps.every((v, i) => i === 0 || v >= ps[i - 1]);
  }));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('All takt tests passed ✓');
