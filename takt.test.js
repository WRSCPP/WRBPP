/**
 * takt.test.js — run with: node takt.test.js
 * Matches the style of engine.test.js / store.test.js so it slots into the same suite.
 */
import {
  bayPlan, seedMapping, bayHours, standardBayHours, bayCapacity,
  bayCycleDays, achievableTakt, requiredTakt, paceGap,
  simulateLine, flowlineSeries, simulateShop, planCycle, stationRow,
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

// ----------------------------------------------------------------- shop simulation
group('shop simulation: two lines, one shared booth');
{
  const longBays = bayPlan([1,2,3,4,5,6,7,8,9,10], {});
  const shortBays = bayPlan([1,2,3,4,5,6], {});
  const lines = [
    { key: 'long',  bays: longBays,  foamPosition: 4, trailer: false },
    { key: 'short', bays: shortBays, foamPosition: 3, trailer: true },
  ];
  const run = (builds, opts = {}) => simulateShop({
    lines, builds, start: 0, dwellFor: () => 1,
    advanceDate: (d, n) => d + n, ...opts,
  });

  // Baseline: nobody needs foam or a trailer.
  let s = run([{ id: 'a', line: 'long', position: 1 }, { id: 'b', line: 'short', position: 1 }]);
  ok('long build clears 10 bays', s.builds.find(x=>x.build.id==='a').completedPulse === 10);
  ok('short build clears 6 bays', s.builds.find(x=>x.build.id==='b').completedPulse === 6);
  ok('no booth contention when nobody foams', s.boothWaitPulses === 0);
  ok('lines run independently when nothing is shared',
    s.blocks.filter(b=>b.reason==='booth').length === 0);

  // One foamer: costs a pulse, no queue.
  s = run([{ id: 'f', line: 'long', position: 4, needsFoam: true }]);
  ok('foam adds a pulse to the run', s.builds[0].completedPulse === 8); // bays 4..10 = 7, +1 foam
  ok('foam event is recorded', s.builds[0].timeline.some(t=>t.foamed));
  ok('booth was granted immediately', s.boothLog.some(b=>b.granted && b.waited===0));

  // Two foamers arriving together, one booth: one must wait.
  s = run([
    { id: 'x', line: 'long',  position: 4, needsFoam: true },
    { id: 'y', line: 'short', position: 3, needsFoam: true },
  ]);
  ok('the booth queue is recorded', s.boothWaitPulses > 0);
  ok('exactly one build waited', s.builds.filter(x=>x.boothWait>0).length === 1);
  ok('both still finish', s.builds.every(x=>x.finished));
  ok('the waiter is blocked for the booth, not by a bay',
    s.blocks.some(b=>b.reason==='booth'));

  // Bay stays reserved: a foaming build blocks its own line behind it.
  s = run([
    { id: 'front', line: 'long', position: 4, needsFoam: true },
    { id: 'back',  line: 'long', position: 3 },
  ], { boothPulses: () => 3 });
  ok('the follower is blocked by the foaming build',
    s.blocks.some(b=>b.reason==='blocked' && b.build.id==='back' && b.blockedBy.id==='front'));
  ok('a long foam hold delays the follower',
    s.builds.find(x=>x.build.id==='back').completedPulse
      > s.builds.find(x=>x.build.id==='front').completedPulse);

  // Cross-line effect: a Short Line foamer delays a Long Line foamer.
  const solo = run([{ id: 'L', line: 'long', position: 4, needsFoam: true }])
    .builds[0].completedPulse;
  s = run([
    { id: 'L', line: 'long',  position: 4, needsFoam: true },
    { id: 'S', line: 'short', position: 3, needsFoam: true },
  ], { boothPulses: () => 2 });
  const withContention = s.builds.find(x=>x.build.id==='L').completedPulse;
  ok('cross-line booth contention is visible in the forecast', withContention >= solo);

  // Trailer pre-station
  s = run([{ id: 't', line: 'short', needsTrailer: true }]);
  ok('a trailer build starts in the trailer station',
    s.builds[0].timeline[0].position === 'T');
  ok('then enters Bay 1', s.builds[0].timeline.some(t=>t.position===1));
  ok('trailer adds to the run', s.builds[0].completedPulse === 8); // 1 trailer + 6 bays + entry pulse
  s = run([{ id: 'n', line: 'short' }]);
  ok('a build with no trailer skips the station',
    s.builds[0].timeline.every(t=>t.position!=='T'));
  s = run([{ id: 't1', line: 'short', needsTrailer: true }, { id: 't2', line: 'short', needsTrailer: true }]);
  ok('two trailer builds queue for the one station',
    s.blocks.some(b=>b.reason==='trailer-busy'));
  s = run([{ id: 'tl', line: 'long', needsTrailer: true }]);
  ok('a line without a trailer station ignores the flag',
    s.builds[0].timeline.every(t=>t.position!=='T'));

  // Arbitration policy is pluggable and actually changes the outcome.
  const builds2 = [
    { id: 'early', line: 'long',  position: 4, needsFoam: true, due: 10 },
    { id: 'late',  line: 'short', position: 3, needsFoam: true, due: 99 },
  ];
  const byDue = run(builds2, { boothPriority: (a, b) => a.build.due - b.build.due, boothPulses: () => 2 });
  ok('due-date priority gives the booth to the urgent build first',
    byDue.builds.find(x=>x.build.id==='early').boothWait === 0);

  // Guard rails
  ok('empty shop terminates', run([]).builds.length === 0);
  const capped = simulateShop({ lines, builds: [{ id: 'q', line: 'long', position: 1 }], start: 0,
    dwellFor: () => 999, advanceDate: (d,n)=>d+n, maxPulses: 8 });
  ok('runaway dwell hits the pulse limit', capped.hitPulseLimit === true);
  s = run([{ id: 'nb', line: 'long', position: 4, needsFoam: true }], { boothCapacity: 0 });
  ok('zero booth capacity does not hang', s.hitPulseLimit === true || s.builds[0].finished === false);
}

// ----------------------------------------------------------------- cycle day plan
group('cycle day plan (the Build Schedule grid)');
{
  const cap = (perDay) => () => perDay;
  // One task, one crew of 8h/day, 4-day cycle.
  let p = planCycle({ tasks: [{ id: 't1', station: 'L4', role: 'IA', hours: 8, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(8) });
  ok('a one-day task lands on day 1', (p.cells.get('L4::1') || []).length === 1);
  ok('and nowhere else', !p.cells.has('L4::2'));
  ok('nothing unplanned', p.unplanned.length === 0);
  ok('no conflict when supply covers demand', p.conflicts.length === 0);

  // A task bigger than one day splits across days.
  p = planCycle({ tasks: [{ id: 't2', station: 'L4', role: 'IA', hours: 20, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(8) });
  const spread = [1,2,3,4].map((d) => (p.cells.get(`L4::${d}`) || []).reduce((s2, a) => s2 + a.hours, 0));
  ok('splits across days', spread.filter((h) => h > 0).length === 3);
  ok('day allocations respect capacity', spread.every((h) => h <= 8 + 1e-9));
  ok('total allocated equals task hours', near(spread.reduce((a, b) => a + b, 0), 20));
  ok('split allocations are flagged', (p.cells.get('L4::1') || [])[0].split === true);

  // Work that cannot fit the cycle is reported, not silently dropped.
  p = planCycle({ tasks: [{ id: 't3', station: 'L4', role: 'IA', hours: 100, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(8) });
  ok('overflow is reported as unplanned', p.unplanned.length === 1);
  ok('shortfall is quantified', near(p.unplanned[0].shortfallHours, 100 - 32));
  ok('and as a role conflict', p.conflicts[0].role === 'IA');
  ok('conflict states demand and capacity',
    near(p.conflicts[0].demandHours, 100) && near(p.conflicts[0].capacityHours, 32));

  // THE CASE FROM THE PAPER SHEET: one IA crew committed to two bays at once.
  p = planCycle({
    tasks: [
      { id: 'long',  station: 'L4', role: 'IA', hours: 32, order: 1 },
      { id: 'short', station: 'S3', role: 'IA', hours: 24, order: 2 },
    ],
    daysPerPulse: 4, capacityFor: cap(8),   // one person, 8h/day, 32h for the cycle
  });
  ok('cross-bay over-commitment is detected', p.conflicts.length === 1);
  ok('it names the crew', p.conflicts[0].role === 'IA');
  ok('shortfall equals the excess', near(p.conflicts[0].shortfallHours, 56 - 32));
  ok('the first bay is fully planned',
    near([1,2,3,4].reduce((s2, d) => s2 + (p.cells.get(`L4::${d}`) || []).reduce((a, x) => a + x.hours, 0), 0), 32));
  ok('the second bay is what goes short', p.unplanned[0].station === 'S3');

  // Different roles do not compete.
  p = planCycle({
    tasks: [
      { id: 'a', station: 'L4', role: 'IA', hours: 32, order: 1 },
      { id: 'b', station: 'S3', role: 'IB', hours: 32, order: 2 },
    ],
    daysPerPulse: 4, capacityFor: cap(8),
  });
  ok('separate crews both fit', p.unplanned.length === 0 && p.conflicts.length === 0);

  // Precedence: lower order is placed first and therefore wins scarce capacity.
  p = planCycle({
    tasks: [
      { id: 'late',  station: 'L4', role: 'IA', hours: 32, order: 9 },
      { id: 'early', station: 'L4', role: 'IA', hours: 32, order: 1 },
    ],
    daysPerPulse: 4, capacityFor: cap(8),
  });
  ok('earlier stage order gets capacity first', p.unplanned[0].id === 'late');

  // Per-station cap: one bay cannot absorb more than a bay's worth of people.
  p = planCycle({
    tasks: [{ id: 'x', station: 'L4', role: 'HS', hours: 40, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(30), stationCapacityFor: () => 8,
  });
  const perDay = [1,2,3,4].map((d) => (p.cells.get(`L4::${d}`) || []).reduce((s2, a) => s2 + a.hours, 0));
  ok('station capacity caps a single bay per day', perDay.every((h) => h <= 8 + 1e-9));
  ok('the rest overflows to unplanned', p.unplanned.length === 1);

  // Utilisation per day, and zero-hour tasks still appear on the plan.
  p = planCycle({ tasks: [{ id: 'z', station: 'L1', role: 'CS', hours: 0, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(8) });
  ok('a zero-hour task still shows on day 1', (p.cells.get('L1::1') || []).length === 1);
  p = planCycle({ tasks: [{ id: 'u', station: 'L4', role: 'IA', hours: 16, order: 1 }],
    daysPerPulse: 4, capacityFor: cap(8) });
  ok('day 1 is fully utilised', near(p.dayLoad[0].utilisation, 1));
  ok('unused days report zero utilisation', p.dayLoad[3].usedHours === 0);

  // stationRow gives a renderable row.
  const row = stationRow(p, 'L4');
  ok('stationRow returns one entry per day', row.length === 4);
  ok('entries are arrays of allocations', Array.isArray(row[0]) && row[0][0].role === 'IA');
  ok('empty days are empty arrays', Array.isArray(row[3]) && row[3].length === 0);

  // Level-loading must spread work instead of front-loading it, and must still
  // respect a bay's own sequence.
  {
    const cap8 = () => 8;
    const many = [1,2,3,4].map((i) => ({ id: 'b'+i, station: 'B'+i, role: 'IA', hours: 8, order: 1 }));
    const level = planCycle({ tasks: many, daysPerPulse: 4, capacityFor: () => 32 });
    const perDayLevel = level.dayLoad.map((d) => d.usedHours);
    const earliest = planCycle({ tasks: many, daysPerPulse: 4, capacityFor: () => 32, strategy: 'earliest' });
    const perDayEarly = earliest.dayLoad.map((d) => d.usedHours);
    ok('earliest-fit front-loads', perDayEarly[0] === 32 && perDayEarly[3] === 0);
    ok('level spreads across days', perDayLevel.filter((h) => h > 0).length === 4);
    ok('level uses the same total', near(perDayLevel.reduce((a,b)=>a+b,0), perDayEarly.reduce((a,b)=>a+b,0)));

    // Within one station, a later-ordered task may not land before an earlier one.
    const seq = planCycle({
      tasks: [
        { id: 'first',  station: 'L1', role: 'FB', hours: 8, order: 1 },
        { id: 'second', station: 'L1', role: 'WB', hours: 8, order: 2 },
        { id: 'third',  station: 'L1', role: 'UA', hours: 8, order: 3 },
      ],
      daysPerPulse: 4, capacityFor: cap8,
    });
    const dayOf = (id) => {
      for (const [k, arr] of seq.cells) for (const a of arr) if (a.id === id) return a.day;
      return null;
    };
    ok('station sequence is preserved under level-loading',
      dayOf('first') <= dayOf('second') && dayOf('second') <= dayOf('third'));
  }

  // Utilisation must be a true fraction of shop capacity — never above 100%.
  {
    const p2 = planCycle({
      tasks: [
        { id: 'a', station: 'L1', role: 'FB', hours: 8,  order: 1 },
        { id: 'b', station: 'L1', role: 'WB', hours: 8,  order: 2 },
        { id: 'c', station: 'L2', role: 'IA', hours: 32, order: 3 },
      ],
      daysPerPulse: 4, capacityFor: () => 8,
    });
    ok('utilisation never exceeds 100%', p2.dayLoad.every((d) => d.utilisation <= 1 + 1e-9));
    ok('capacity counts every role each day', p2.dayLoad.every((d) => d.capacityHours === 24));
    ok('used hours equal what was actually allocated',
      near(p2.dayLoad.reduce((s3, d) => s3 + d.usedHours, 0),
           [...p2.cells.values()].flat().reduce((s3, a) => s3 + a.hours, 0)));
  }

  ok('no tasks yields an empty plan', planCycle({ tasks: [], daysPerPulse: 4, capacityFor: cap(8) }).cells.size === 0);
  ok('zero capacity plans nothing and reports it',
    planCycle({ tasks: [{ id: 'q', station: 'L1', role: 'X', hours: 8, order: 1 }], daysPerPulse: 4, capacityFor: cap(0) }).unplanned.length === 1);
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
