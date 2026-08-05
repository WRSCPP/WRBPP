/**
 * Planning engine test suite.
 * Run with: node src/engine.test.js
 * Zero dependencies — a tiny assert harness so this stays runnable anywhere.
 */
import {
  toISO, addDays, diffDays, isWeekend, addWorkdays, countWorkdays,
  buildDuration, effectiveStart, projectBuild, projectAll,
  detectLineOverbooking, analyzeCapacity,
  forecastBuild, forecastPortfolio, suggestStart, isWorkingDay,
} from './engine.js';

let passed = 0, failed = 0;
const fails = [];
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; fails.push(`✗ ${msg}\n    expected: ${e}\n    actual:   ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; fails.push(`✗ ${msg}`); } }

// ----------------------------- Date math -----------------------------
eq(addDays('2026-01-01', 5), '2026-01-06', 'addDays basic');
eq(addDays('2026-01-31', 1), '2026-02-01', 'addDays crosses month');
eq(addDays('2026-12-31', 1), '2027-01-01', 'addDays crosses year');
eq(diffDays('2026-01-01', '2026-01-08'), 7, 'diffDays');
eq(diffDays('2026-01-08', '2026-01-01'), -7, 'diffDays negative');

// 2026-01-03 is a Saturday, 2026-01-04 Sunday, 2026-01-05 Monday
ok(isWeekend('2026-01-03'), 'Saturday is weekend');
ok(isWeekend('2026-01-04'), 'Sunday is weekend');
ok(!isWeekend('2026-01-05'), 'Monday is not weekend');

// addWorkdays: start Mon 2026-01-05, +4 workdays -> Fri 2026-01-09
eq(addWorkdays('2026-01-05', 4), '2026-01-09', 'addWorkdays within a week');
// +5 workdays from Monday skips the weekend -> next Monday 2026-01-12
eq(addWorkdays('2026-01-05', 5), '2026-01-12', 'addWorkdays skips weekend');
// Starting on a Saturday normalizes to Monday for day 0
eq(addWorkdays('2026-01-03', 0), '2026-01-05', 'addWorkdays normalizes weekend start');
// Holidays are skipped
eq(addWorkdays('2026-01-05', 2, { holidays: ['2026-01-06'] }), '2026-01-08', 'addWorkdays skips holiday');

// countWorkdays: Mon 01-05 through Fri 01-09 inclusive = 5
eq(countWorkdays('2026-01-05', '2026-01-09'), 5, 'countWorkdays full week');
// Include a weekend: Mon 01-05 through Mon 01-12 = 6 working days
eq(countWorkdays('2026-01-05', '2026-01-12'), 6, 'countWorkdays across weekend');
eq(countWorkdays('2026-01-05', '2026-01-09', { holidays: ['2026-01-07'] }), 4, 'countWorkdays minus holiday');

// ----------------------------- Fixtures -----------------------------
const stages = [
  { id: 'frame', label: 'Framing', order: 1 },
  { id: 'mep', label: 'MEP', order: 2 },
  { id: 'finish', label: 'Finish', order: 3 },
];
const lines = [
  { id: 'A', name: 'Line A', capacity: 2, workdaysPerWeek: 5 },
  { id: 'B', name: 'Line B', capacity: 1, workdaysPerWeek: 5 },
];

function mkBuild(over = {}) {
  return {
    id: 'b1', name: 'Test', client: 'C', moduleType: 'M',
    lineId: 'A', status: 'active',
    confirmedStart: null, tentativeStart: null, targetShip: null,
    stageDurations: { frame: 5, mep: 5, finish: 5 },
    stageProgress: {}, priority: 1, ...over,
  };
}

// ----------------------------- buildDuration / effectiveStart -----------------------------
eq(buildDuration(mkBuild(), stages), 15, 'buildDuration sums stages');
eq(effectiveStart(mkBuild({ confirmedStart: '2026-02-02', tentativeStart: '2026-03-01' })), '2026-02-02', 'confirmed start wins');
eq(effectiveStart(mkBuild({ tentativeStart: '2026-03-01' })), '2026-03-01', 'falls back to tentative');
eq(effectiveStart(mkBuild()), null, 'no start -> null');

// ----------------------------- projectBuild -----------------------------
// Start Mon 2026-02-02. Frame 5 wd -> 02-02..02-06. MEP 5 wd -> 02-09..02-13. Finish 5 wd -> 02-16..02-20.
{
  const p = projectBuild(mkBuild({ confirmedStart: '2026-02-02' }), stages);
  eq(p.segments[0], { stageId: 'frame', label: 'Framing', start: '2026-02-02', end: '2026-02-06', days: 5 }, 'project frame segment');
  eq(p.segments[1].start, '2026-02-09', 'MEP starts Monday after weekend');
  eq(p.segments[2].end, '2026-02-20', 'projected ship date');
  eq(p.projectedShip, '2026-02-20', 'projectedShip matches last segment');
  ok(p.isTentative === false, 'confirmed build not tentative');
}
eq(projectBuild(mkBuild(), stages), null, 'projectBuild null when no start');

// ----------------------------- capacity / overbooking -----------------------------
// Line B capacity 1. Two overlapping builds -> overbooked.
{
  const b1 = mkBuild({ id: 'x1', lineId: 'B', confirmedStart: '2026-02-02', stageDurations: { frame: 10 } });
  const b2 = mkBuild({ id: 'x2', lineId: 'B', confirmedStart: '2026-02-04', stageDurations: { frame: 10 } });
  const proj = projectAll([b1, b2], stages);
  const res = detectLineOverbooking([b1, b2], lines[1], proj);
  ok(res.overbookedWindows.length >= 1, 'line B overbooking detected');
  ok(res.peak === 2, 'peak concurrency is 2');
}
// Line A capacity 2. Two overlapping builds -> NOT overbooked.
{
  const b1 = mkBuild({ id: 'y1', lineId: 'A', confirmedStart: '2026-02-02', stageDurations: { frame: 10 } });
  const b2 = mkBuild({ id: 'y2', lineId: 'A', confirmedStart: '2026-02-04', stageDurations: { frame: 10 } });
  const proj = projectAll([b1, b2], stages);
  const res = detectLineOverbooking([b1, b2], lines[0], proj);
  eq(res.overbookedWindows.length, 0, 'line A within capacity');
  eq(res.peak, 2, 'peak equals capacity, no overbook');
}
// Three overlapping on capacity-2 line -> overbooked.
{
  const bs = ['z1', 'z2', 'z3'].map((id, i) =>
    mkBuild({ id, lineId: 'A', confirmedStart: addDays('2026-02-02', i), stageDurations: { frame: 15 } }));
  const analysis = analyzeCapacity(bs, [lines[0]], stages);
  ok(analysis[0].isOverbooked, 'three-on-two is overbooked');
  eq(analysis[0].peak, 3, 'peak concurrency 3');
}
// Completed builds don't count against capacity.
{
  const b1 = mkBuild({ id: 'c1', lineId: 'B', confirmedStart: '2026-02-02', stageDurations: { frame: 10 }, status: 'complete' });
  const b2 = mkBuild({ id: 'c2', lineId: 'B', confirmedStart: '2026-02-04', stageDurations: { frame: 10 } });
  const analysis = analyzeCapacity([b1, b2], [lines[1]], stages);
  eq(analysis[0].isOverbooked, false, 'completed builds excluded from capacity');
}

// ----------------------------- forecasting -----------------------------
// On-track: generous target well after projected ship.
{
  const b = mkBuild({ confirmedStart: '2026-02-02', targetShip: '2026-04-01' });
  const f = forecastBuild(b, stages, {}, '2026-02-02');
  eq(f.risk, 'on-track', 'forecast on-track with big slack');
  ok(f.slackDays > 0, 'positive slack');
}
// Late: target before projected ship.
{
  const b = mkBuild({ confirmedStart: '2026-02-02', targetShip: '2026-02-10' });
  const f = forecastBuild(b, stages, {}, '2026-02-02');
  eq(f.risk, 'late', 'forecast late when target precedes projection');
  ok(f.slackDays < 0, 'negative slack when late');
}
// Progress reduces remaining work: a mostly-done build projects sooner.
{
  const b = mkBuild({
    confirmedStart: '2026-02-02', targetShip: '2026-02-20',
    stageProgress: { frame: 1, mep: 1, finish: 0.5 },
  });
  const f = forecastBuild(b, stages, {}, '2026-02-16');
  ok(f.slackDays >= 0, 'progress credited: near-done build not late');
}
// No target / no start edge cases.
eq(forecastBuild(mkBuild(), stages).risk, 'no-start', 'forecast no-start');
eq(forecastBuild(mkBuild({ confirmedStart: '2026-02-02' }), stages).risk, 'no-target', 'forecast no-target');

// Shipped build is judged on actual ship vs target, not a projection, even when
// 'today' is well past the target date (regression guard for the "shipped but
// flagged late" bug).
{
  const shipped = mkBuild({ status: 'complete', confirmedStart: '2026-02-02', targetShip: '2026-02-10', actualShip: '2026-02-10' });
  const f = forecastBuild(shipped, stages, {}, '2026-06-01'); // today far past target
  eq(f.risk, 'shipped', 'shipped-on-target build shows shipped, not late');
  ok(f.slackDays >= 0, 'on-time ship has non-negative slack');
}
{
  const shippedLate = mkBuild({ status: 'complete', confirmedStart: '2026-02-02', targetShip: '2026-02-10', actualShip: '2026-02-20' });
  const f = forecastBuild(shippedLate, stages, {}, '2026-06-01');
  eq(f.risk, 'shipped', 'late ship still classified shipped (historical fact)');
  ok(f.slackDays < 0, 'late ship has negative slack');
}
// All stages complete but not yet marked shipped, and today is past target:
// should not be flagged late purely because the calendar moved on.
{
  const done = mkBuild({ status: 'active', confirmedStart: '2026-02-02', targetShip: '2026-04-01', stageProgress: { frame: 1, mep: 1, finish: 1 } });
  const f = forecastBuild(done, stages, {}, '2026-06-01');
  ok(f.risk !== 'late', 'all-complete build not flagged late after target passes');
}

// Portfolio rollup counts by risk bucket.
{
  const bs = [
    mkBuild({ id: 'p1', confirmedStart: '2026-02-02', targetShip: '2026-05-01' }),   // on-track
    mkBuild({ id: 'p2', confirmedStart: '2026-02-02', targetShip: '2026-02-09' }),   // late
    mkBuild({ id: 'p3' }),                                                            // no-start
  ];
  const { summary } = forecastPortfolio(bs, stages, {}, '2026-02-02');
  eq(summary['on-track'], 1, 'portfolio on-track count');
  eq(summary.late, 1, 'portfolio late count');
  eq(summary['no-start'], 1, 'portfolio no-start count');
}

// ----------------------------- suggestStart -----------------------------
// Line B capacity 1, occupied 02-02..(10 wd). A new build should be pushed past the occupant.
{
  const occupant = mkBuild({ id: 'occ', lineId: 'B', confirmedStart: '2026-02-02', stageDurations: { frame: 10 } });
  const fresh = mkBuild({ id: 'new', lineId: 'B', stageDurations: { frame: 5 } });
  const s = suggestStart(fresh, lines[1], [occupant], stages, {}, '2026-02-02');
  ok(s.start !== null, 'suggestStart finds a slot');
  ok(diffDays('2026-02-02', s.start) > 0, 'suggested start is after the occupant begins');
  // The occupant's projected end is 02-13 (10 wd from 02-02). New build should start on/after 02-16.
  ok(diffDays('2026-02-13', s.start) >= 0, 'suggested start clears the occupant window');
}
// Line A capacity 2, one occupant -> new build can start immediately.
{
  const occupant = mkBuild({ id: 'occ2', lineId: 'A', confirmedStart: '2026-02-02', stageDurations: { frame: 10 } });
  const fresh = mkBuild({ id: 'new2', lineId: 'A', stageDurations: { frame: 5 } });
  const s = suggestStart(fresh, lines[0], [occupant], stages, {}, '2026-02-02');
  eq(s.start, '2026-02-02', 'suggestStart immediate when capacity available');
}

// ----------------------------- report -----------------------------

// ----------------------------------------------------------------- 4-day week
// The shop runs Mon-Thu. addWorkdays used to skip only weekends, so a 4-day line's
// dates were computed as if Friday were worked and every forecast landed early.
{
  const monFri = { holidays: [] };
  const monThu = { holidays: [], workdays: [1, 2, 3, 4] };

  ok(isWorkingDay('2026-02-13', monFri) === true, 'default calendar still treats Friday as a workday');
  ok(isWorkingDay('2026-02-13', monThu) === false, 'a Mon-Thu calendar does not');
  ok(isWorkingDay('2026-02-14', monFri) === false && isWorkingDay('2026-02-14', monThu) === false,
    'weekends are non-working either way');
  ok(isWorkingDay('2026-02-16', { holidays: ['2026-02-16'], workdays: [1, 2, 3, 4] }) === false,
    'holidays still win over the workday set');
  ok(isWorkingDay('2026-02-13', { workdays: [] }) === true, 'an empty workdays array falls back to Mon-Fri');

  // Ground truth from the shop's own Build Schedule sheet: Day One Wednesday
  // 2026-02-11, four production days (We, Th, Mo, Tu), Move Day Tuesday 2026-02-17.
  eq(addWorkdays('2026-02-11', 3, monThu), '2026-02-17', "4-day inclusive cycle lands on the sheet's move day");
  eq(addWorkdays('2026-02-11', 3, monFri), '2026-02-16', 'the old 5-day calendar landed a day early');

  eq(addWorkdays('2026-02-12', 1, monThu), '2026-02-16', 'Friday is skipped when advancing');
  // countWorkdays is inclusive of both endpoints: Wed 11 through Wed 18.
  eq(countWorkdays('2026-02-11', '2026-02-18', monThu), 5, 'countWorkdays honours a 4-day week');
  eq(countWorkdays('2026-02-11', '2026-02-18', monFri), 6, 'countWorkdays unchanged by default');

  // A ten-bay build at one 4-day pulse per bay: 40 working days.
  eq(addWorkdays('2026-02-11', 39, monThu), '2026-04-21', 'ten-bay run on a 4-day week');
  eq(addWorkdays('2026-02-11', 39, monFri), '2026-04-07', 'ten-bay run on a 5-day week is two weeks earlier');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) { console.log('\n' + fails.join('\n\n')); process.exit(1); }
else { console.log('All engine tests passed ✓'); }
