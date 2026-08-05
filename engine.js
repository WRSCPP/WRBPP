/**
 * Traveler Planning Engine
 * ------------------------------------------------------------------
 * Pure, dependency-free planning logic. No DOM, no storage, no framework.
 * Everything here is a pure function of its inputs so it can be unit-tested
 * in isolation and reused identically on a server or in the browser.
 *
 * This is the "engine" that makes the tool a planning instrument rather than
 * a passive dashboard: it projects schedules forward, detects when a line is
 * overbooked, and forecasts which builds are at risk of missing their dates.
 *
 * Domain model (the shapes this engine expects):
 *
 *   Build {
 *     id, name, client, moduleType,
 *     lineId,               // which production line it's assigned to
 *     status,               // 'pipeline' | 'active' | 'complete'
 *     confirmedStart,       // ISO date string or null (null = tentative)
 *     tentativeStart,       // ISO date string or null
 *     targetShip,           // ISO date string or null (contractual/target)
 *     stageDurations,       // { [stageId]: workDays }  planned days per stage
 *     stageProgress,        // { [stageId]: 0..1 }      fraction complete
 *     priority,             // integer, lower = higher priority
 *   }
 *
 *   Line {
 *     id, name,
 *     capacity,             // # of builds that can be in production at once
 *     workdaysPerWeek,      // e.g. 5
 *   }
 *
 *   Stage { id, label, order }   // ordered list defines the production sequence
 *
 *   Calendar {
 *     holidays,             // array of ISO date strings (non-working)
 *   }
 */

// ----------------------------- Date helpers -----------------------------
// All dates are handled as UTC-midnight to avoid timezone drift in planning math.

export function toDate(iso) {
  if (iso instanceof Date) return new Date(Date.UTC(iso.getUTCFullYear(), iso.getUTCMonth(), iso.getUTCDate()));
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISO(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso, n) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export function diffDays(aIso, bIso) {
  return Math.round((toDate(bIso) - toDate(aIso)) / 86400000);
}

export function isWeekend(iso) {
  const day = toDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

// Which weekdays are production days. `calendar.workdays` is a set of day numbers
// (0 = Sunday), so a Mon-Thu shop passes [1,2,3,4]. Defaults to Mon-Fri, which is
// why every existing caller and test behaves exactly as before.
//
// This exists because addWorkdays used to skip only weekends. A line configured for
// 4 days a week had its dates computed as if Friday were worked, so every forecast
// ran short on calendar time by the ratio of the two weeks — 25% for a 4-day shop,
// which is two weeks on a ten-bay build.
function workdaySet(calendar) {
  const wd = calendar && calendar.workdays;
  return Array.isArray(wd) && wd.length ? new Set(wd.map(Number)) : new Set([1, 2, 3, 4, 5]);
}
export function isWorkingDay(iso, calendar = {}) {
  const holidays = new Set((calendar && calendar.holidays) || []);
  return workdaySet(calendar).has(toDate(iso).getUTCDay()) && !holidays.has(iso);
}

/**
 * Add a number of *working* days to a start date, skipping weekends and holidays.
 * Day 0 is the start date itself (if it's a working day). Returns the ISO date
 * that is `workDays` working days after (and including) the start.
 */
export function addWorkdays(startIso, workDays, calendar = {}) {
  const isWorking = (iso) => isWorkingDay(iso, calendar);

  // Advance to the first working day on/after start.
  let cur = startIso;
  while (!isWorking(cur)) cur = addDays(cur, 1);
  if (workDays <= 0) return cur;

  let remaining = workDays;
  while (remaining > 0) {
    cur = addDays(cur, 1);
    if (isWorking(cur)) remaining--;
  }
  return cur;
}

/** Count working days in the inclusive range [startIso, endIso]. */
export function countWorkdays(startIso, endIso, calendar = {}) {
  if (diffDays(startIso, endIso) < 0) return 0;
  const holidays = new Set(calendar.holidays || []);
  let count = 0;
  let cur = startIso;
  while (diffDays(cur, endIso) >= 0) {
    if (isWorkingDay(cur, calendar)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

// ----------------------------- Schedule projection -----------------------------

/**
 * Total planned working days for a build across all stages.
 */
export function buildDuration(build, stages) {
  return stages.reduce((sum, s) => sum + (build.stageDurations?.[s.id] || 0), 0);
}

/**
 * The effective start date the planner should use for a build:
 * a confirmed start wins; otherwise the tentative start; otherwise null.
 */
export function effectiveStart(build) {
  return build.confirmedStart || build.tentativeStart || null;
}

/**
 * Project a single build's schedule: per-stage start/end dates and an overall
 * projected ship date, walking the stages in order from the effective start.
 * Returns null if the build has no start date to anchor on.
 */
export function projectBuild(build, stages, calendar = {}) {
  const start = effectiveStart(build);
  if (!start) return null;

  const ordered = [...stages].sort((a, b) => a.order - b.order);
  const segments = [];
  let cursor = start;

  for (const stage of ordered) {
    const days = build.stageDurations?.[stage.id] || 0;
    if (days <= 0) continue;
    const segStart = addWorkdays(cursor, 0, calendar); // normalize onto a working day
    const segEnd = addWorkdays(segStart, days - 1, calendar);
    segments.push({ stageId: stage.id, label: stage.label, start: segStart, end: segEnd, days });
    cursor = addWorkdays(segEnd, 1, calendar); // next stage starts the following working day
  }

  const projectedShip = segments.length ? segments[segments.length - 1].end : start;
  return {
    buildId: build.id,
    start,
    projectedShip,
    segments,
    isTentative: !build.confirmedStart,
  };
}

/**
 * Project every build. Returns a map of buildId -> projection (nulls omitted).
 */
export function projectAll(builds, stages, calendar = {}) {
  const out = {};
  for (const b of builds) {
    const p = projectBuild(b, stages, calendar);
    if (p) out[b.id] = p;
  }
  return out;
}

// ----------------------------- Capacity & conflicts -----------------------------

/**
 * Determine, for a given line, how many builds are simultaneously in production
 * on any given day, and flag the windows where that exceeds line capacity.
 *
 * Returns { overbookedWindows: [{start, end, count, capacity}], peak }.
 * A window is a maximal run of consecutive working-or-not days where the
 * concurrent count stays above capacity.
 */
export function detectLineOverbooking(lineBuilds, line, projections, calendar = {}) {
  const intervals = lineBuilds
    .map((b) => projections[b.id])
    .filter(Boolean)
    .map((p) => ({ start: p.start, end: p.projectedShip }));

  if (intervals.length === 0) return { overbookedWindows: [], peak: 0 };

  // Sweep line: collect all boundary dates, then count overlaps per day-span.
  const points = [];
  for (const iv of intervals) {
    points.push({ date: iv.start, delta: +1 });
    points.push({ date: addDays(iv.end, 1), delta: -1 }); // end is inclusive
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.delta - b.delta));

  const windows = [];
  let count = 0;
  let peak = 0;
  let runStart = null;
  let prevDate = null;

  for (let i = 0; i < points.length; i++) {
    const { date, delta } = points[i];
    // Before applying this point, the span [prevDate, date) had `count` concurrent.
    if (prevDate !== null && count > line.capacity && diffDays(prevDate, date) > 0) {
      const spanEnd = addDays(date, -1);
      if (runStart === null) runStart = prevDate;
      // extend current run to spanEnd (handled below by merging)
      windows.push({ start: prevDate, end: spanEnd, count, capacity: line.capacity });
    }
    count += delta;
    peak = Math.max(peak, count);
    prevDate = date;
  }

  // Merge adjacent/overlapping overbooked windows.
  const merged = [];
  for (const w of windows.sort((a, b) => (a.start < b.start ? -1 : 1))) {
    const last = merged[merged.length - 1];
    if (last && diffDays(last.end, w.start) <= 1) {
      last.end = w.end > last.end ? w.end : last.end;
      last.count = Math.max(last.count, w.count);
    } else {
      merged.push({ ...w });
    }
  }

  return { overbookedWindows: merged, peak };
}

/**
 * Company-wide capacity check across all lines.
 * Returns array of { lineId, lineName, overbookedWindows, peak, capacity }.
 */
export function analyzeCapacity(builds, lines, stages, calendar = {}) {
  const projections = projectAll(builds, stages, calendar);
  const activeBuilds = builds.filter((b) => b.status !== 'complete');

  return lines.map((line) => {
    const lineBuilds = activeBuilds.filter((b) => b.lineId === line.id);
    const { overbookedWindows, peak } = detectLineOverbooking(lineBuilds, line, projections, calendar);
    return {
      lineId: line.id,
      lineName: line.name,
      capacity: line.capacity,
      assignedCount: lineBuilds.length,
      peak,
      overbookedWindows,
      isOverbooked: overbookedWindows.length > 0,
    };
  });
}

// ----------------------------- Delivery risk forecasting -----------------------------

/**
 * Forecast delivery risk for a build by comparing its *projected* ship date
 * (from current progress + remaining planned work) against its target ship date.
 *
 * The projection accounts for work already done: a stage that is 50% complete
 * only consumes its remaining half of planned days from today forward.
 *
 * Returns {
 *   buildId, targetShip, projectedShip, slackDays,
 *   risk: 'on-track' | 'at-risk' | 'late' | 'no-target' | 'no-start',
 *   reason
 * }
 */
export function forecastBuild(build, stages, calendar = {}, today = toISO(new Date())) {
  const start = effectiveStart(build);

  // A build that has actually shipped is judged on reality, not a projection:
  // did its actual ship land on or before the target? This prevents a finished
  // build from ever showing a spurious "late — projected past target" once the
  // calendar moves beyond its target date.
  if (build.status === 'complete' && build.actualShip) {
    if (!build.targetShip) {
      return { buildId: build.id, risk: 'shipped', projectedShip: build.actualShip, actualShip: build.actualShip, reason: `Shipped ${fmtNice(build.actualShip)}` };
    }
    const slack = countWorkdaysSigned(build.actualShip, build.targetShip, calendar);
    return {
      buildId: build.id,
      risk: 'shipped',
      targetShip: build.targetShip,
      projectedShip: build.actualShip,
      actualShip: build.actualShip,
      slackDays: slack,
      reason: slack < 0
        ? `Shipped ${Math.abs(slack)} working day(s) past target`
        : `Shipped on time (${slack} day(s) to spare)`,
    };
  }

  if (!start) return { buildId: build.id, risk: 'no-start', reason: 'No start date set' };
  if (!build.targetShip) {
    const proj = projectBuild(build, stages, calendar);
    return {
      buildId: build.id,
      risk: 'no-target',
      projectedShip: proj?.projectedShip || null,
      reason: 'No target ship date to measure against',
    };
  }

  const ordered = [...stages].sort((a, b) => a.order - b.order);

  // Remaining working days = sum over stages of planned days * (1 - progress).
  let remainingDays = 0;
  for (const stage of ordered) {
    const planned = build.stageDurations?.[stage.id] || 0;
    const progress = Math.min(Math.max(build.stageProgress?.[stage.id] || 0, 0), 1);
    remainingDays += planned * (1 - progress);
  }
  remainingDays = Math.ceil(remainingDays);

  // If all planned work is done but the build isn't marked shipped, treat it as
  // ready now rather than projecting phantom work from today. Its effective
  // completion is its start-anchored projection, so a finished-but-unshipped
  // build doesn't get flagged late purely because today is past its target.
  if (remainingDays <= 0) {
    const proj = projectBuild(build, stages, calendar);
    const projectedShip = proj?.projectedShip || start;
    const slackDays = countWorkdaysSigned(projectedShip, build.targetShip, calendar);
    return {
      buildId: build.id,
      targetShip: build.targetShip,
      projectedShip,
      slackDays,
      risk: slackDays < 0 ? 'late' : 'on-track',
      reason: slackDays < 0
        ? `All stages complete; finished ${Math.abs(slackDays)} working day(s) past target`
        : 'All stages complete; on or ahead of target',
    };
  }

  // Anchor the remaining work at the later of (today, start) so a not-yet-started
  // build still projects from its start, and an in-flight one projects from now.
  const anchor = diffDays(today, start) > 0 ? start : today;
  const projectedShip = remainingDays > 0 ? addWorkdays(anchor, remainingDays - 1, calendar) : anchor;

  const slackDays = countWorkdaysSigned(projectedShip, build.targetShip, calendar);

  let risk, reason;
  if (slackDays < 0) {
    risk = 'late';
    reason = `Projected ${Math.abs(slackDays)} working day(s) past target`;
  } else if (slackDays <= riskBufferDays(build, stages)) {
    risk = 'at-risk';
    reason = `Only ${slackDays} working day(s) of slack remaining`;
  } else {
    risk = 'on-track';
    reason = `${slackDays} working day(s) of slack`;
  }

  return { buildId: build.id, targetShip: build.targetShip, projectedShip, slackDays, risk, reason };
}

/** Format an ISO date as a short readable label for forecast reasons. */
function fmtNice(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Signed working-day slack: positive if target is after projection, negative if before. */
function countWorkdaysSigned(projectedShip, targetShip, calendar) {
  const d = diffDays(projectedShip, targetShip);
  if (d === 0) return 0;
  if (d > 0) return countWorkdays(addDays(projectedShip, 1), targetShip, calendar);
  return -countWorkdays(addDays(targetShip, 1), projectedShip, calendar);
}

/**
 * How much slack counts as "at risk" rather than "on track" — scaled to the
 * size of the build (bigger builds need a bigger buffer). Roughly 10% of the
 * total planned duration, floored at 2 working days.
 */
function riskBufferDays(build, stages) {
  const total = buildDuration(build, stages);
  return Math.max(2, Math.round(total * 0.1));
}

/**
 * Forecast every build and roll up a portfolio summary.
 */
export function forecastPortfolio(builds, stages, calendar = {}, today = toISO(new Date())) {
  const forecasts = builds.map((b) => forecastBuild(b, stages, calendar, today));
  const summary = { late: 0, 'at-risk': 0, 'on-track': 0, 'no-target': 0, 'no-start': 0 };
  for (const f of forecasts) summary[f.risk] = (summary[f.risk] || 0) + 1;
  return { forecasts, summary };
}

// ----------------------------- Scheduling suggestions -----------------------------

/**
 * Suggest the earliest confirmed start date for a *new or tentative* build on a
 * given line such that it doesn't push the line over capacity. This is the
 * strategic-planning payoff: "when can we realistically start this?"
 *
 * Walks candidate start dates forward from `earliest`, and returns the first
 * date at which adding this build keeps concurrent load within capacity for the
 * build's whole projected duration.
 */
export function suggestStart(build, line, existingBuilds, stages, calendar = {}, earliest = toISO(new Date())) {
  const durationDays = buildDuration(build, stages);
  if (durationDays <= 0) return { start: earliest, reason: 'No planned duration; can start anytime' };

  const projections = projectAll(existingBuilds.filter((b) => b.id !== build.id && b.status !== 'complete'), stages, calendar);
  const intervals = existingBuilds
    .filter((b) => b.lineId === line.id && b.id !== build.id && b.status !== 'complete')
    .map((b) => projections[b.id])
    .filter(Boolean)
    .map((p) => ({ start: p.start, end: p.projectedShip }));

  const concurrentOn = (dayIso) =>
    intervals.filter((iv) => diffDays(iv.start, dayIso) >= 0 && diffDays(dayIso, iv.end) >= 0).length;

  // Try each working day up to ~2 years out.
  let candidate = addWorkdays(earliest, 0, calendar);
  for (let guard = 0; guard < 520; guard++) {
    const end = addWorkdays(candidate, durationDays - 1, calendar);
    // Check capacity across the whole span (sample each working day).
    let ok = true;
    let cur = candidate;
    while (diffDays(cur, end) >= 0) {
      if (isWorkingDay(cur, calendar) && concurrentOn(cur) + 1 > line.capacity) { ok = false; break; }
      cur = addDays(cur, 1);
    }
    if (ok) {
      return { start: candidate, projectedShip: end, reason: `Fits within ${line.name} capacity of ${line.capacity}` };
    }
    candidate = addWorkdays(candidate, 1, calendar);
  }
  return { start: null, reason: 'No opening found within the search horizon' };
}
