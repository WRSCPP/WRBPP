/**
 * takt.js — production-line flow model for WRB Planner.
 *
 * Pure functions only: no DOM, no Supabase, no imports from app.js. That is
 * deliberate so this can be unit-tested from Node the way engine.js and
 * analytics.js are, and so the Shop Overview, Gantt and the pace calculator all
 * read the same numbers instead of each deriving their own.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 *
 * Builds enter at Bay 1 of their line and advance one bay at a time until they
 * leave at the last bay (Long Line 10, Short Line 6). Every build visits every
 * bay in order. The line advances as a PULSE: normally everything shifts
 * together, with occasional exceptions where one build moves alone.
 *
 * Two consequences drive everything below.
 *
 * 1. A build cannot advance into an occupied bay. The line is a queue, so one
 *    slow build stalls every build behind it. This is the single most useful
 *    thing to model and the thing a per-build duration estimate cannot express.
 *
 * 2. How long a build sits in a bay is not a fixed property of the build or of
 *    the bay — it is work content divided by the crew capacity working that bay:
 *
 *        dwell (pulses) = ceil( bay hours for this build / capacity per pulse )
 *
 *    which means "move the line faster" only works if capacity per pulse keeps
 *    up. Shortening the pulse interval shrinks capacity per pulse, so dwell in
 *    pulses rises and elapsed time may not improve at all. That is the honest
 *    answer to "how fast can we go", and it falls straight out of the model
 *    rather than needing a separate rule.
 *
 * ---------------------------------------------------------------------------
 * VOCABULARY (standard lean terms, used here as the literature uses them)
 *
 *   pulse interval  Working days between line moves. 5 = weekly, 2.5 = twice a
 *                   week. This is the takt the line is actually running.
 *   required takt   The pulse interval a build needs in order to hit its target
 *                   ship date from where it is now. What you need.
 *   achievable takt The shortest pulse interval the line can sustain, set by the
 *                   bay with the highest hours-to-capacity ratio. What you can
 *                   actually do. The bottleneck bay determines line throughput
 *                   no matter how fast the other bays are.
 *   balance         Per-bay load as a fraction of the bottleneck. Bays well
 *                   under 1.0 are idle capacity that could absorb work from the
 *                   bottleneck; this is the input to a Yamazumi-style rebalance.
 *
 * Required faster than achievable means the date is not reachable at current
 * staffing, and the gap is expressed in crew-hours at the bottleneck so it turns
 * into a staffing decision rather than a shrug.
 */

// ----------------------------- Bay ↔ stage mapping -----------------------------

/**
 * A line's bays, each carrying the ordered stage ids worked in it.
 *
 * `mapping` is { bayId: [stageId, ...] }. Anything not mapped yields a bay with
 * no stages, which contributes zero hours — so a partially configured mapping
 * degrades to optimistic rather than throwing. `bayIds` must already be in
 * physical order, Bay 1 first.
 */
export function bayPlan(bayIds, mapping = {}) {
  return bayIds.map((id, i) => ({
    id,
    index: i,
    position: i + 1,
    stages: (mapping[id] || mapping[String(id)] || []).slice(),
  }));
}

/**
 * Evenly distribute stages across bays. Used only to seed the mapping so the
 * feature is usable before anyone has configured it by hand — the real mapping
 * has to come from the floor. Earlier bays get the extra stage when the split is
 * uneven, which matches how work tends to front-load on a line.
 */
export function seedMapping(bayIds, stageIds) {
  const out = {};
  const n = bayIds.length;
  if (!n) return out;
  const per = Math.floor(stageIds.length / n);
  const extra = stageIds.length % n;
  let k = 0;
  bayIds.forEach((id, i) => {
    const take = per + (i < extra ? 1 : 0);
    out[id] = stageIds.slice(k, k + take);
    k += take;
  });
  return out;
}

// ----------------------------- Work content -----------------------------

/** Planned hours for one build in one bay: the sum of that bay's stages. */
export function bayHours(build, bay, hoursOf) {
  return bay.stages.reduce((s, stageId) => s + (Number(hoursOf(build, stageId)) || 0), 0);
}

/**
 * Standard hours per bay for a module type, averaged over reference builds
 * (normally completed ones). This is the "routing" an ERP would hold: a
 * per-product-type work content per station.
 *
 * Averaging over builds that actually logged hours in a bay, rather than over
 * every reference build, matters for the same reason it did in the Build Hours
 * Average row: a build that never reached a bay would drag its average to zero
 * and make a late bay look free.
 */
export function standardBayHours(bays, refBuilds, hoursOf) {
  const out = {};
  for (const bay of bays) {
    let total = 0, n = 0;
    for (const b of refBuilds) {
      const h = bayHours(b, bay, hoursOf);
      if (h > 0) { total += h; n += 1; }
    }
    out[bay.id] = n ? total / n : 0;
  }
  return out;
}

/**
 * Crew hours per week available to a bay.
 *
 * A person contributes to a bay when their role covers any stage worked in that
 * bay. Someone whose role spans several bays is counted in each — they are one
 * person who could work in any of them, not a fraction. That makes capacity an
 * upper bound rather than a promise, which is the right direction to err for a
 * feasibility check, and it is flagged here so nobody reads it as exact.
 */
export function bayCapacity(bay, crew, stagesForRole) {
  const stages = new Set(bay.stages.map(String));
  let hours = 0;
  for (const p of crew) {
    const covered = (stagesForRole(p.role) || []).some((s) => stages.has(String(s)));
    if (covered) hours += Number(p.weeklyHours) || 0;
  }
  return hours;
}

// ----------------------------- Traveled work -----------------------------
/**
 * A stage has a PLANNED bay, but the floor can execute it in a different bay when
 * running ahead or behind. Work that should have been done upstream and moves
 * downstream with the build is called "traveled work" — the term aerospace and
 * shipbuilding use. Boeing rebuilt its 737 line process around managing it,
 * introducing "move-ready criteria": a set of jobs that must be complete at each
 * of the 10 stations before a unit is cleared to advance.
 *
 * That is the model here, and it is deliberately not a hard constraint:
 *
 *   planned bay   where a stage is meant to happen (used for forecasting)
 *   moveReady     if true, the build should not leave its planned bay until this
 *                 stage is done; if false, the stage is allowed to travel
 *
 * Why this matters for forecasting: a build sitting in Bay 8 with Bay 6 work
 * outstanding does NOT have only bays 8-10 of work left. It carries a backlog,
 * and that backlog consumes the same crew capacity as the current bay's own work.
 * Ignoring it makes every downstream forecast optimistic, which is the direction
 * that gets promises broken.
 */

/** Flat stage -> {bay, moveReady} lookup built from a line's bay mapping. */
export function stageRouting(bays, moveReadyStages = []) {
  const ready = new Set(moveReadyStages.map(String));
  const out = new Map();
  for (const bay of bays) {
    for (const stageId of bay.stages) {
      out.set(String(stageId), { bay: bay.id, position: bay.position, moveReady: ready.has(String(stageId)) });
    }
  }
  return out;
}

/**
 * Work a build is carrying: stages whose planned bay is at or behind its current
 * position but which are not complete. `isComplete(build, stageId)` and
 * `hoursOf(build, stageId)` are supplied so this stays free of data-shape
 * assumptions.
 */
export function traveledWork(build, position, routing, hoursOf, isComplete) {
  const stages = [];
  let hours = 0;
  for (const [stageId, r] of routing) {
    if (r.position > position) continue;      // not due yet
    if (isComplete(build, stageId)) continue; // already done
    const h = Number(hoursOf(build, stageId)) || 0;
    stages.push({ stageId, plannedBay: r.bay, plannedPosition: r.position, hours: h, moveReady: r.moveReady });
    hours += h;
  }
  // Oldest debt first: the furthest upstream is the most overdue.
  stages.sort((a, b) => a.plannedPosition - b.plannedPosition);
  return { hours, stages, count: stages.length };
}

/**
 * Move-ready check: which stages planned for this bay are flagged critical and
 * still incomplete. Empty array means the build is cleared to advance.
 */
export function moveReadyBlockers(build, bay, routing, isComplete) {
  return bay.stages
    .map(String)
    .filter((stageId) => routing.get(stageId)?.moveReady && !isComplete(build, stageId));
}

/**
 * Pulses a build needs in a bay, given the work it must absorb there.
 *
 * `hours` should include any traveled backlog, because that work competes for the
 * same crew. Always at least one pulse — a bay a build passes through still
 * occupies it for a pulse.
 */
export function dwellPulses(hours, weeklyCapacity, pulseDays, workdaysPerWeek = 5) {
  const h = Number(hours) || 0;
  if (h <= 0) return 1;
  const cap = Number(weeklyCapacity) || 0;
  if (cap <= 0) return Infinity;
  const capacityPerPulse = cap * (pulseDays / workdaysPerWeek);
  if (capacityPerPulse <= 0) return Infinity;
  return Math.max(1, Math.ceil(h / capacityPerPulse));
}

// ----------------------------- Takt -----------------------------

/**
 * Cycle time of each bay in working days, for one build's work content:
 *
 *     days = hours / (weekly capacity / workdays per week)
 *
 * The largest of these is the line's cycle time — the bottleneck. A bay with no
 * capacity but real hours is infeasible rather than infinitely slow, so it is
 * reported as Infinity and the caller decides how to present that.
 */
export function bayCycleDays(hours, weeklyCapacity, workdaysPerWeek = 5) {
  const h = Number(hours) || 0;
  if (h <= 0) return 0;
  const cap = Number(weeklyCapacity) || 0;
  if (cap <= 0) return Infinity;
  return h / (cap / workdaysPerWeek);
}

/**
 * The shortest pulse interval the line can sustain, plus which bay sets it and
 * how balanced the rest are.
 */
export function achievableTakt(bays, hoursFor, capacityFor, workdaysPerWeek = 5) {
  const rows = bays.map((bay) => {
    const hours = Number(hoursFor(bay)) || 0;
    const capacity = Number(capacityFor(bay)) || 0;
    return { bay, hours, capacity, cycleDays: bayCycleDays(hours, capacity, workdaysPerWeek) };
  });
  const finite = rows.filter((r) => Number.isFinite(r.cycleDays));
  const starved = rows.filter((r) => !Number.isFinite(r.cycleDays));
  const bottleneck = rows.reduce((a, b) => (b.cycleDays > a.cycleDays ? b : a), rows[0] || null);
  const peak = bottleneck ? bottleneck.cycleDays : 0;
  const totalWork = finite.reduce((s, r) => s + r.cycleDays, 0);
  return {
    pulseDays: peak,
    bottleneck,
    rows: rows.map((r) => ({ ...r, balance: peak > 0 && Number.isFinite(r.cycleDays) ? r.cycleDays / peak : 0 })),
    starvedBays: starved.map((r) => r.bay.id),
    // Line efficiency = total work / (stations x bottleneck). 1.0 is perfectly
    // balanced; the shortfall is capacity being paid for and not used.
    lineEfficiency: rows.length && peak > 0 ? totalWork / (rows.length * peak) : 0,
  };
}

/**
 * The pulse interval a build needs to finish its remaining bays by a date.
 * `workdaysBetween` keeps the working calendar in the caller's hands so this
 * module stays free of holiday rules.
 */
export function requiredTakt(baysRemaining, from, to, workdaysBetween) {
  const n = Number(baysRemaining) || 0;
  if (n <= 0) return { pulseDays: Infinity, workdays: 0, baysRemaining: 0, feasible: true };
  const workdays = Math.max(0, workdaysBetween(from, to));
  return { pulseDays: workdays / n, workdays, baysRemaining: n, feasible: workdays > 0 };
}

/**
 * Compare what a build needs against what the line can do, and express any gap
 * as crew hours at the bottleneck so it reads as a staffing decision.
 */
export function paceGap(required, achievable, workdaysPerWeek = 5, hoursPerPerson = 40) {
  const need = required.pulseDays;
  const can = achievable.pulseDays;
  if (!Number.isFinite(need)) return { status: 'done', need, can };
  if (need <= 0) return { status: 'impossible', need, can, note: 'No working days left before the target date.' };
  if (can <= need) {
    return { status: 'ok', need, can, slackDays: can > 0 ? need - can : need };
  }
  const b = achievable.bottleneck;
  // Capacity needed at the bottleneck to bring its cycle time down to `need`.
  const neededWeekly = b && b.hours > 0 ? (b.hours * workdaysPerWeek) / need : 0;
  const deficit = Math.max(0, neededWeekly - (b ? b.capacity : 0));
  return {
    status: 'short',
    need,
    can,
    shortfallDays: can - need,
    bottleneckBay: b ? b.bay.id : null,
    extraWeeklyHours: deficit,
    extraPeople: deficit / hoursPerPerson,
  };
}

// ----------------------------- Pulse simulation -----------------------------

/**
 * Walk the line forward pulse by pulse and record when each build reaches each
 * bay and when it leaves.
 *
 * Builds are processed front-first (highest bay first) each pulse so a bay is
 * vacated before the build behind tries to enter it. That ordering is the whole
 * point: it is what produces realistic blocking instead of letting builds pass
 * through each other.
 *
 * `dwellFor(build, bay)` returns required pulses in that bay (>= 1).
 * `advanceDate(date, pulses)` moves a date forward by n pulses on the working
 * calendar, again so no calendar logic lives here.
 *
 * Returns per-build timelines plus a blocking log, which is the diagnostic worth
 * surfacing: it names which build was held up, in which bay, by which build.
 */
export function simulateLine({ bays, builds, start, dwellFor, advanceDate, maxPulses = 500 }) {
  // Furthest along first. A build with no position yet is treated as waiting to
  // enter Bay 1 (position 0) rather than being dropped.
  const state = builds
    .map((b) => ({
      build: b,
      pos: Number.isFinite(b.position) ? b.position : 0,
      // Pulses of work already completed in the current bay. Defaults to 0,
      // i.e. "just arrived" — a conservative assumption for a build that is
      // already on the line when the forecast runs. Pass `pulsesInBay` on the
      // build if the real figure is known; it shortens the first bay only.
      pulsesHere: Number.isFinite(b.pulsesInBay) ? b.pulsesInBay : 0,
      timeline: [],
      done: false,
    }))
    .sort((a, b) => b.pos - a.pos);

  const occupied = new Map(); // bay position -> state
  for (const s of state) if (s.pos >= 1) occupied.set(s.pos, s);

  const blocks = [];
  let date = start;
  let pulse = 0;

  // Record the starting position of anything already on the line.
  for (const s of state) {
    if (s.pos >= 1) s.timeline.push({ pulse: 0, date, bay: bays[s.pos - 1].id, position: s.pos, entered: true });
  }

  while (pulse < maxPulses && state.some((s) => !s.done)) {
    pulse += 1;
    date = advanceDate(date, 1);

    for (const s of state) {
      if (s.done) continue;

      // Not yet on the line: enter Bay 1 when it is free.
      if (s.pos === 0) {
        if (occupied.has(1)) { blocks.push({ pulse, date, build: s.build, bay: bays[0].id, blockedBy: occupied.get(1).build, waitingToEnter: true }); continue; }
        s.pos = 1; s.pulsesHere = 0; occupied.set(1, s);
        s.timeline.push({ pulse, date, bay: bays[0].id, position: 1, entered: true });
        continue;
      }

      const bay = bays[s.pos - 1];
      const need = Math.max(1, Math.ceil(dwellFor(s.build, bay) || 1));
      s.pulsesHere += 1;
      if (s.pulsesHere < need) continue; // still working in this bay

      // Ready to move on.
      if (s.pos >= bays.length) {
        occupied.delete(s.pos);
        s.done = true;
        s.completedPulse = pulse;
        s.completedDate = date;
        s.timeline.push({ pulse, date, bay: bay.id, position: s.pos, exited: true });
        continue;
      }
      const next = s.pos + 1;
      if (occupied.has(next)) {
        // Blocked: hold position and note who is in the way. pulsesHere keeps
        // climbing so the delay is visible rather than silently absorbed.
        blocks.push({ pulse, date, build: s.build, bay: bays[next - 1].id, blockedBy: occupied.get(next).build });
        continue;
      }
      occupied.delete(s.pos);
      s.pos = next;
      s.pulsesHere = 0; // arrival is the start of the first work interval, not the end of one
      occupied.set(next, s);
      s.timeline.push({ pulse, date, bay: bays[next - 1].id, position: next, entered: true });
    }
  }

  return {
    pulses: pulse,
    hitPulseLimit: pulse >= maxPulses && state.some((s) => !s.done),
    builds: state.map((s) => ({
      build: s.build,
      startPosition: Number.isFinite(s.build.position) ? s.build.position : 0,
      timeline: s.timeline,
      completedPulse: s.completedPulse ?? null,
      completedDate: s.completedDate ?? null,
      finished: s.done,
    })),
    blocks,
  };
}

/**
 * Flowline (line-of-balance) series: for each build, the points to draw as a
 * staircase of bay position against date. Converging lines mean one build is
 * catching up to a slower one ahead — the collision a bar chart cannot show.
 */
export function flowlineSeries(sim) {
  return sim.builds.map((b) => ({
    build: b.build,
    finished: b.finished,
    points: b.timeline.map((t) => ({ date: t.date, position: t.position, bay: t.bay, exited: !!t.exited })),
  }));
}

// ----------------------------- Shop simulation -----------------------------
/**
 * simulateShop — walks BOTH lines together and arbitrates the shared spray-foam
 * booth. This replaces simulateLine for any real forecast; simulateLine remains
 * for the single-line case and for the tests that cover it.
 *
 * Why a separate function rather than running simulateLine twice: the booth is one
 * resource with capacity 1 that both lines compete for, so the lines are not
 * independent. Run them separately and the booth's queue is invisible — you can
 * balance every bay on both lines perfectly and still be capped by the booth.
 *
 * ---------------------------------------------------------------------------
 * ROUTE
 *
 *   [Trailer]  ->  Bay 1  ->  ...  ->  Bay N
 *
 * Trailer is an optional PRE-station with its own capacity: the trailer is the
 * foundation for builds that sit on one, so it comes before Bay 1, not at the end.
 * Only lines that declare `trailer: true` have one.
 *
 * Spray foam is NOT a station in the sequence. It happens while a build is in a
 * designated bay (`foamPosition`), and the build KEEPS ITS BAY while using the
 * booth. So a foaming build occupies two resources at once and blocks its own line
 * behind it. Short Line builds cross to the Long Line's booth; there is only one
 * booth in the shop, so both lines queue for the same thing.
 *
 * Both stops are per-build (`needsTrailer`, `needsFoam`) rather than per module
 * type, because the decision is made case by case.
 *
 * ---------------------------------------------------------------------------
 * BOOTH ARBITRATION
 *
 * When more builds want the booth than it can hold, the default order is
 * longest-waiting first, then by id so runs are deterministic. Pass `boothPriority`
 * to change it — nearest due date is the obvious alternative, and which policy you
 * pick measurably changes who ships late, so it is a decision worth making
 * explicitly rather than inheriting.
 */
export function simulateShop({
  lines,
  builds,
  start,
  dwellFor,
  advanceDate,
  boothCapacity = 1,
  boothPulses = () => 1,
  trailerPulses = () => 1,
  boothPriority = null,
  maxPulses = 500,
}) {
  const lineByKey = new Map(lines.map((l) => [l.key, l]));
  const state = builds.map((b) => ({
    build: b,
    line: b.line,
    // 0 = not yet on the line, 'T' = trailer pre-station, 1..N = bay position
    pos: b.position === 'T' ? 'T' : (Number.isFinite(b.position) ? b.position : 0),
    pulsesHere: Number.isFinite(b.pulsesInBay) ? b.pulsesInBay : 0,
    foamDone: !b.needsFoam || !!b.foamDone,
    foamPulses: 0,
    holdsBooth: false,
    boothWait: 0,
    timeline: [],
    done: false,
  }));

  // Occupancy is per line: "lineKey:position". Trailer stations are per line too.
  const occupied = new Map();
  const trailerBusy = new Map();
  const keyOf = (line, pos) => `${line}:${pos}`;
  for (const s of state) {
    if (s.pos === 'T') trailerBusy.set(s.line, s);
    else if (s.pos >= 1) occupied.set(keyOf(s.line, s.pos), s);
  }

  const blocks = [];
  const boothLog = [];
  let boothHeld = 0;
  let date = start;
  let pulse = 0;

  for (const s of state) {
    const line = lineByKey.get(s.line);
    if (s.pos >= 1 && line) {
      s.timeline.push({ pulse: 0, date, position: s.pos, bay: line.bays[s.pos - 1].id, entered: true });
    } else if (s.pos === 'T') {
      s.timeline.push({ pulse: 0, date, position: 'T', bay: 'trailer', entered: true });
    }
  }

  const needFor = (s) => {
    const line = lineByKey.get(s.line);
    if (s.pos === 'T') return Math.max(1, Math.ceil(trailerPulses(s.build) || 1));
    return Math.max(1, Math.ceil(dwellFor(s.build, line.bays[s.pos - 1]) || 1));
  };
  const wantsBooth = (s) => {
    const line = lineByKey.get(s.line);
    return !s.done && typeof s.pos === 'number' && s.pos >= 1
      && line && line.foamPosition === s.pos
      && s.build.needsFoam && !s.foamDone && !s.holdsBooth
      && s.pulsesHere >= needFor(s);
  };

  while (pulse < maxPulses && state.some((s) => !s.done)) {
    pulse += 1;
    date = advanceDate(date, 1);

    // A. Age everything already in a station.
    for (const s of state) if (!s.done && (s.pos === 'T' || s.pos >= 1)) s.pulsesHere += 1;

    // B. Arbitrate the booth before anyone moves, so the grant is fair rather
    //    than an accident of which line happens to be iterated first.
    const requesters = state.filter(wantsBooth);
    const order = boothPriority || ((a, b) => (b.boothWait - a.boothWait)
      || String(a.build.id).localeCompare(String(b.build.id)));
    requesters.sort(order);
    for (const r of requesters) {
      if (boothHeld < boothCapacity) {
        r.holdsBooth = true; r.foamPulses = 0; boothHeld += 1;
        boothLog.push({ pulse, date, build: r.build, granted: true, waited: r.boothWait });
      } else {
        r.boothWait += 1;
        boothLog.push({ pulse, date, build: r.build, granted: false, waited: r.boothWait });
        blocks.push({ pulse, date, build: r.build, reason: 'booth', bay: lineByKey.get(r.line).bays[r.pos - 1].id });
      }
    }

    // C. Move, front-first within each line so a bay is vacated before the build
    //    behind it tries to enter.
    for (const line of lines) {
      const mine = state.filter((s) => s.line === line.key && !s.done).sort((a, b) => {
        const pa = a.pos === 'T' ? -0.5 : a.pos, pb = b.pos === 'T' ? -0.5 : b.pos;
        return pb - pa;
      });

      for (const s of mine) {
        // Not started: trailer first if this build needs one, else Bay 1.
        if (s.pos === 0) {
          if (s.build.needsTrailer && line.trailer) {
            if (trailerBusy.get(line.key)) {
              blocks.push({ pulse, date, build: s.build, reason: 'trailer-busy', blockedBy: trailerBusy.get(line.key).build });
              continue;
            }
            s.pos = 'T'; s.pulsesHere = 0; trailerBusy.set(line.key, s);
            s.timeline.push({ pulse, date, position: 'T', bay: 'trailer', entered: true });
            continue;
          }
          if (occupied.has(keyOf(line.key, 1))) {
            blocks.push({ pulse, date, build: s.build, reason: 'entry', bay: line.bays[0].id, blockedBy: occupied.get(keyOf(line.key, 1)).build });
            continue;
          }
          s.pos = 1; s.pulsesHere = 0; occupied.set(keyOf(line.key, 1), s);
          s.timeline.push({ pulse, date, position: 1, bay: line.bays[0].id, entered: true });
          continue;
        }

        // In the trailer station: move to Bay 1 when the trailer work is done.
        if (s.pos === 'T') {
          if (s.pulsesHere < needFor(s)) continue;
          if (occupied.has(keyOf(line.key, 1))) {
            blocks.push({ pulse, date, build: s.build, reason: 'entry', bay: line.bays[0].id, blockedBy: occupied.get(keyOf(line.key, 1)).build });
            continue;
          }
          trailerBusy.delete(line.key);
          s.pos = 1; s.pulsesHere = 0; occupied.set(keyOf(line.key, 1), s);
          s.timeline.push({ pulse, date, position: 1, bay: line.bays[0].id, entered: true });
          continue;
        }

        const bay = line.bays[s.pos - 1];
        if (s.pulsesHere < needFor(s)) continue; // still working this bay

        // Foam happens here, and the bay stays reserved throughout.
        if (line.foamPosition === s.pos && s.build.needsFoam && !s.foamDone) {
          if (s.holdsBooth) {
            s.foamPulses += 1;
            if (s.foamPulses >= Math.max(1, Math.ceil(boothPulses(s.build) || 1))) {
              s.holdsBooth = false; boothHeld -= 1; s.foamDone = true;
              s.timeline.push({ pulse, date, position: s.pos, bay: bay.id, foamed: true });
            }
          }
          continue; // waiting for, or using, the booth — either way it holds its bay
        }

        if (s.pos >= line.bays.length) {
          occupied.delete(keyOf(line.key, s.pos));
          s.done = true; s.completedPulse = pulse; s.completedDate = date;
          s.timeline.push({ pulse, date, position: s.pos, bay: bay.id, exited: true });
          continue;
        }
        const next = s.pos + 1;
        if (occupied.has(keyOf(line.key, next))) {
          blocks.push({ pulse, date, build: s.build, reason: 'blocked', bay: line.bays[next - 1].id, blockedBy: occupied.get(keyOf(line.key, next)).build });
          continue;
        }
        occupied.delete(keyOf(line.key, s.pos));
        s.pos = next; s.pulsesHere = 0;
        occupied.set(keyOf(line.key, next), s);
        s.timeline.push({ pulse, date, position: next, bay: line.bays[next - 1].id, entered: true });
      }
    }
  }

  const boothWaitTotal = boothLog.filter((b) => !b.granted).length;
  return {
    pulses: pulse,
    hitPulseLimit: pulse >= maxPulses && state.some((s) => !s.done),
    builds: state.map((s) => ({
      build: s.build, line: s.line, timeline: s.timeline,
      completedPulse: s.completedPulse ?? null,
      completedDate: s.completedDate ?? null,
      finished: s.done, boothWait: s.boothWait,
    })),
    blocks,
    boothLog,
    // Headline diagnostic: pulses lost to the booth queue across the whole shop.
    boothWaitPulses: boothWaitTotal,
  };
}

// ----------------------------- Cycle day plan -----------------------------
/**
 * planCycle — turn a pulse's worth of work into a bay x day grid, the shape of the
 * paper Build Schedule the shop already runs on.
 *
 * The point is not to reproduce that sheet but to GENERATE it, because generating
 * it catches the thing paper cannot: a crew committed to two bays on the same day.
 * On the current sheet "Hang Drywall - IA" appears in Long Bay 4 every day of the
 * cycle and in Short Bay 3 on three of them, while the crew legend lists one IA.
 * That over-commitment is invisible on paper and is exactly what shows up here as
 * a conflict.
 *
 * Deliberately dumb about work content: callers pass tasks already resolved to
 * { station, role, hours }. Deciding how a stage maps to crews and hours depends on
 * data that lives in the app, so making that decision here would bury a guess in
 * the middle of otherwise verifiable arithmetic.
 *
 * Two packing strategies, because the obvious one is wrong:
 *
 *   'earliest'  first-fit from day 1. Simple, and it FRONT-LOADS badly — on a real
 *               cycle it produced 240% / 104% / 48% / 40% day utilisation, piling
 *               everything onto day one. Kept only for comparison.
 *   'level'     (default) each task goes to the day with the most remaining
 *               capacity for its role, which spreads work the way the paper sheet
 *               does. Within a station tasks stay non-decreasing in day, so a bay's
 *               own sequence is never violated even though bays level independently.
 *
 * Greedy either way, on purpose — a plan a lead can follow and argue with beats a
 * marginally shorter one nobody can explain.
 *
 * tasks:        [{ id, station, role, hours, label?, buildId?, order? }]
 * daysPerPulse: working days in one pulse (4 on this floor: We, Th, Mo, Tu)
 * capacityFor:  (role, day) -> hours available that day across the whole shop
 */
export function planCycle({ tasks, daysPerPulse = 4, capacityFor, stationCapacityFor = null, strategy = 'level' }) {
  const days = Array.from({ length: daysPerPulse }, (_, i) => i + 1);

  // Remaining capacity per role per day, and optionally per station per day, so a
  // single bay cannot be loaded past what one bay's worth of people can do.
  const roleLeft = new Map();
  const stationLeft = new Map();
  const roleCap = new Map();
  const rkey = (role, day) => `${role}::${day}`;
  const skey = (station, day) => `${station}::${day}`;

  const ordered = [...tasks].sort((a, b) =>
    (a.order ?? 0) - (b.order ?? 0) || String(a.station).localeCompare(String(b.station)));

  const cells = new Map();      // "station::day" -> [allocation]
  const stationFloor = new Map(); // station -> earliest day a new task may use
  const unplanned = [];
  const conflicts = [];

  for (const t of ordered) {
    let remaining = Number(t.hours) || 0;
    if (remaining <= 0) {
      // Zero-hour tasks still belong on the plan so the lead sees them.
      const k = skey(t.station, 1);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push({ ...t, day: 1, hours: 0 });
      continue;
    }
    // A bay's own sequence must hold: never place a task earlier than the last day
    // already used by an earlier task at the same station.
    const floorDay = stationFloor.get(t.station) || 1;
    const allowed = days.filter((d) => d >= floorDay);
    const ensure = (day) => {
      const rk = rkey(t.role, day);
      if (!roleLeft.has(rk)) {
        const cap = Number(capacityFor(t.role, day)) || 0;
        roleLeft.set(rk, cap); roleCap.set(rk, cap);
      }
      let avail = roleLeft.get(rk);
      if (stationCapacityFor) {
        const sk = skey(t.station, day);
        if (!stationLeft.has(sk)) stationLeft.set(sk, Number(stationCapacityFor(t.station, day)) || Infinity);
        avail = Math.min(avail, stationLeft.get(sk));
      }
      return avail;
    };
    // 'level' visits the emptiest allowed day first so work spreads; 'earliest'
    // keeps the original first-fit order.
    const visitOrder = strategy === 'earliest'
      ? allowed
      : [...allowed].sort((a, b) => (ensure(b) - ensure(a)) || (a - b));

    for (const day of visitOrder) {
      if (remaining <= 0) break;
      const avail = ensure(day);
      if (avail <= 0) continue;
      const rk = rkey(t.role, day);
      const take = Math.min(remaining, avail);
      roleLeft.set(rk, roleLeft.get(rk) - take);
      if (stationCapacityFor) stationLeft.set(skey(t.station, day), stationLeft.get(skey(t.station, day)) - take);
      const k = skey(t.station, day);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push({ ...t, day, hours: take, split: take < (Number(t.hours) || 0) });
      remaining -= take;
      if (day > (stationFloor.get(t.station) || 1)) stationFloor.set(t.station, day);
    }
    if (remaining > 0) unplanned.push({ ...t, shortfallHours: remaining });
  }

  // Over-commitment report: a role whose demand across the cycle exceeded supply.
  const demand = new Map();
  for (const t of tasks) {
    const h = Number(t.hours) || 0;
    demand.set(t.role, (demand.get(t.role) || 0) + h);
  }
  for (const [role, wanted] of demand) {
    let supply = 0;
    for (const day of days) supply += Number(capacityFor(role, day)) || 0;
    if (wanted > supply + 1e-9) {
      conflicts.push({ role, demandHours: wanted, capacityHours: supply, shortfallHours: wanted - supply });
    }
  }

  // Per-day utilisation, so an unbalanced cycle is visible at a glance.
  //
  // Capacity is the WHOLE shop's capacity for that day, across every role appearing
  // in the task list. An earlier version summed only the roles that happened to be
  // examined on that day, which undercounted the denominator whenever a task was
  // pushed later by station sequencing — and reported utilisation above 100%, which
  // is impossible by construction and a clear sign the measure was wrong.
  const allRoles = [...new Set(tasks.map((t) => t.role))];
  const dayLoad = days.map((day) => {
    let cap = 0;
    for (const role of allRoles) cap += Number(capacityFor(role, day)) || 0;
    let used = 0;
    for (const [k, arr] of cells) {
      if (!k.endsWith(`::${day}`)) continue;
      for (const a of arr) used += Number(a.hours) || 0;
    }
    return { day, usedHours: used, capacityHours: cap, utilisation: cap > 0 ? used / cap : 0 };
  });

  return { cells, days, unplanned, conflicts, dayLoad };
}

/** Cells for one station as a day-indexed array, for rendering a grid row. */
export function stationRow(plan, station) {
  return plan.days.map((day) => plan.cells.get(`${station}::${day}`) || []);
}
