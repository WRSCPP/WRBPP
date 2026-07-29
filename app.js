/**
 * Traveler application controller.
 * Wires the planning engine and persistence layer into the UI.
 *
 * Data flow (one direction, predictable):
 *   user action -> repo write -> repo emits change event -> render()
 * The UI never holds authoritative state; storage does. Every view is a pure
 * render of what's in the repository plus what the engine computes from it.
 */
import { Repository } from './store.js';
import { hydrateSigned, attachmentHref } from './signed-urls.js';
import {
  projectAll, projectBuild, analyzeCapacity, forecastPortfolio, forecastBuild,
  suggestStart, buildDuration, effectiveStart, toISO, addWorkdays,
} from './engine.js';
import { buildReport } from './analytics.js';
import { SEED_BUILDS, SEED_LINES, SEED_STAGES, SEED_SETTINGS } from './seed.js';

const repo = new Repository();

// Whether this session may write.
//
// Fails CLOSED in cloud mode. __TRAVELER_CLOUD__ is set by every version of
// main.js that runs cloud mode, so its presence means "a server is involved" —
// and in that case write access must be granted explicitly by an is_editor()
// check, never assumed. The earlier `!== false` test defaulted to true when the
// flag was absent, so a stale main.js silently handed every viewer an editable
// interface. Being wrongly read-only is a complaint; being wrongly writable is
// a data-integrity problem.
//
// In local mode there is no cloud module and one desktop user, who always can.
const CAN_WRITE = globalThis.__TRAVELER_CLOUD__
  ? globalThis.__TRAVELER_CAN_WRITE__ === true
  : globalThis.__TRAVELER_CAN_WRITE__ !== false;

if (globalThis.__TRAVELER_CLOUD__ && globalThis.__TRAVELER_CAN_WRITE__ === undefined) {
  console.warn(
    'Production Planner: main.js did not report write permission, so this session is ' +
    'read-only. This usually means main.js is an older version than app.js — ' +
    'redeploy main.js.');
}

// Who to record in the audit trail. In cloud mode this is the signed-in email,
// so "who changed this build" is answerable across editors and shared accounts.
function actor() { return globalThis.__TRAVELER_ACTOR__ || 'user'; }

// Which Settings cards are expanded. Keyed by heading text and held at module
// scope because every save re-renders the tab, which would otherwise snap
// everything shut mid-edit.
const openSettingsCards = new Set();

/**
 * Turn each .settings-card into a collapsible tile: the heading becomes the
 * control, everything after it becomes the body.
 *
 * Done as a post-render DOM pass rather than by editing the card templates, so
 * the markup and its delegated #settingsRoot handlers are untouched — and any
 * card added later is picked up automatically.
 */
function makeSettingsCollapsible() {
  const root = $('#settingsRoot');
  if (!root) return;

  root.querySelectorAll('.settings-card').forEach((card) => {
    const h3 = card.querySelector('h3');
    if (!h3 || card.dataset.tile) return;
    card.dataset.tile = '1';

    const key = (h3.textContent || '').replace(/\s+/g, ' ').trim();
    const body = document.createElement('div');
    body.className = 'settings-card-body';
    while (h3.nextSibling) body.appendChild(h3.nextSibling);
    card.appendChild(body);

    const head = document.createElement('div');
    head.className = 'tile-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    h3.replaceWith(head);
    head.appendChild(h3);
    const chev = document.createElement('span');
    chev.className = 'tile-chevron';
    chev.textContent = '\u203a';
    head.appendChild(chev);

    const apply = () => {
      const open = openSettingsCards.has(key);
      card.classList.toggle('tile-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    apply();

    const toggle = () => {
      if (openSettingsCards.has(key)) openSettingsCards.delete(key);
      else openSettingsCards.add(key);
      apply();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}
// Timestamp until which the modal should not be force-rebuilt by data-change
// events — set briefly during rapid in-modal edits (e.g. logging stage hours) so
// the DOM stays authoritative and edits aren't clobbered by the async refresh.
let suppressModalRerenderUntil = 0;
let suppressHoursRerenderUntil = 0;

const state = {
  tab: 'dashboard',
  builds: [], lines: [], stages: [], settings: {},
  search: '', lineFilter: 'all',
  hoursFilters: { year: 'all', status: 'all', moduleType: 'all', search: '' },
  hoursColWidths: {}, // per-column pixel widths set by dragging the resize handles
  crewRoleFilter: 'all', // Settings > Crew role filter
  scenario: null, // { buildId, date } for the What-If tool
  openBuildId: null,
  modalTab: 'details',
  today: toISO(new Date()),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtShort = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

// ----------------------------- Boot -----------------------------
async function boot() {
  if (CAN_WRITE && await repo.isEmpty()) {
    await repo.seed({ builds: SEED_BUILDS, lines: SEED_LINES, stages: SEED_STAGES, settings: SEED_SETTINGS });
  }
  await refresh();
  // Backfill for existing installs: if the new crew/inspection lists don't exist
  // yet (data predates these features), seed the defaults without touching any
  // other settings. Existing builds, hours, lines, and stages are untouched.
  if (CAN_WRITE && (!state.settings.people || !state.settings.inspections || !state.settings.roles)) {
    const patch = { ...state.settings };
    if (!patch.people) patch.people = SEED_SETTINGS.people;
    if (!patch.inspections) patch.inspections = SEED_SETTINGS.inspections;
    if (!patch.roles) {
      // Seed the roles list from any roles already typed against existing crew,
      // then top up with the defaults so nothing in use is lost.
      const existing = [...new Set((patch.people || []).map((p) => (p.role || '').trim()).filter(Boolean))];
      patch.roles = [...new Set([...existing, ...SEED_SETTINGS.roles])];
    }
    await repo.saveSettings(patch);
    await refresh();
  }
  // The inspection contact fields used to live on each inspection point. Lift the
  // first non-empty value up to the build so nothing entered earlier is lost.
  for (const b of state.builds) {
    if (!CAN_WRITE || b.inspectionInfo || !b.inspectionData) continue;
    const info = {};
    for (const key of ['company', 'inspector', 'contact', 'date']) {
      for (const entry of Object.values(b.inspectionData)) {
        if (entry && entry[key]) { info[key] = entry[key]; break; }
      }
    }
    if (Object.keys(info).length) await patchBuild(b.id, { inspectionInfo: info });
  }
  // One-time cleanup: the old "New Build" behavior created a build immediately,
  // leaving blank "Untitled" builds in the feed. Remove any that were never named
  // and never given a start/ship date (i.e. clearly abandoned drafts).
  const orphans = state.builds.filter((b) => (!b.name || !b.name.trim())
    && !b.confirmedStart && !b.tentativeStart && !b.targetShip && !b.actualShip
    && b.status === 'pipeline');
  if (CAN_WRITE && orphans.length) {
    for (const o of orphans) await repo.deleteBuild(o.id, 'cleanup');
    await refresh();
  }
  // On any data change: refresh cache, then re-render — but coalesce rapid changes
  // and never yank the modal out from under an input the user is actively editing.
  let renderQueued = false;
  const onDataChange = async () => {
    await refresh();
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      // Skip the full re-render while actively editing the Build Hours grid, so
      // tabbing between cells doesn't rebuild the DOM and lose focus. The edited
      // row updates its own totals live via updateHoursRowLive.
      if (state.tab === 'hours' && Date.now() < suppressHoursRerenderUntil) return;
      render();
      // Skip the modal rebuild briefly after an in-modal edit so rapid successive
      // field/stage edits aren't reset by the async save→refresh cycle (the modal
      // keeps its own displays live in the meantime).
      if (state.openBuildId && Date.now() >= suppressModalRerenderUntil) renderBuildModalPreservingFocus();
    });
  };
  ['builds:changed', 'lines:changed', 'stages:changed', 'settings:changed', 'seeded']
    .forEach((e) => repo.addEventListener(e, onDataChange));

  // Cloud mode: a change made on someone else's machine arrives here. Pull the
  // fresh records into state, then reuse the same render path. The suppress
  // timers above keep it from yanking the DOM out from under an active edit.
  window.addEventListener('traveler:remote-change', async () => {
    await refresh();
    onDataChange();
  });

  wireGlobalEvents();
  render();
}

async function refresh() {
  [state.builds, state.lines, state.stages, state.settings] = await Promise.all([
    repo.listBuilds(), repo.listLines(), repo.listStages(), repo.getSettings(),
  ]);
}

// ----------------------------- Derived (engine) -----------------------------
function calendar() { return { holidays: state.settings.holidays || [] }; }
function projections() { return projectAll(state.builds, state.stages, calendar()); }

// A compact "working-days timeline" for a single build — a small bar spanning its
// projected start→ship, colored by forecast risk, with a target-ship tick. Used on
// the Dashboard and Board so each build shows its schedule at a glance, echoing the
// Gantt. Returns '' when the build has no start date to plot.
function miniTimeline(build, proj) {
  const p = proj || projectBuild(build, state.stages, calendar());
  if (!p || !p.start) return '';

  // Progress = share of planned working days actually completed across stages.
  let plannedTotal = 0, doneTotal = 0;
  for (const s of state.stages) {
    const planned = build.stageDurations?.[s.id] || 0;
    const prog = Math.min(Math.max(build.stageProgress?.[s.id] || 0, 0), 1);
    plannedTotal += planned;
    doneTotal += planned * prog;
  }
  const progressPct = plannedTotal ? Math.round(doneTotal / plannedTotal * 100) : 0;

  // A completed build is fully done — fill the whole track, label with actual dates.
  if (build.status === 'complete' && build.actualShip) {
    const start = build.actualStart || p.start;
    return `<div class="mini-tl">
      <div class="mtl-track"><div class="mtl-bar" style="width:100%;background:var(--shipped)"></div></div>
      <div class="mtl-dates"><span>${fmtShort(start)}</span><span>${fmtShort(build.actualShip)}</span></div>
    </div>`;
  }

  const f = forecastBuild(build, state.stages, calendar(), state.today);
  const color = f.risk === 'late' ? 'var(--rust)' : f.risk === 'at-risk' ? 'var(--amber)' : 'var(--teal)';

  // The track runs start → target ship (the deadline). The fill shows how much of
  // the work is done. A "today" marker shows where we are on that timeline, so you
  // can see at a glance whether progress is keeping pace with the calendar.
  const end = build.targetShip || p.projectedShip;
  const span = Math.max(1, diffLocal(p.start, end));
  const todayPct = build.targetShip ? Math.round(Math.min(Math.max(diffLocal(p.start, state.today) / span, 0), 1) * 100) : null;

  return `<div class="mini-tl">
    <div class="mtl-track" title="${progressPct}% of planned work complete">
      <div class="mtl-bar" style="width:${Math.max(2, progressPct)}%;background:${color}"></div>
      ${todayPct !== null ? `<div class="mtl-today" style="left:${todayPct}%" title="Today"></div>` : ''}
      ${build.targetShip ? `<div class="mtl-target" title="Target ship ${fmtDate(build.targetShip)}"><span class="mtl-target-flag"></span></div>` : ''}
    </div>
    <div class="mtl-dates"><span>${fmtShort(p.start)}</span><span>${progressPct}% done</span><span class="mtl-target-date">▸ ${build.targetShip ? fmtShort(build.targetShip) : fmtShort(p.projectedShip)}</span></div>
  </div>`;
}
function capacity() { return analyzeCapacity(state.builds, state.lines, state.stages, calendar()); }
function portfolio() { return forecastPortfolio(state.builds, state.stages, calendar(), state.today); }

function filteredBuilds() {
  const q = state.search.trim().toLowerCase();
  return state.builds.filter((b) => {
    if (state.lineFilter !== 'all' && b.lineId !== state.lineFilter) return false;
    if (q && !`${b.id} ${b.name} ${b.client} ${b.moduleType}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
function lineName(id) { return (state.lines.find((l) => l.id === id) || {}).name || '—'; }
// Warning banner shown in the modal when this active build shares its bay with
// another active build on the same line.
function bayConflictWarning(build) {
  if (build.status !== 'active' || !build.bay) return '';
  const others = state.builds.filter((b) => b.id !== build.id && b.status === 'active' && b.lineId === build.lineId && String(b.bay) === String(build.bay));
  if (!others.length) return '';
  const line = state.lines.find((l) => l.id === build.lineId);
  return `<div class="bay-warning">⚠ Bay ${esc(String(build.bay))} on ${esc(line?.name || 'this line')} is also assigned to ${others.map((o) => esc(o.name || 'another build')).join(', ')}. Two active builds can't occupy the same bay.</div>`;
}

// Bays derive from a line's capacity: capacity N → Bay 1..N. Returns <option> html.
function bayOptions(build) {
  const line = state.lines.find((l) => l.id === build.lineId);
  const cap = Math.max(1, line?.capacity || 1);
  let html = `<option value="" ${!build.bay ? 'selected' : ''}>— Unassigned —</option>`;
  for (let i = 1; i <= cap; i++) {
    html += `<option value="${i}" ${String(build.bay) === String(i) ? 'selected' : ''}>Bay ${i}</option>`;
  }
  // The Long Line has an extra half-size Spray Foam bay between Bay 3 and Bay 4.
  const isLong = line && SHOP_LINES[0].match.some((m) => (line.name || '').toLowerCase().includes(m) || line.id.toLowerCase().includes(m));
  if (isLong) {
    html += `<option value="sf" ${String(build.bay) === 'sf' ? 'selected' : ''}>Spray Foam</option>`;
  }
  return html;
}

// Which (lineId, bay) pairs have more than one ACTIVE build assigned? Returns a
// Set of "lineId::bay" keys plus a map of conflicting build ids for messaging.
function bayConflicts() {
  const byBay = {};
  for (const b of state.builds) {
    if (b.status !== 'active' || !b.bay) continue;
    const key = `${b.lineId}::${b.bay}`;
    (byBay[key] ||= []).push(b);
  }
  const conflicts = new Set();
  for (const [key, arr] of Object.entries(byBay)) if (arr.length > 1) conflicts.add(key);
  return { conflicts, byBay };
}

function riskMeta(risk) {
  return {
    'on-track': { label: 'On Track', color: 'var(--teal)' },
    'at-risk': { label: 'At Risk', color: 'var(--amber)' },
    'late': { label: 'Late', color: 'var(--rust)' },
    'shipped': { label: 'Shipped', color: 'var(--shipped)' },
    'no-target': { label: 'No Target', color: 'var(--text-dim)' },
    'no-start': { label: 'No Start', color: 'var(--text-dim)' },
  }[risk] || { label: risk, color: 'var(--text-dim)' };
}

// ----------------------------- Render dispatch -----------------------------
function syncLineFilter() {
  const sel = $('#lineFilter');
  const want = ['all', ...state.lines.map((l) => l.id)].join(',');
  if (sel.dataset.sig === want) return;
  sel.dataset.sig = want;
  sel.innerHTML = '<option value="all">All lines</option>' + state.lines.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  sel.value = state.lineFilter;
}

function render() {
  renderHeaderStats();
  syncLineFilter();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.tab}`));
  $('#filterBar').style.display = (state.tab === 'settings' || state.tab === 'dashboard' || state.tab === 'reports' || state.tab === 'shop' || state.tab === 'hours') ? 'none' : '';
  ({
    dashboard: renderDashboard, gantt: renderGantt, board: renderBoard,
    shop: renderShopOverview, hours: renderBuildHours,
    pipeline: renderPipeline, reports: renderReports, settings: renderSettings,
  })[state.tab]?.();
}

function renderHeaderStats() {
  const { summary } = portfolio();
  const cap = capacity();
  const overbooked = cap.filter((c) => c.isOverbooked).length;
  const active = state.builds.filter((b) => b.status === 'active').length;
  $('#headerStats').innerHTML = `
    <div class="hstat"><span class="n">${active}</span><span class="l">Active</span></div>
    <div class="hstat"><span class="n">${state.builds.filter((b) => b.status === 'confirmed').length}</span><span class="l">Confirmed</span></div>
    <div class="hstat"><span class="n">${state.builds.filter((b) => b.status === 'pipeline').length}</span><span class="l">Pipeline</span></div>
    <div class="hstat ${summary.late ? 'bad' : ''}"><span class="n">${summary.late || 0}</span><span class="l">Late</span></div>
    <div class="hstat ${summary['at-risk'] ? 'warn' : ''}"><span class="n">${summary['at-risk'] || 0}</span><span class="l">At Risk</span></div>
    <div class="hstat ${overbooked ? 'bad' : ''}"><span class="n">${overbooked}</span><span class="l">Overbooked Lines</span></div>`;
}

// ----------------------------- Dashboard (forecasting intelligence) -----------------------------
function renderDashboard() {
  const { forecasts, summary } = portfolio();
  const cap = capacity();
  const byId = Object.fromEntries(forecasts.map((f) => [f.buildId, f]));
  const proj = projections();

  const riskOrder = { late: 0, 'at-risk': 1, 'on-track': 2, 'no-target': 3, 'no-start': 4 };
  const ranked = [...state.builds].sort((a, b) => (riskOrder[byId[a.id]?.risk] ?? 9) - (riskOrder[byId[b.id]?.risk] ?? 9));

  const attention = ranked.filter((b) => ['late', 'at-risk'].includes(byId[b.id]?.risk));

  // Active builds with their delivery date, line, and health for the forecast detail.
  const activeForecast = ranked.filter((b) => b.status === 'active');

  $('#dashboardRoot').innerHTML = `
    <div class="dash-grid">
      <section class="panel span-2">
        <h2>Delivery Forecast</h2>
        <p class="panel-sub">Projected ship dates vs. targets, crediting work already logged. The engine walks each build's remaining stage work across the working calendar.</p>
        <div class="risk-bars">
          ${['late', 'at-risk', 'on-track', 'no-target', 'no-start'].map((r) => {
            const m = riskMeta(r); const n = summary[r] || 0; const total = state.builds.length || 1;
            return `<div class="risk-bar-row"><span class="rb-label" style="color:${m.color}">${m.label}</span>
              <div class="rb-track"><div class="rb-fill" style="width:${n / total * 100}%;background:${m.color}"></div></div>
              <span class="rb-count">${n}</span></div>`;
          }).join('')}
        </div>
        ${activeForecast.length ? `
        <div class="forecast-detail-head">Active builds — delivery & health</div>
        <table class="data-table">
          <thead><tr><th>Build</th><th>Line · Bay</th><th>Timeline</th><th>Target Ship</th><th>Projected Completion</th><th>Health</th></tr></thead>
          <tbody>
            ${activeForecast.map((b) => { const f = byId[b.id]; const m = riskMeta(f?.risk); return `
              <tr data-open="${b.id}">
                <td class="td-name">${esc(b.name)}<span class="td-sub">${esc(b.client || '')}</span></td>
                <td>${esc(lineName(b.lineId))}${b.bay ? ` · Bay ${esc(String(b.bay))}` : ''}</td>
                <td class="td-timeline">${miniTimeline(b, proj[b.id]) || '<span class="td-sub">no start</span>'}</td>
                <td>${fmtDate(b.targetShip)}</td>
                <td>${fmtDate(f?.projectedShip)}</td>
                <td><span class="badge" style="background:${m.color}">${m.label}</span></td>
              </tr>`; }).join('')}
          </tbody>
        </table>` : `<div class="forecast-detail-note">No active builds yet. Move a build to “active” status to see its delivery projection here.</div>`}
      </section>

      <section class="panel">
        <h2>Line Capacity</h2>
        <p class="panel-sub">Each line's bays at a glance. Drag a build between bays to move it — the change reflects across the whole app. Red marks a double-booked bay.</p>
        <div class="line-cards">
          ${cap.map((c) => {
            const line = state.lines.find((l) => l.id === c.lineId);
            const capacity = Math.max(1, line?.capacity || 1);
            const { conflicts } = bayConflicts();
            const bayMap = {};
            for (const b of state.builds) {
              if (b.status === 'active' && b.lineId === c.lineId && b.bay) (bayMap[b.bay] ||= []).push(b);
            }
            const filled = Object.keys(bayMap).length;
            const fillPct = Math.round(filled / capacity * 100);
            const cells = Array.from({ length: capacity }, (_, i) => {
              const bayNum = i + 1;
              const occupants = bayMap[bayNum] || [];
              const conflict = conflicts.has(`${c.lineId}::${bayNum}`);
              const occ = occupants[0];
              const f = occ ? byId[occ.id] : null;
              const color = f ? riskMeta(f.risk).color : '';
              const chips = occupants.length
                ? occupants.map((o) => `<span class="lc-build" draggable="true" data-bay-build="${o.id}" title="${esc(o.name)} — drag to move">${esc(o.name)}</span>`).join('')
                : '<span class="lc-open">Open</span>';
              return `<div class="lc-bay ${occupants.length ? 'filled' : 'open'} ${conflict ? 'conflict' : ''}" data-bay-drop="${bayNum}" data-bay-line="${c.lineId}" ${occ ? `style="--bc:${color}"` : ''}>
                <span class="lc-baynum">${bayNum}</span>
                <span class="lc-occ">${chips}</span>
                ${conflict ? '<span class="lc-flag" title="Double-booked">⚠</span>' : ''}
              </div>`;
            }).join('');
            return `
            <div class="line-card ${c.isOverbooked ? 'over' : ''}">
              <div class="lc-head">
                <span class="lc-name">${esc(c.lineName)}</span>
                <span class="lc-count">${filled}<span class="lc-of">/${capacity}</span> bays</span>
              </div>
              <div class="lc-fill-track"><div class="lc-fill-bar ${c.isOverbooked ? 'over' : ''}" style="width:${Math.min(100, fillPct)}%"></div></div>
              <div class="lc-bays">${cells}</div>
              ${c.overbookedWindows.length ? `<div class="lc-warn">Overbooked: ${c.overbookedWindows.map((w) => `${fmtShort(w.start)}–${fmtShort(w.end)} (${w.count})`).join(', ')}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="panel">
        <h2>Needs Attention <span class="count-pill">${attention.length}</span></h2>
        <p class="panel-sub">Builds flagged late or at-risk, most urgent first.</p>
        ${attention.length ? `
        <div class="attention-list">
          ${attention.map((b) => { const f = byId[b.id]; const m = riskMeta(f.risk); return `
            <div class="attention-row" data-open="${b.id}">
              <div class="att-main"><span class="att-name">${esc(b.name)}</span><span class="badge" style="background:${m.color}">${m.label}</span></div>
              <div class="att-meta">${esc(lineName(b.lineId))} · target ${fmtDate(f.targetShip)} · projected ${fmtDate(f.projectedShip)} · ${f.slackDays > 0 ? '+' : ''}${f.slackDays ?? '—'}d slack</div>
            </div>`; }).join('')}
        </div>` : `<div class="empty">Nothing late or at-risk. Every build with a target is projected to make it.</div>`}
      </section>

      ${(() => {
        const people = state.settings.people || [];
        if (!people.length) return '';
        const weeklySupply = people.reduce((s, p) => s + (Number(p.weeklyHours) || 0), 0);
        // Weekly demand: for each active build, spread its remaining projected hours
        // across the working weeks between now and its target/projected ship.
        const activeBuilds = state.builds.filter((b) => b.status === 'active');
        let weeklyDemand = 0;
        const perBuild = [];
        for (const b of activeBuilds) {
          const proj = Number(b.projectedHours) || 0;
          const logged = state.stages.reduce((s, st) => s + (Number(b.stageHours?.[st.id]) || 0), 0);
          const remaining = Math.max(0, proj - logged);
          const f = byId[b.id];
          const endISO = f?.projectedShip || b.targetShip;
          let weeks = 4;
          if (endISO) {
            const days = Math.max(1, Math.round((new Date(endISO + 'T00:00:00') - new Date(state.today + 'T00:00:00')) / 86400000));
            weeks = Math.max(1, days / 7);
          }
          const demand = remaining / weeks;
          weeklyDemand += demand;
          if (remaining > 0) perBuild.push({ name: b.name, demand: Math.round(demand), id: b.id });
        }
        weeklyDemand = Math.round(weeklyDemand);
        const util = weeklySupply ? Math.round(weeklyDemand / weeklySupply * 100) : 0;
        const over = weeklyDemand > weeklySupply;
        perBuild.sort((a, b) => b.demand - a.demand);
        return `
      <section class="panel span-2">
        <h2>Labor Capacity</h2>
        <p class="panel-sub">Crew hours available each week vs. hours demanded by active builds (remaining projected hours spread across each build's remaining schedule). A rough planning gauge, not a timesheet.</p>
        <div class="labor-summary">
          <div class="labor-stat"><span class="ls-num">${weeklySupply}</span><span class="ls-label">Crew hrs / week</span></div>
          <div class="labor-stat"><span class="ls-num">${weeklyDemand}</span><span class="ls-label">Demand hrs / week</span></div>
          <div class="labor-stat ${over ? 'over' : 'ok'}"><span class="ls-num">${util}%</span><span class="ls-label">Utilization</span></div>
        </div>
        <div class="labor-track"><div class="labor-bar ${over ? 'over' : ''}" style="width:${Math.min(100, util)}%"></div>${over ? `<div class="labor-over-mark" title="Over capacity"></div>` : ''}</div>
        ${over ? `<div class="labor-warn">Demand exceeds crew capacity by ~${weeklyDemand - weeklySupply} hrs/week. Consider adding crew, extending schedules, or resequencing.</div>` : `<div class="labor-ok-note">Crew capacity covers current demand with ~${weeklySupply - weeklyDemand} hrs/week to spare.</div>`}
        ${perBuild.length ? `<div class="labor-detail-head">Weekly demand by active build</div>
        <div class="labor-builds">
          ${perBuild.map((pb) => `<div class="labor-build-row" data-open="${pb.id}"><span class="lb-name">${esc(pb.name)}</span><span class="lb-demand">${pb.demand} hrs/wk</span></div>`).join('')}
        </div>` : ''}
      </section>`;
      })()}

      <section class="panel span-2">
        <h2>What-If Scenario</h2>
        <p class="panel-sub">Test a schedule change without committing. Pick a build, set a hypothetical start date, and see how its projected ship date and health would shift. Nothing is saved unless you apply it.</p>
        <div class="scenario-controls">
          <label class="field"><span>Build</span><select id="scenarioBuild">
            <option value="">— Select a build —</option>
            ${state.builds.filter((b) => b.status !== 'complete').map((b) => `<option value="${b.id}" ${state.scenario?.buildId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Hypothetical start</span><input type="date" id="scenarioDate" value="${state.scenario?.date || ''}"></label>
          <button class="btn sm" id="scenarioRun" type="button">Preview</button>
        </div>
        <div id="scenarioResult"></div>
      </section>
    </div>`;
}

// ----------------------------- What-if scenario -----------------------------
// Compute a build's forecast under a hypothetical start date WITHOUT saving, and
// show the difference against its current projection. Purely a sandbox over the
// forecast engine — nothing persists unless the user clicks Apply.
function runScenario(buildId, date) {
  const out = $('#scenarioResult');
  if (!out) return;
  const b = state.builds.find((x) => x.id === buildId);
  if (!b) { out.innerHTML = '<div class="forecast-detail-note">Pick a build to preview.</div>'; return; }
  if (!date) { out.innerHTML = '<div class="forecast-detail-note">Set a hypothetical start date to preview the impact.</div>'; return; }

  const currentF = forecastBuild(b, state.stages, calendar(), state.today);
  // Hypothetical copy: move the planning anchor (confirmedStart) to the new date.
  const hypo = { ...b, confirmedStart: date, actualStart: date };
  const hypoF = forecastBuild(hypo, state.stages, calendar(), state.today);
  const mCur = riskMeta(currentF.risk); const mHypo = riskMeta(hypoF.risk);

  const shipShift = (currentF.projectedShip && hypoF.projectedShip)
    ? Math.round((new Date(hypoF.projectedShip + 'T00:00:00') - new Date(currentF.projectedShip + 'T00:00:00')) / 86400000)
    : null;

  out.innerHTML = `
    <div class="scenario-compare">
      <div class="sc-col">
        <div class="sc-head">Current</div>
        <div class="sc-row">Start <b>${fmtDate(b.confirmedStart || b.tentativeStart)}</b></div>
        <div class="sc-row">Projected ship <b>${fmtDate(currentF.projectedShip)}</b></div>
        <div class="sc-row">Health <span class="badge" style="background:${mCur.color}">${mCur.label}</span></div>
      </div>
      <div class="sc-arrow">→</div>
      <div class="sc-col">
        <div class="sc-head">If started ${fmtDate(date)}</div>
        <div class="sc-row">Start <b>${fmtDate(date)}</b></div>
        <div class="sc-row">Projected ship <b>${fmtDate(hypoF.projectedShip)}</b></div>
        <div class="sc-row">Health <span class="badge" style="background:${mHypo.color}">${mHypo.label}</span></div>
      </div>
    </div>
    ${shipShift !== null ? `<div class="sc-delta ${shipShift > 0 ? 'later' : shipShift < 0 ? 'earlier' : 'same'}">${
      shipShift > 0 ? `Ships ${shipShift} day${shipShift === 1 ? '' : 's'} later` :
      shipShift < 0 ? `Ships ${Math.abs(shipShift)} day${shipShift === -1 ? '' : 's'} earlier` :
      'No change to projected ship date'}</div>` : ''}
    <div class="sc-actions">
      <button class="btn sm primary" id="scenarioApply" type="button">Apply this start date</button>
      <button class="btn sm" id="scenarioClear" type="button">Discard</button>
      <span class="td-sub">Preview only — nothing is saved until you apply.</span>
    </div>`;

  $('#scenarioApply')?.addEventListener('click', async () => {
    await patchBuild(buildId, { confirmedStart: date, actualStart: date });
    state.scenario = null;
  });
  $('#scenarioClear')?.addEventListener('click', () => { state.scenario = null; $('#scenarioResult').innerHTML = ''; $('#scenarioBuild').value = ''; $('#scenarioDate').value = ''; });
}

// ----------------------------- Gantt -----------------------------
function renderGantt() {
  const DAY = 16, LABEL = 234, HORIZON = 182; // ~26 weeks visible
  const proj = projections();
  // The Gantt is a forward-looking schedule: show active + pipeline work, not
  // completed builds (those live in Reports). This keeps the timeline centered
  // on what's actually being built rather than finished history.
  const builds = filteredBuilds().filter((b) => b.status !== 'complete');
  const starts = builds.map((b) => proj[b.id]?.start).filter(Boolean);
  // Consider both projected ship dates AND explicitly assigned target-ship dates,
  // so the chart always extends through the farthest/latest date on the board.
  const ends = [
    ...builds.map((b) => proj[b.id]?.projectedShip).filter(Boolean),
    ...builds.map((b) => b.targetShip).filter(Boolean),
  ];
  // Anchor the window to the earliest of (today, any build start), minus a small margin,
  // so the calendar always reads as a real timeline even when nothing is scheduled yet.
  const earliest = [state.today, ...starts].reduce((a, b) => (a < b ? a : b));
  const start = addDaysLocal(earliest, -14);
  // Extend the horizon to cover the latest end date, plus ~2 weeks of trailing margin
  // so the final bar isn't flush against the right edge.
  const latest = [addDaysLocal(start, HORIZON), ...ends].reduce((a, b) => (a > b ? a : b));
  const totalDays = Math.max(HORIZON, diffLocal(start, latest) + 14);
  const chartW = totalDays * DAY;

  const health = Object.fromEntries((state.settings.healthStatuses || []).map((h) => [h.id, h]));
  const byLine = {};
  state.lines.forEach((l) => (byLine[l.id] = []));
  builds.forEach((b) => byLine[b.lineId]?.push(b));

  let ticks = '';
  let gridlines = '';
  for (let i = 0; i < totalDays; i += 7) {
    ticks += `<div class="tick" style="left:${i * DAY}px"><span>${fmtShort(addDaysLocal(start, i))}</span></div>`;
    // A real DOM gridline per week, drawn once across the full body height —
    // reliable at any width, unlike a CSS repeating-gradient which browsers
    // stop painting past a size limit.
    gridlines += `<div class="g-gridline" style="left:${i * DAY}px"></div>`;
  }

  let rows = '';
  for (const line of state.lines) {
    const items = (byLine[line.id] || []).filter((b) => proj[b.id]).sort((a, b) => (proj[a.id].start < proj[b.id].start ? -1 : 1));
    const noDate = (byLine[line.id] || []).filter((b) => !proj[b.id]);
    if (!items.length && !noDate.length) continue;
    rows += `<div class="g-row group"><div class="g-label">${esc(line.name)}</div><div class="g-track" style="width:${chartW}px"></div></div>`;
    for (const b of items) {
      const p = proj[b.id];
      const f = forecastBuild(b, state.stages, calendar(), state.today);
      const x = diffLocal(start, p.start) * DAY;
      const w = Math.max(DAY, (diffLocal(p.start, p.projectedShip) + 1) * DAY);
      const color = f.risk === 'late' ? 'var(--rust)' : f.risk === 'at-risk' ? 'var(--amber)' : (health['on-track']?.color || 'var(--teal)');
      const tent = !b.confirmedStart;
      rows += `<div class="g-row"><div class="g-label" data-open="${b.id}" title="${esc(b.name)}"><span class="g-name">${esc(b.name)}</span><span class="g-meta">${esc(lineName(b.lineId))} · ${fmtShort(p.start)}→${fmtShort(p.projectedShip)}</span></div>
        <div class="g-track" style="width:${chartW}px">
          <div class="g-bar ${tent ? 'tentative' : ''}" style="left:${x}px;width:${w}px;${tent ? '' : `background:${color}`}" data-open="${b.id}" title="${esc(b.name)} — ${riskMeta(f.risk).label}">${esc(b.name)}</div>
          ${b.targetShip ? `<div class="g-target" style="left:${diffLocal(start, b.targetShip) * DAY}px" title="Target ship: ${fmtDate(b.targetShip)}"><span class="g-target-flag"></span></div>` : ''}
        </div></div>`;
    }
    for (const b of noDate) {
      rows += `<div class="g-row"><div class="g-label" data-open="${b.id}" title="${esc(b.name)}"><span class="g-name">${esc(b.name)}</span><span class="g-meta">no start date</span></div>
        <div class="g-track" style="width:${chartW}px"><div class="g-nodate" data-open="${b.id}">Set a start date →</div></div></div>`;
    }
  }
  // Geometry the print path needs to clip the timeline to a legible window.
  state._gantt = { start, DAY, LABEL, chartW, totalDays };
  const todayX = LABEL + diffLocal(start, state.today) * DAY;

  $('#ganttRoot').innerHTML = `
    <div class="g-legend">
      <span class="lg"><i style="background:var(--teal)"></i>On Track</span>
      <span class="lg"><i style="background:var(--amber)"></i>At Risk</span>
      <span class="lg"><i style="background:var(--rust)"></i>Late</span>
      <span class="lg"><i class="tent"></i>Tentative</span>
      <span class="lg"><i class="tgt"></i>Target ship</span>
      <button class="btn sm" data-print="gantt">Print</button>
    </div>
    <div class="g-wrap"><div class="g-scroll">
      <div class="g-inner" style="width:${LABEL + chartW}px">
        <div class="g-head"><div class="g-label-sp">Build</div><div class="ticks" style="width:${chartW}px">${ticks}</div></div>
        <div class="g-body">
          <div class="g-gridlines" style="left:${LABEL}px;width:${chartW}px">${gridlines}</div>
          ${rows || '<div class="empty">No builds match.</div>'}<div class="today" style="left:${todayX}px"><span>Today</span></div></div>
      </div>
    </div></div>`;
  // Auto-scroll so "today" sits a little in from the left — you see current + upcoming
  // work on open, not empty past weeks. (diffLocal from window start to today, in px.)
  const scroller = $('#ganttRoot .g-scroll');
  if (scroller) {
    const todayOffset = diffLocal(start, state.today) * DAY;
    scroller.scrollLeft = Math.max(0, todayOffset - DAY * 7); // ~1 week of lead-in
  }
}
function addDaysLocal(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return toISO(d); }
function diffLocal(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

// ----------------------------- Board -----------------------------
function renderBoard() {
  const builds = filteredBuilds();
  const cols = [{ id: 'pipeline', label: 'Pipeline' }, { id: 'confirmed', label: 'Confirmed' }, { id: 'active', label: 'Active' }, { id: 'complete', label: 'Complete' }];
  const health = Object.fromEntries((state.settings.healthStatuses || []).map((h) => [h.id, h]));
  $('#boardRoot').innerHTML = cols.map((col) => {
    const items = builds.filter((b) => b.status === col.id);
    return `<div class="b-col"><div class="b-col-head"><span>${col.label}</span><span class="count-pill">${items.length}</span></div>
      <div class="b-zone" data-status="${col.id}">${items.map((b) => {
        const f = forecastBuild(b, state.stages, calendar(), state.today); const m = riskMeta(f.risk);
        const done = state.stages.filter((s) => (b.stageProgress?.[s.id] || 0) >= 1).length;
        const bayLabel = b.bay ? ` · Bay ${esc(String(b.bay))}` : '';
        return `<div class="b-card" draggable="true" data-card="${b.id}" data-open="${b.id}">
          <div class="b-card-top"><span class="b-id">${esc(b.id)}</span><span class="badge" style="background:${m.color}">${m.label}</span></div>
          <div class="b-name">${esc(b.name)}</div><div class="b-client">${esc(b.client || '')}</div>
          ${miniTimeline(b)}
          <div class="b-meta"><span>${esc(lineName(b.lineId))}${bayLabel}</span><span>${done}/${state.stages.length} stages</span></div>
        </div>`;
      }).join('') || '<div class="b-empty">—</div>'}</div></div>`;
  }).join('');
}

// ----------------------------- Pipeline (with capacity-aware start suggestions) -----------------------------
// ----------------------------- Shop Overview (floor plan) -----------------------------
// Two production lines laid over the shop floor drawing. Bays are numbered
// right-to-left (Bay 1 on the far right) and are clickable to open the build in
// them, staying in sync with each build's Production Line + Bay fields.
const SHOP_LINES = [
  // Long Line — Modular Home Manufacturing Bay (top), 10 bays.
  { key: 'long', label: 'Long Line', match: ['long', 'modular', 'line 1', 'line-1'], bays: 10,
    region: { left: 21.17, right: 83.76, top: 3.76, bottom: 31.02 }, tone: 'saw' },
  // Short Line — Tiny Home Manufacturing Bay (bottom), 6 bays.
  { key: 'short', label: 'Short Line', match: ['short', 'tiny', 'line 2', 'line-2'], bays: 6,
    region: { left: 45.16, right: 83.76, top: 72.93, bottom: 96.8 }, tone: 'shipped', bandTopExtra: 3.4 },
];

function resolveShopLine(def, usedIds) {
  // Match a user line by name keywords; otherwise fall back to line order.
  const byName = state.lines.find((l) => !usedIds.has(l.id) && def.match.some((m) => (l.name || '').toLowerCase().includes(m) || l.id.toLowerCase().includes(m)));
  if (byName) return byName;
  return state.lines.find((l) => !usedIds.has(l.id)) || null;
}

// ----------------------------- Build Hours (matrix) -----------------------------
// An all-in-one grid of every build's hours by production stage — mirroring the
// structure of the shop's Build Hours spreadsheet. Cells are editable and write
// to the same stageHours the build panels use, so the two stay in sync. Filterable
// by year, status (active/complete), module type, and build-name search.
function buildHoursYear(b) {
  // The year a build "belongs to" for filtering: actual ship if shipped, else
  // target ship, else its start — whichever places it on the calendar.
  const d = b.actualShip || b.targetShip || b.confirmedStart || b.tentativeStart;
  return d ? d.slice(0, 4) : null;
}

function renderBuildHours() {
  const f = state.hoursFilters;
  const stages = state.stages;

  // Available years for the dropdown (from all builds that have any hours/dates).
  const years = new Set();
  for (const b of state.builds) { const y = buildHoursYear(b); if (y) years.add(y); }
  const yearList = [...years].sort((a, b) => (a < b ? 1 : -1));

  // Apply filters.
  let rows = state.builds.filter((b) => {
    // Build Hours only tracks builds that are in production or finished — not
    // pipeline or confirmed (which have no hours to log yet). This list updates
    // automatically when a build's status changes to active or complete.
    if (b.status !== 'active' && b.status !== 'complete') return false;
    if (f.year !== 'all' && buildHoursYear(b) !== f.year) return false;
    if (f.status === 'active' && b.status === 'complete') return false;
    if (f.status === 'complete' && b.status !== 'complete') return false;
    if (f.moduleType !== 'all' && (b.moduleType || '') !== f.moduleType) return false;
    if (f.search) { const q = f.search.toLowerCase(); if (!(`${b.name || ''} ${b.client || ''}`.toLowerCase().includes(q))) return false; }
    return true;
  });
  // Sort: active/in-progress first, then by name.
  rows = rows.slice().sort((a, b) => {
    const ac = a.status === 'complete' ? 1 : 0, bc = b.status === 'complete' ? 1 : 0;
    if (ac !== bc) return ac - bc;
    return (a.name || '').localeCompare(b.name || '');
  });

  const actualOf = (b) => stages.reduce((s, st) => s + (Number(b.stageHours?.[st.id]) || 0), 0);

  // Column totals across the filtered rows.
  const colTotals = stages.map((st) => rows.reduce((s, b) => s + (Number(b.stageHours?.[st.id]) || 0), 0));
  const grandActual = rows.reduce((s, b) => s + actualOf(b), 0);
  const grandGoal = rows.reduce((s, b) => s + (Number(b.projectedHours) || 0), 0);

  const moduleTypes = state.settings.moduleTypes || [];

  const cw = state.hoursColWidths || {};
  const wStyle = (key) => cw[key] ? `width:${cw[key]}px;min-width:${cw[key]}px;max-width:${cw[key]}px` : '';
  const headCells = stages.map((st) => `<th class="bh-stage" data-reorder-id="${st.id}" data-col="stage:${st.id}" style="${wStyle('stage:' + st.id)}" title="${esc(st.label)} — drag header to reorder, drag edge to resize"><span class="th-label" draggable="true">${esc(st.label)}</span><span class="col-resize" data-resize="stage:${st.id}"></span></th>`).join('');

  const bodyRows = rows.map((b, idx) => {
    const actual = actualOf(b);
    const goal = Number(b.projectedHours) || 0;
    const varc = actual - goal;
    const tone = !goal ? '' : varc > 0 ? 'over' : varc < 0 ? 'under' : 'even';
    const cells = stages.map((st) => {
      const v = Number(b.stageHours?.[st.id]) || 0;
      return `<td class="bh-cell"><input class="bh-input" type="number" min="0" step="0.5" value="${v || ''}" data-hours-build="${b.id}" data-hours-stage="${st.id}" title="${esc(st.label)}"></td>`;
    }).join('');
    // Strictly the last time hours were edited in THIS tab (not any other edit).
    const updated = b.hoursUpdatedAt;
    return `<tr class="${idx % 2 ? 'bh-alt' : ''}">
      <td class="bh-name bh-name-var ${tone}" style="${wStyle('name')}" data-open-build="${b.id}" title="Open ${esc(b.name || 'Untitled')}"><button class="bh-highlight-btn" data-highlight-row="${b.id}" title="Highlight this row">★</button><span class="bh-name-text">${esc(b.name || 'Untitled')}<span class="bh-sub">${esc(b.moduleType || '')}</span></span></td>
      ${cells}
      <td class="bh-total">${actual || 0}</td>
      <td class="bh-goal"><input class="bh-input bh-goal-input" type="number" min="0" step="1" value="${goal || ''}" data-goal-build="${b.id}" title="Projected (goal) hours" placeholder="—"></td>
      <td class="bh-var ${tone}">${goal ? `${varc > 0 ? '+' : ''}${varc}` : '—'}</td>
      <td class="bh-updated">${updated ? fmtDate(updated.slice(0, 10)) : '—'}</td>
      <td class="bh-target">${b.targetShip ? fmtDate(b.targetShip) : '—'}</td>
      <td class="bh-status"><span class="bh-status-pill ${b.status === 'complete' ? 'done' : 'active'}">${b.status === 'complete' ? 'Complete' : esc(b.status)}</span></td>
    </tr>`;
  }).join('');

  const totalsRow = `<tr class="bh-totals-row">
    <td class="bh-name" style="${wStyle('name')}">Totals (${rows.length})</td>
    ${colTotals.map((t) => `<td class="bh-total-cell">${t || ''}</td>`).join('')}
    <td class="bh-total">${grandActual || 0}</td>
    <td class="bh-goal">${grandGoal || 0}</td>
    <td class="bh-var ${grandGoal ? (grandActual - grandGoal > 0 ? 'over' : grandActual - grandGoal < 0 ? 'under' : 'even') : ''}">${grandGoal ? `${grandActual - grandGoal > 0 ? '+' : ''}${grandActual - grandGoal}` : '—'}</td>
    <td class="bh-updated"></td>
    <td class="bh-target"></td>
    <td class="bh-status"></td>
  </tr>`;

  $('#hoursRoot').innerHTML = `
    <div class="hours-head">
      <div><h2 class="rep-title">Build Hours</h2>
      <p class="panel-sub" style="margin:4px 0 0">Click a build name to open it; edit any cell to log hours. Goal = projected hours; variance shows over (red) or under (green) budget.</p></div>
    </div>
    <div class="hours-filters">
      <label class="hf">Year <select data-hours-filter="year">
        <option value="all" ${f.year === 'all' ? 'selected' : ''}>All years</option>
        ${yearList.map((y) => `<option value="${y}" ${f.year === y ? 'selected' : ''}>${y}</option>`).join('')}
      </select></label>
      <label class="hf">Status <select data-hours-filter="status">
        <option value="all" ${f.status === 'all' ? 'selected' : ''}>All</option>
        <option value="active" ${f.status === 'active' ? 'selected' : ''}>Active / in progress</option>
        <option value="complete" ${f.status === 'complete' ? 'selected' : ''}>Complete</option>
      </select></label>
      <label class="hf">Module <select data-hours-filter="moduleType">
        <option value="all" ${f.moduleType === 'all' ? 'selected' : ''}>All modules</option>
        ${moduleTypes.map((t) => `<option value="${esc(t)}" ${f.moduleType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select></label>
      <input class="hf-search" type="search" placeholder="Search builds…" value="${esc(f.search)}" data-hours-filter="search">
      <button class="btn sm" data-print="hours">Print</button>
    </div>
    ${rows.length ? `<div class="hours-grid-wrap"><table class="hours-grid">
      <thead><tr data-reorder="stages"><th class="bh-name-head" data-col="name" style="${wStyle('name')}">Build<span class="col-resize" data-resize="name"></span></th>${headCells}<th class="bh-total-head">Total</th><th class="bh-goal-head">Goal</th><th class="bh-var-head">Var</th><th class="bh-updated-head">Updated</th><th class="bh-target-head">Target Ship</th><th class="bh-status-head">Status</th></tr></thead>
      <tbody>${bodyRows}${totalsRow}</tbody>
    </table></div>` : '<div class="empty">No builds match these filters.</div>'}`;

  // Filter change handlers.
  $$('#hoursRoot [data-hours-filter]').forEach((el) => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => { state.hoursFilters[el.dataset.hoursFilter] = el.value; renderBuildHours(); });
  });
  // Open build on name click.
  $$('#hoursRoot [data-open-build]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-highlight-row]')) return; // highlight button handled separately
    openBuild(el.dataset.openBuild);
  }));
  // Highlight/unhighlight a row for easier review across the wide grid.
  $$('#hoursRoot [data-highlight-row]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const tr = btn.closest('tr');
    if (tr) { tr.classList.toggle('bh-highlighted'); btn.classList.toggle('active'); }
  }));
  // Edit a stage-hours cell.
  $$('#hoursRoot [data-hours-build]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const b = await repo.getBuild(inp.dataset.hoursBuild) || state.builds.find((x) => x.id === inp.dataset.hoursBuild);
      if (!b) return;
      const stageHours = { ...(b.stageHours || {}), [inp.dataset.hoursStage]: Number(inp.value) || 0 };
      suppressModalRerenderUntil = Date.now() + 300;
      suppressHoursRerenderUntil = Date.now() + 600; // keep the grid stable so tabbing works
      await patchBuild(inp.dataset.hoursBuild, { stageHours, hoursUpdatedAt: new Date().toISOString() });
      updateHoursRowLive(inp);
    });
  });
  // Edit the goal (projected hours) inline.
  $$('#hoursRoot [data-goal-build]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      suppressHoursRerenderUntil = Date.now() + 600;
      await patchBuild(inp.dataset.goalBuild, { projectedHours: Number(inp.value) || 0, hoursUpdatedAt: new Date().toISOString() });
      updateHoursRowLive(inp);
    });
  });
  $('#exportBuildHours')?.addEventListener('click', () => exportBuildHoursMatrix(rows));
  wireReorder('#hoursRoot');
  wireColumnResize();
}

// Drag the thin handle on a column header's right edge to resize that column.
// Widths persist in state.hoursColWidths and are re-applied on every render.
function wireColumnResize() {
  const handles = $$('#hoursRoot .col-resize');
  handles.forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const key = handle.dataset.resize;
      const th = handle.closest('th');
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      document.body.classList.add('col-resizing');
      const onMove = (ev) => {
        const w = Math.max(46, Math.round(startW + (ev.clientX - startX)));
        th.style.width = `${w}px`; th.style.minWidth = `${w}px`; th.style.maxWidth = `${w}px`;
        state.hoursColWidths[key] = w;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('col-resizing');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Prevent the resize handle from triggering header drag-reorder.
    handle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  });
}

// Update a row's Total + Variance live from its inputs (no full re-render, so the
// cursor stays put while editing across cells).
function updateHoursRowLive(inp) {
  const tr = inp.closest('tr');
  if (!tr) return;
  let actual = 0;
  tr.querySelectorAll('[data-hours-build]').forEach((el) => { actual += Number(el.value) || 0; });
  const goalInp = tr.querySelector('[data-goal-build]');
  const goal = Number(goalInp?.value) || 0;
  const totalCell = tr.querySelector('.bh-total');
  if (totalCell) totalCell.textContent = actual || 0;
  const varc = actual - goal;
  const tone = !goal ? '' : varc > 0 ? 'over' : varc < 0 ? 'under' : 'even';
  const varCell = tr.querySelector('.bh-var');
  if (varCell) {
    varCell.textContent = goal ? `${varc > 0 ? '+' : ''}${varc}` : '—';
    varCell.className = `bh-var ${tone}`;
  }
  // Mirror the tone onto the build-name cell so over/under is visible at a glance.
  const nameCell = tr.querySelector('.bh-name-var');
  if (nameCell) nameCell.className = `bh-name bh-name-var ${tone}`;
  // Refresh the "updated" cell to today.
  const updCell = tr.querySelector('.bh-updated');
  if (updCell) updCell.textContent = fmtDate(state.today);
}

// Export the filtered matrix (builds × stages) to CSV, mirroring the sheet layout.
// ----------------------------- Printing -----------------------------
// Print ONLY the Build Hours grid or the Gantt chart, sized to fill the sheet.
// Build Hours prints as a full-width table (crisp, no scaling). The Gantt has a
// fixed pixel width, so it's scaled to exactly fill the printable width.
// CSS @page only accepts certain size keywords — 11×17 is "ledger", not "tabloid".
// Printing is driven entirely by the browser's own print dialog — Ctrl+P, the
// File menu, or the Print button, which just calls window.print(). No paper size
// or orientation is chosen in the app.
//
// @page requests landscape but deliberately does NOT name a paper size, so
// whatever the user selects in the dialog is honoured.
//
// Fitting the Gantt is the one thing CSS can't do alone: bars are positioned in
// absolute pixels, so the chart has to be scaled. Since the paper isn't known
// until the dialog is open, a scale is emitted for each of the two sizes and
// selected by a print media query on the page width:
//
//   letter landscape   11in - 0.7in margins = 10.3in ->  ~989px
//   tabloid landscape  17in - 0.7in margins = 16.3in -> ~1565px
//
// If a browser doesn't evaluate the query, the letter rule applies and the chart
// simply prints smaller than it could — it still fits, which is the safe failure.
const PRINT_MARGIN_IN = 0.35;
const PAGE_PX = {
  letter: (11 - PRINT_MARGIN_IN * 2) * 96,
  tabloid: (17 - PRINT_MARGIN_IN * 2) * 96,
};
const TABLOID_MIN_PX = 1200;   // between the two widths above

let restorePrintScroll = null;

// Printing the whole timeline is unreadable: at 16px/day a 290-day range is
// ~4,900px, which scales to 0.20 on letter — 10px type becomes 2px. Legibility
// needs a scale of roughly 0.6 or better, so the print clips to a forward window
// instead of compressing everything.
//
// 13 weeks (91 days) = 91*16 + 234 label = 1,690px:
//     letter landscape   989px page -> scale 0.59
//     tabloid landscape 1565px page -> scale 0.93
// One window that reads on both papers, which matters because the DOM is built
// before the print dialog opens, so the chosen paper isn't knowable.
const PRINT_WEEKS_BACK = 1;
const PRINT_WEEKS_FORWARD = 12;

function ganttPrintCss() {
  const g = state._gantt;
  const inner = $('#ganttRoot .g-inner');
  const scroller = $('#ganttRoot .g-scroll');
  if (!g || !inner || !scroller) return '';

  const { start, DAY, LABEL, chartW } = g;
  const winStart = addDaysLocal(state.today, -7 * PRINT_WEEKS_BACK);
  const winDays = 7 * (PRINT_WEEKS_BACK + PRINT_WEEKS_FORWARD);

  // Clamp so the window can't run off either end of the rendered chart.
  let offsetDays = Math.max(0, diffLocal(start, winStart));
  const maxOffset = Math.max(0, Math.round(chartW / DAY) - winDays);
  offsetDays = Math.min(offsetDays, maxOffset);
  const offsetPx = offsetDays * DAY;
  const windowPx = Math.min(chartW, winDays * DAY);
  const totalW = LABEL + windowPx;

  const prevLeft = scroller.scrollLeft, prevTop = scroller.scrollTop;
  scroller.scrollLeft = 0; scroller.scrollTop = 0;
  restorePrintScroll = () => { scroller.scrollLeft = prevLeft; scroller.scrollTop = prevTop; };

  const h = inner.getBoundingClientRect().height;
  const box = (pageW) => {
    const scale = Math.max(0.1, Math.min(1, pageW / totalW));
    return { scale, w: Math.ceil(totalW * scale), h: Math.ceil(h * scale) };
  };
  const a = box(PAGE_PX.letter), b = box(PAGE_PX.tabloid);

  // Shift the timeline left by the window offset and clip each row to the
  // narrowed width. The label column is a separate flex child, so it stays put.
  const shift = `
    #ganttRoot .g-head .ticks,
    #ganttRoot .g-gridlines,
    #ganttRoot .g-row .g-track,
    #ganttRoot .today{transform:translateX(-${offsetPx}px) !important}
    #ganttRoot .g-inner{width:${totalW}px !important}
    #ganttRoot .g-head,
    #ganttRoot .g-row,
    #ganttRoot .g-body{overflow:hidden !important}`;

  return `@media print{
    ${shift}
    #ganttRoot .g-wrap{width:auto !important;overflow:visible !important}
    #ganttRoot .g-scroll{width:${a.w}px !important;height:${a.h}px !important;
      max-height:none !important;min-height:0 !important;overflow:hidden !important}
    #ganttRoot .g-inner{transform:scale(${a.scale});transform-origin:top left}
  }
  @media print and (min-width:${TABLOID_MIN_PX}px){
    #ganttRoot .g-scroll{width:${b.w}px !important;height:${b.h}px !important}
    #ganttRoot .g-inner{transform:scale(${b.scale})}
  }`;
}

/**
 * A print-only line naming builds that fall outside the printed window, so the
 * long-range view is preserved as a note rather than 200 illegible columns.
 */
function ganttPrintNote() {
  const g = state._gantt;
  if (!g) return;
  const cutoff = addDaysLocal(state.today, 7 * PRINT_WEEKS_FORWARD);
  const proj = projections();
  const later = filteredBuilds()
    .filter((b) => b.status !== 'complete')
    .map((b) => ({ b, p: proj[b.id] }))
    .filter((x) => x.p && x.p.start > cutoff)
    .sort((x, y) => (x.p.start < y.p.start ? -1 : 1));

  let el = document.getElementById('ganttPrintNote');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ganttPrintNote';
    el.className = 'g-print-note';
    $('#ganttRoot')?.appendChild(el);
  }
  el.innerHTML = later.length
    ? `<b>Starts after ${fmtDate(cutoff)}:</b> ` +
      later.map((x) => `${esc(x.b.name)} (${fmtShort(x.p.start)})`).join(' \u00b7 ')
    : '';
}

/**
 * Called on beforeprint, so it applies however printing was started.
 * Only the Gantt and Build Hours tabs get special treatment; on any other tab
 * the page prints as it appears, like a normal web page.
 */
function preparePrint() {
  const PRINTABLE = ['gantt', 'hours', 'shop'];
  const kind = PRINTABLE.includes(state.tab) ? state.tab : null;
  if (!kind) return;

  // Only the Gantt needs measured scaling. Build Hours reflows as a table, and
  // the shop map is already width:100% with a fixed aspect ratio, so print CSS
  // alone makes it fill the page.
  let extra = '';
  if (kind === 'gantt') { extra = ganttPrintCss(); ganttPrintNote(); }

  let style = document.getElementById('printPageRule');
  if (!style) { style = document.createElement('style'); style.id = 'printPageRule'; document.head.appendChild(style); }
  style.textContent = `@page{size:landscape;margin:${PRINT_MARGIN_IN}in}\n` + extra;

  document.body.classList.add('printing', `printing-${kind}`);
}

function cleanupPrint() {
  document.body.classList.remove('printing', 'printing-hours', 'printing-gantt', 'printing-shop');
  if (restorePrintScroll) { restorePrintScroll(); restorePrintScroll = null; }
}

function exportBuildHoursMatrix(rows) {
  const stages = state.stages;
  const header = ['Build', 'Module', ...stages.map((s) => s.label), 'Total', 'Goal', 'Variance', 'Last Updated', 'Target Ship', 'Status'];
  const out = [header];
  for (const b of rows) {
    const actual = stages.reduce((s, st) => s + (Number(b.stageHours?.[st.id]) || 0), 0);
    const goal = Number(b.projectedHours) || 0;
    const updated = b.hoursUpdatedAt;
    out.push([
      b.name || 'Untitled', b.moduleType || '',
      ...stages.map((s) => Number(b.stageHours?.[s.id]) || 0),
      actual, goal, goal ? actual - goal : '', updated ? updated.slice(0, 10) : '', b.targetShip || '', b.status,
    ]);
  }
  const csv = out.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `traveler-build-hours-matrix-${state.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

function renderShopOverview() {
  const usedIds = new Set();
  const lineMap = SHOP_LINES.map((def) => { const line = resolveShopLine(def, usedIds); if (line) usedIds.add(line.id); return { def, line }; });

  const overlays = lineMap.map(({ def, line }) => {
    const region = def.region;
    const bayWidth = (region.right - region.left) / def.bays;
    // A solid band that blankets the whole bay strip, hiding the busy floor-plan
    // detail behind the bays. Padded slightly so the drawing's own bay outlines
    // don't peek out around the edges.
    const pad = 0.8;
    const topExtra = def.bandTopExtra || 0; // extra upward coverage to hide drawing lines above the bays
    let band = `<div class="shop-band" style="left:${region.left - pad}%;top:${region.top - pad - topExtra}%;width:${region.right - region.left + pad * 2}%;height:${region.bottom - region.top + pad * 2 + topExtra}%"></div>`;

    // Build the list of bay descriptors: {id, label, left, width}. Numbered
    // right-to-left (Bay 1 rightmost).
    const cellDefs = [];
    for (let i = 0; i < def.bays; i++) {
      const bayNum = i + 1;
      cellDefs.push({ id: bayNum, label: String(bayNum), left: region.right - bayWidth * bayNum, width: bayWidth });
    }
    // Long Line gets a half-width Spray Foam bay inserted at the Bay 3 / Bay 4
    // boundary. Bays 4–10 shift left by the half-bay to make room, so nothing
    // overlaps and the physical order matches the floor.
    if (def.key === 'long') {
      const sfWidth = bayWidth / 2;
      const boundary = region.right - bayWidth * 3; // left edge of Bay 3 = start of the 3/4 gap
      for (const c of cellDefs) if (c.id >= 4) c.left -= sfWidth; // shift the higher-numbered bays left
      cellDefs.push({ id: 'sf', label: 'SF', sprayFoam: true, left: boundary - sfWidth, width: sfWidth });
      // Widen the masking band a touch to cover the shifted bays.
      band = `<div class="shop-band" style="left:${region.left - pad - sfWidth}%;top:${region.top - pad}%;width:${region.right - region.left + pad * 2 + sfWidth}%;height:${region.bottom - region.top + pad * 2}%"></div>`;
    }

    const cells = cellDefs.map((c) => {
      const build = line ? state.builds.find((b) => b.lineId === line.id && String(b.bay) === String(c.id) && b.status !== 'complete') : null;
      const f = build ? forecastBuild(build, state.stages, calendar(), state.today) : null;
      const color = f ? riskMeta(f.risk).color : '';
      const bayTitle = c.sprayFoam ? 'Spray Foam' : `Bay ${c.id}`;
      return `<div class="shop-bay ${build ? 'occupied' : 'empty'} ${c.sprayFoam ? 'spray-foam' : ''}"
        style="left:${c.left}%;top:${region.top}%;width:${c.width}%;height:${region.bottom - region.top}%;${build ? `--bay-color:${color}` : ''}"
        data-shop-bay="${c.id}" data-shop-line="${line ? line.id : ''}" data-build="${build ? build.id : ''}"
        title="${line ? esc(line.name) : def.label} · ${bayTitle}${build ? ' · ' + esc(build.name) : ' · open'}">
        <span class="shop-bay-num">${c.label}</span>
        ${build ? `<span class="shop-bay-build">${esc(build.name || 'Untitled')}</span>` : `<span class="shop-bay-open">${c.sprayFoam ? 'foam' : 'open'}</span>`}
      </div>`;
    }).join('');
    return band + cells;
  }).join('');

  const legendItems = [['on-track', 'On Track'], ['at-risk', 'At Risk'], ['late', 'Late'], ['shipped', 'Shipped']];

  $('#shopRoot').innerHTML = `
    <div class="shop-head">
      <div><h2 class="rep-title">Shop Overview</h2>
      <p class="panel-sub" style="margin:4px 0 0">Live floor map — click a bay to open the build in it. Bays are numbered right-to-left.</p></div>
      <div class="shop-legend">${legendItems.map(([k, l]) => `<span class="lg"><i style="background:${riskMeta(k).color}"></i>${l}</span>`).join('')}
        <span class="lg"><i class="shop-empty-swatch"></i>Open</span>
        <button class="btn sm" data-print="shop">Print</button></div>
    </div>
    <div class="shop-map-wrap">
      <div class="shop-map">
        <img src="./assets/shop-floor.jpg" alt="Shop floor plan" class="shop-img"
          onerror="this.classList.add('img-missing');this.closest('.shop-map').classList.add('no-img');">
        <div class="shop-img-missing">Floor plan image not found. Place <code>shop-floor.jpg</code> in a <code>src/assets/</code> folder next to index.html, then refresh. Bays are still clickable below.</div>
        ${overlays}
      </div>
    </div>
`;

  $('#shopRoot').querySelectorAll('[data-shop-bay]').forEach((cell) => {
    cell.addEventListener('click', () => {
      const buildId = cell.dataset.build;
      if (buildId) { openBuild(buildId); return; }
      // Empty bay: offer to place a build here — open a picker of unassigned builds.
      openBayPicker(cell.dataset.shopLine, cell.dataset.shopBay);
    });
  });
}

// When an empty bay is clicked, let the user drop an existing active/confirmed
// build into it (or note there are none to place).
function openBayPicker(lineId, bay) {
  const line = state.lines.find((l) => l.id === lineId);
  const lineTitle = line ? esc(line.name) : 'this line';
  const bayLabel = bay === 'sf' ? 'Spray Foam bay' : `Bay ${bay}`;
  const candidates = state.builds.filter((b) => b.status !== 'complete' && (b.lineId !== lineId || String(b.bay) !== String(bay)));

  const body = candidates.length
    ? `<div class="bp-list">${candidates.map((b) => {
        const f = forecastBuild(b, state.stages, calendar(), state.today);
        const m = riskMeta(f.risk);
        return `<button class="bp-row" data-place-build="${b.id}">
          <span class="bp-dot" style="background:${m.color}"></span>
          <span class="bp-name">${esc(b.name || 'Untitled')}</span>
          <span class="bp-meta">${esc(lineName(b.lineId))}${b.bay ? ' · Bay ' + esc(String(b.bay)) : ' · unassigned'}</span>
        </button>`;
      }).join('')}</div>`
    : `<div class="bp-empty">No builds available to place here. Create a build first, then assign it to this bay.</div>`;

  $('#bayPickerModal').innerHTML = `
    <div class="modal-head"><div><h2>Place a build</h2><div class="mono-sub">${lineTitle} · ${bayLabel}</div></div>
      <button class="ghost" data-close-picker>✕</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot"><button class="btn" data-close-picker>Cancel</button></div>`;

  $('#bayPickerOverlay').classList.add('open');
  $('#bayPickerModal').querySelectorAll('[data-place-build]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetBay = bay === 'sf' ? 'sf' : Number(bay);
      patchBuild(btn.dataset.placeBuild, { lineId, bay: targetBay });
      closeBayPicker();
    });
  });
  $('#bayPickerModal').querySelectorAll('[data-close-picker]').forEach((el) => el.addEventListener('click', closeBayPicker));
}
function closeBayPicker() { $('#bayPickerOverlay').classList.remove('open'); }

function renderPipeline() {
  const builds = filteredBuilds().filter((b) => b.status === 'pipeline' || b.status === 'confirmed');
  $('#pipelineRoot').innerHTML = builds.length ? `
    <p class="panel-sub" style="margin:0 0 14px">Builds awaiting a start date. <strong>Pipeline</strong> = potential projects under discussion; <strong>Confirmed</strong> = committed, pending scheduling.</p>
    <table class="data-table">
      <thead><tr><th>Build</th><th>Status</th><th>Line</th><th>Tentative Start</th><th>Duration</th><th>Projected Completion</th><th>Suggested Start</th><th></th></tr></thead>
      <tbody>
        ${builds.map((b) => {
          const line = state.lines.find((l) => l.id === b.lineId);
          const dur = buildDuration(b, state.stages);
          const sug = line ? suggestStart(b, line, state.builds, state.stages, calendar(), state.today) : null;
          // Projected completion from the tentative start + allocated working days.
          const projFromTentative = (b.tentativeStart && dur > 0)
            ? addWorkdays(b.tentativeStart, dur - 1, calendar())
            : null;
          const stColor = b.status === 'confirmed' ? 'var(--pine)' : 'var(--text-dim)';
          return `<tr>
            <td class="td-name" data-open="${b.id}">${esc(b.name)}<span class="td-sub">${esc(b.id)} · ${esc(b.client || '')}</span></td>
            <td><span class="status-pill" style="color:${stColor};border-color:${stColor}">${esc(b.status)}</span></td>
            <td>${esc(lineName(b.lineId))}</td>
            <td>${fmtDate(b.tentativeStart)}</td>
            <td>${dur} wd</td>
            <td>${projFromTentative ? `<span class="suggest">${fmtDate(projFromTentative)}</span>` : '<span class="td-sub">set tentative start</span>'}</td>
            <td>${sug?.start ? `<span class="suggest">${fmtDate(sug.start)}</span>` : '<span class="td-sub">—</span>'}<div class="td-sub">${esc(sug?.reason || '')}</div></td>
            <td><button class="btn sm" data-confirm-suggest="${b.id}" ${sug?.start ? '' : 'disabled'}>Confirm start</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<div class="empty">No builds awaiting a start date.</div>';
}

// ----------------------------- Settings -----------------------------
// ----------------------------- Reports (analytics for decisions) -----------------------------
function renderReports() {
  const r = buildReport(state.builds, state.lines, state.stages, calendar(), state.today);
  const done = completedCount();

  // KPI cards
  const kpis = [
    { label: 'On-Time Delivery', value: r.onTime.rate === null ? '—' : r.onTime.rate + '%', sub: r.onTime.total ? `${r.onTime.onTime}/${r.onTime.total} builds` : 'no shipped builds yet', tone: r.onTime.rate === null ? '' : r.onTime.rate >= 85 ? 'good' : r.onTime.rate >= 60 ? 'warn' : 'bad' },
    { label: 'Avg Cycle Time', value: r.cycle.count ? r.cycle.meanDays + ' wd' : '—', sub: r.cycle.count ? `median ${r.cycle.medianDays} · ${r.cycle.count} builds` : 'no completed builds', tone: '' },
    { label: 'Estimate Accuracy', value: r.accuracy.count ? '×' + r.accuracy.meanRatio : '—', sub: r.accuracy.count ? `${r.accuracy.overrunRate}% ran long` : 'no data yet', tone: r.accuracy.count ? (r.accuracy.meanRatio <= 1.05 ? 'good' : r.accuracy.meanRatio <= 1.25 ? 'warn' : 'bad') : '' },
    { label: 'Backlog', value: r.backlog.weeksOfWork + ' wk', sub: `${r.backlog.remainingBuildDays} build-days · ${r.backlog.activeBuilds} active`, tone: '' },
  ];

  const trendArrow = { up: '▲', down: '▼', flat: '▬' }[r.throughput.direction];
  const trendTone = { up: 'good', down: 'bad', flat: '' }[r.throughput.direction];

  $('#reportsRoot').innerHTML = `
    <div class="rep-head">
      <div><h2 class="rep-title">Production Analytics</h2>
      <p class="panel-sub">Decision metrics computed live from your build data. Metrics needing shipped-build history populate as builds complete with actual start/ship dates logged.</p></div>
    </div>

    <div class="kpi-row">
      ${kpis.map((k) => `<div class="kpi ${k.tone}"><span class="kpi-label">${k.label}</span><span class="kpi-value">${k.value}</span><span class="kpi-sub">${k.sub}</span></div>`).join('')}
    </div>

    <div class="dash-grid">
      <section class="panel">
        <h2>Throughput <span class="trend ${trendTone}">${trendArrow} ${r.throughput.direction}</span></h2>
        <p class="panel-sub">Builds shipped per month. Recent avg ${r.throughput.recentAvg}/mo vs prior ${r.throughput.priorAvg}/mo.</p>
        <div class="throughput-controls">
          <label class="tp-year-label">Year <select id="throughputYear" class="search"></select></label>
          <span class="tp-year-total" id="throughputTotal"></span>
        </div>
        <div class="bar-chart" id="throughputChart"></div>
      </section>

      <section class="panel">
        <h2>Line Utilization</h2>
        <p class="panel-sub">Booked build-days vs. capacity over the next 90 days. Over 85% = constrained; under 40% = room for more work.</p>
        <div class="util-list">
          ${r.utilization.map((u) => `<div class="util-row">
            <div class="util-head"><span>${esc(u.lineName)}</span><span class="util-state ${u.state}">${u.utilization}% · ${u.state}</span></div>
            <div class="util-track"><div class="util-fill ${u.state}" style="width:${Math.min(100, u.utilization)}%"></div></div>
          </div>`).join('')}
        </div>
      </section>

      <section class="panel span-2">
        <h2>Bottleneck Analysis</h2>
        <p class="panel-sub">Stages ranked by total planned days across active builds — where your capacity is most consumed. ${r.bottleneck.bottleneck ? `Current bottleneck: <strong>${esc(r.bottleneck.bottleneck.label)}</strong>.` : ''}</p>
        <table class="data-table">
          <thead><tr><th>Stage</th><th>Total Planned Days</th><th>Builds Using</th><th>Avg Days</th><th>In Progress Now</th><th>Overrun Rate</th></tr></thead>
          <tbody>
            ${[...r.bottleneck.rows].sort((a, b) => b.totalPlannedDays - a.totalPlannedDays).map((row, i) => `
              <tr>
                <td class="td-name">${i === 0 && row.totalPlannedDays > 0 ? '🔴 ' : ''}${esc(row.label)}</td>
                <td><div class="mini-bar-wrap"><div class="mini-bar" style="width:${row.totalPlannedDays / Math.max(1, r.bottleneck.rows[0] ? Math.max(...r.bottleneck.rows.map((x) => x.totalPlannedDays)) : 1) * 100}%"></div></div>${row.totalPlannedDays}</td>
                <td>${row.buildsUsing}</td>
                <td>${row.avgPlannedDays}</td>
                <td>${row.inProgressNow}</td>
                <td>${row.overrunRate === null ? '<span class="td-sub">no data</span>' : row.overrunRate + '%'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>

      ${r.cycle.perType.length ? `
      <section class="panel">
        <h2>Cycle Time by Module Type</h2>
        <p class="panel-sub">How long each product actually takes, start to ship (working days).</p>
        <table class="data-table">
          <thead><tr><th>Module Type</th><th>Builds</th><th>Mean</th><th>Median</th></tr></thead>
          <tbody>${r.cycle.perType.map((t) => `<tr><td class="td-name">${esc(t.type)}</td><td>${t.count}</td><td>${t.meanDays} wd</td><td>${t.medianDays} wd</td></tr>`).join('')}</tbody>
        </table>
      </section>` : ''}

      ${r.accuracy.count ? `
      <section class="panel">
        <h2>Estimate Accuracy</h2>
        <p class="panel-sub">Planned vs. actual duration. Ratio over 1.0 means it took longer than planned — use this to calibrate future estimates.</p>
        <table class="data-table">
          <thead><tr><th>Build</th><th>Planned</th><th>Actual</th><th>Ratio</th></tr></thead>
          <tbody>${r.accuracy.rows.slice(0, 8).map((row) => `<tr><td class="td-name">${esc(row.name)}</td><td>${row.plannedDays} wd</td><td>${row.actualDays} wd</td><td class="${row.ratio > 1.15 ? 'ratio-bad' : row.ratio > 1.02 ? 'ratio-warn' : 'ratio-good'}">×${row.ratio}</td></tr>`).join('')}</tbody>
        </table>
      </section>` : ''}
    </div>

    ${done === 0 ? `<div class="rep-note">📊 Most historical metrics (on-time %, cycle time, accuracy) populate once builds are completed with <strong>actual start and ship dates</strong>. To log these: open a build, set its Status to Complete, and fill in the actual dates. Forward-looking metrics (backlog, utilization, bottleneck) are live now.</div>` : ''}

    <section class="panel span-2" style="margin-top:18px">
      <div class="rep-head" style="margin-bottom:8px">
        <div><h2>Build Hours</h2>
        <p class="panel-sub">Projected build hours vs. actual hours logged across production stages. Variance shows which builds are running over or under their hour budget.</p></div>
      </div>
      ${(() => {
        const withHours = state.builds.filter((b) => (Number(b.projectedHours) || 0) > 0 || state.stages.some((s) => Number(b.stageHours?.[s.id]) || 0));
        if (!withHours.length) return '<div class="forecast-detail-note">No build hours logged yet. Open a build, set its projected build hours, and log actual hours per stage to track them here.</div>';
        return `<table class="data-table">
          <thead><tr><th>Build</th><th>Status</th><th>Projected</th><th>Actual</th><th>Variance</th><th>% of budget</th></tr></thead>
          <tbody>${withHours.map((b) => {
            const proj = Number(b.projectedHours) || 0;
            const act = state.stages.reduce((s, st) => s + (Number(b.stageHours?.[st.id]) || 0), 0);
            const varc = act - proj;
            const pct = proj ? Math.round(act / proj * 100) : 0;
            const tone = varc > 0 ? 'var(--clay)' : varc < 0 ? 'var(--pine)' : 'var(--text-muted)';
            return `<tr data-open="${b.id}">
              <td class="td-name">${esc(b.name || 'Untitled')}<span class="td-sub">${esc(b.client || '')}</span></td>
              <td><span class="td-sub">${esc(b.status)}</span></td>
              <td>${proj || '—'}</td>
              <td>${act || 0}</td>
              <td style="color:${tone};font-weight:600">${proj ? `${varc > 0 ? '+' : ''}${varc}` : '—'}</td>
              <td>${proj ? `${pct}%` : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
      })()}
    </section>

    <section class="panel span-2" style="margin-top:18px">
      <div class="rep-head" style="margin-bottom:8px">
        <div><h2>Build History Timeline</h2>
        <p class="panel-sub">A timestamped record of every build's journey — status changes, stage starts and completions, and shipping dates — captured automatically as you work.</p></div>
        <div class="rep-head-actions">
          <select id="historyFilter" class="search" style="min-width:180px"><option value="">All builds</option></select>
        </div>
      </div>
      <div id="historyTimeline"><div class="td-sub">Loading history…</div></div>
    </section>`;

  $('#exportReport')?.addEventListener('click', () => exportReportCSV(r));
  $('#exportHours')?.addEventListener('click', () => exportHoursCSV());
  loadHistoryTimeline();
  renderThroughputByYear();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Interactive throughput: builds shipped per month for a selected year, with
// month-name labels and the count shown on each bar. The year selector is built
// from the years that actually have shipped builds (plus the current year).
function renderThroughputByYear(selectedYear) {
  const sel = $('#throughputYear');
  const chart = $('#throughputChart');
  if (!sel || !chart) return;

  const shipped = state.builds.filter((b) => b.status === 'complete' && b.actualShip);
  const years = new Set(shipped.map((b) => b.actualShip.slice(0, 4)));
  years.add(String(new Date(state.today).getFullYear()));
  const yearList = [...years].sort((a, b) => (a < b ? 1 : -1));

  const year = selectedYear || sel.value || yearList[0];
  // (Re)build the year dropdown only once, preserving the chosen value.
  if (sel.options.length !== yearList.length) {
    sel.innerHTML = yearList.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('');
    sel.onchange = () => renderThroughputByYear(sel.value);
  }

  // Count builds shipped in each month of the selected year.
  const counts = new Array(12).fill(0);
  for (const b of shipped) {
    if (b.actualShip.slice(0, 4) === year) counts[Number(b.actualShip.slice(5, 7)) - 1]++;
  }
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, c) => a + c, 0);

  $('#throughputTotal').textContent = `${total} shipped in ${year}`;
  chart.innerHTML = counts.map((count, i) => `
    <div class="bc-col">
      <span class="bc-count">${count || ''}</span>
      <div class="bc-bar" style="height:${count / max * 100}%" title="${MONTH_NAMES[i]} ${year}: ${count} shipped"></div>
      <span class="bc-x">${MONTH_NAMES[i]}</span>
    </div>`).join('');
}

function completedCount() {
  return state.builds.filter((b) => b.status === 'complete' && b.actualShip).length;
}

// Export per-build and per-stage hours (projected vs. actual) as CSV.
function exportHoursCSV() {
  const rows = [['Build', 'Client', 'Status', 'Projected hours', 'Actual hours', 'Variance', ...state.stages.map((s) => `${s.label} (hrs)`)]];
  for (const b of state.builds) {
    const proj = Number(b.projectedHours) || 0;
    const act = state.stages.reduce((s, st) => s + (Number(b.stageHours?.[st.id]) || 0), 0);
    if (!proj && !act) continue;
    rows.push([
      b.name || 'Untitled', b.client || '', b.status, proj, act, act - proj,
      ...state.stages.map((s) => Number(b.stageHours?.[s.id]) || 0),
    ]);
  }
  const csv = rows.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `traveler-build-hours-${state.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// Human-readable label for a history event, resolving stage ids to stage names.
function historyEventLabel(ev) {
  const stageName = (sid) => state.stages.find((s) => s.id === sid)?.label || sid;
  switch (ev.kind) {
    case 'created': return 'Build created';
    case 'deleted': return 'Build deleted';
    case 'status': return `Status changed: ${ev.from || '—'} → ${ev.to || '—'}`;
    case 'shipped': return ev.to ? `Shipped (${fmtDate(ev.to)})` : 'Ship date cleared';
    case 'stage-complete': return `✓ ${stageName(ev.field?.replace('stage:', ''))} completed`;
    case 'stage-start': return `▸ ${stageName(ev.field?.replace('stage:', ''))} started`;
    case 'stage-progress': return `${stageName(ev.field?.replace('stage:', ''))}: ${ev.from}% → ${ev.to}%`;
    case 'date': return ev.label || 'Date updated';
    default: return ev.label || ev.kind;
  }
}

function historyEventTone(kind) {
  return { 'stage-complete': 'good', shipped: 'good', 'status': 'accent', deleted: 'bad', created: 'accent' }[kind] || '';
}

async function loadHistoryTimeline() {
  const container = $('#historyTimeline');
  if (!container) return;
  let events;
  try { events = await repo.historyEvents(); } catch { container.innerHTML = '<div class="td-sub">History unavailable.</div>'; return; }
  state._historyEvents = events;

  // Populate the build filter with builds that have history.
  const sel = $('#historyFilter');
  if (sel) {
    const names = new Map();
    for (const e of events) if (e.buildId && !names.has(e.buildId)) names.set(e.buildId, historyBuildName(e));
    for (const [id, name] of names) { const o = document.createElement('option'); o.value = id; o.textContent = name; sel.appendChild(o); }
    sel.addEventListener('change', () => renderHistoryList(sel.value));
  }
  $('#exportHistory')?.addEventListener('click', () => exportHistoryCSV(state._historyEvents));
  renderHistoryList('');
}

// Resolve a history event to the build's *current* name — so an event captured
// before the build was named (new builds start blank) still shows the real name
// now, rather than falling back to the cryptic internal id.
function historyBuildName(e) {
  const current = state.builds.find((b) => b.id === e.buildId);
  return (current && current.name) || e.name || 'Untitled build';
}

function renderHistoryList(filterId) {
  const container = $('#historyTimeline');
  const events = (state._historyEvents || []).filter((e) => !filterId || e.buildId === filterId);
  if (!events.length) {
    container.innerHTML = '<div class="empty">No history recorded yet. As you change build statuses and mark stages complete, events will appear here with timestamps.</div>';
    return;
  }
  // Group by day for readability.
  const byDay = {};
  for (const e of events) { const day = (e.at || '').slice(0, 10); (byDay[day] ||= []).push(e); }
  const days = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));
  container.innerHTML = days.map((day) => `
    <div class="hist-day">
      <div class="hist-day-head">${fmtDate(day)}</div>
      ${byDay[day].map((e) => `
        <div class="hist-row">
          <span class="hist-time">${new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
          <span class="hist-dot ${historyEventTone(e.kind)}"></span>
          <span class="hist-build">${esc(historyBuildName(e))}</span>
          <span class="hist-event ${historyEventTone(e.kind)}">${esc(historyEventLabel(e))}</span>
        </div>`).join('')}
    </div>`).join('');
}

function exportHistoryCSV(events) {
  const rows = [['Timestamp', 'Build', 'Event', 'From', 'To']];
  for (const e of events || []) {
    rows.push([e.at, historyBuildName(e), historyEventLabel(e), e.from ?? '', e.to ?? '']);
  }
  const csv = rows.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `traveler-history-${state.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

function exportReportCSV(r) {
  const rows = [
    ['Metric', 'Value', 'Detail'],
    ['On-Time Delivery %', r.onTime.rate ?? 'n/a', `${r.onTime.onTime}/${r.onTime.total}`],
    ['Avg Cycle Time (wd)', r.cycle.meanDays, `median ${r.cycle.medianDays}`],
    ['Estimate Accuracy', r.accuracy.meanRatio, `${r.accuracy.overrunRate}% overran`],
    ['Backlog (weeks)', r.backlog.weeksOfWork, `${r.backlog.remainingBuildDays} build-days`],
    ['Throughput trend', r.throughput.direction, `recent ${r.throughput.recentAvg}/mo`],
    [],
    ['Bottleneck — Stage', 'Total Planned Days', 'Builds Using'],
    ...[...r.bottleneck.rows].sort((a, b) => b.totalPlannedDays - a.totalPlannedDays).map((x) => [x.label, x.totalPlannedDays, x.buildsUsing]),
    [],
    ['Line Utilization', 'Percent', 'State'],
    ...r.utilization.map((u) => [u.lineName, u.utilization, u.state]),
  ];
  const csv = rows.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `traveler-report-${state.today}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// Settings lists that hold plain strings rather than {id,label} objects.
const SIMPLE_SETTING_LISTS = ['moduleTypes', 'roles'];
function isSimpleList(key) { return SIMPLE_SETTING_LISTS.includes(key); }

function renderSettings() {
  const lists = [
    { key: 'roles', title: 'Crew Roles', simple: true },
    { key: 'moduleTypes', title: 'Module Types', simple: true },
    { key: 'inspections', title: 'Inspection Points' },
    { key: 'healthStatuses', title: 'Health Statuses' },
    { key: 'stageStatuses', title: 'Stage Statuses' },
  ];

  // Crew / people — each with a role and a weekly labor-hour capacity.
  const people = state.settings.people || [];
  const roles = state.settings.roles || [];
  const crewFilter = state.crewRoleFilter || 'all';
  const shownPeople = crewFilter === 'all' ? people : people.filter((p) => (p.role || '') === crewFilter);
  // Build a role <select> for a person (or the add form when id is null).
  const roleSelect = (selected, id) => `<select class="ce-role" ${id ? `data-crew-field="role" data-crew-id="${id}"` : 'class="ce-role ac-role"'} title="Role">
      <option value=""${!selected ? ' selected' : ''}>— No role —</option>
      ${roles.map((r) => `<option value="${esc(r)}"${selected === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}
      ${selected && !roles.includes(selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : ''}
    </select>`;
  const peopleCard = `<div class="settings-card"><h3>Crew <span class="count-pill">${people.length}</span></h3>
    <p class="card-hint">People with a role and weekly hour capacity. Manage roles in the <strong>Crew Roles</strong> card.</p>
    <label class="crew-filter"><span>Role</span><select data-crew-filter>
      <option value="all"${crewFilter === 'all' ? ' selected' : ''}>All roles (${people.length})</option>
      ${roles.map((r) => { const n = people.filter((p) => (p.role || '') === r).length; return `<option value="${esc(r)}"${crewFilter === r ? ' selected' : ''}>${esc(r)} (${n})</option>`; }).join('')}
      ${people.some((p) => !p.role) ? `<option value=""${crewFilter === '' ? ' selected' : ''}>No role (${people.filter((p) => !p.role).length})</option>` : ''}
    </select></label>
    <div class="crew-edit-list">
    ${shownPeople.map((p) => `<div class="crew-edit-row" data-crew-row="${p.id}">
      <input class="ce-name" value="${esc(p.name)}" data-crew-field="name" data-crew-id="${p.id}" placeholder="Name" title="Name">
      <button class="rm" data-del-crew="${p.id}" title="Remove person">✕</button>
      ${roleSelect(p.role || '', p.id)}
      <label class="ce-num"><span>hrs/wk</span><input type="number" min="0" value="${p.weeklyHours ?? 40}" data-crew-field="weeklyHours" data-crew-id="${p.id}" title="Weekly hour capacity"></label>
      </div>`).join('') || `<div class="td-sub" style="padding:8px">${people.length ? 'No crew with that role.' : 'No crew yet.'}</div>`}
    </div><form class="add-row add-crew-row" data-add-crew>
      <input placeholder="Name…" class="ac-name" required>
      <select class="ac-role" title="Role"><option value="">— Role —</option>${roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
      <label class="cap-field"><span>hrs</span><input type="number" min="0" value="40" class="ac-hours cap-input"></label>
      <button class="btn sm primary">Add</button></form></div>`;

  const lineCards = `<div class="settings-card"><h3>Production Lines</h3>
    <p class="card-hint">Capacity = builds running at once. Workdays/week sets how many days that line runs.</p>
    <div class="line-edit-list">
    ${state.lines.map((l) => `<div class="line-edit-row" data-line-row="${l.id}">
      <input class="le-name" value="${esc(l.name)}" data-line-field="name" data-line-id="${l.id}" title="Line name">
      <label class="le-num"><span>Cap</span><input type="number" min="1" value="${l.capacity}" data-line-field="capacity" data-line-id="${l.id}"></label>
      <label class="le-num"><span>Days/wk</span><input type="number" min="1" max="7" value="${l.workdaysPerWeek || 5}" data-line-field="workdaysPerWeek" data-line-id="${l.id}"></label>
      <span class="le-count">${state.builds.filter((b) => b.lineId === l.id).length} builds</span>
      <button class="rm" data-del-line="${l.id}" title="Remove line">✕</button></div>`).join('')}
    </div><form class="add-row add-line-row" data-add-line>
      <input class="le-name" placeholder="New line name…" required>
      <label class="le-num"><span>Cap</span><input type="number" min="1" value="2" title="How many builds this line runs at once"></label>
      <label class="le-num"><span>Days/wk</span><input type="number" min="1" max="7" value="5" title="Working days per week"></label>
      <button class="btn sm primary">Add</button></form></div>`;

  const stageCard = `<div class="settings-card"><h3>Production Stages <span class="count-pill">${state.stages.length}</span></h3>
    <p class="card-hint">Drag to reorder — this sets the production sequence used everywhere (build panels, Gantt, Build Hours).</p>
    <div class="opt-list" data-reorder="stages">
    ${state.stages.map((s) => `<div class="opt-row" draggable="true" data-reorder-id="${s.id}"><span class="drag-handle" title="Drag to reorder">⠿</span><span class="opt-num">${s.order}</span><input class="opt-edit" value="${esc(s.label)}" data-rename-stage="${s.id}" title="Edit stage name">
      <button class="rm" data-del-stage="${s.id}">✕</button></div>`).join('')}
    </div><form class="add-row" data-add-stage><input placeholder="New stage…" required><button class="btn sm primary">Add</button></form></div>`;

  const optCards = lists.map((cfg) => {
    const items = state.settings[cfg.key] || [];
    return `<div class="settings-card"><h3>${cfg.title}</h3>
      <p class="card-hint">Drag to reorder.</p>
      <div class="opt-list" data-reorder="opt:${cfg.key}">
      ${items.map((it) => { const label = cfg.simple ? it : it.label; const color = cfg.simple ? null : it.color; const idv = cfg.simple ? it : it.id;
        return `<div class="opt-row" draggable="true" data-reorder-id="${esc(idv)}"><span class="drag-handle" title="Drag to reorder">⠿</span>${color ? `<span class="opt-dot" style="background:${color}"></span>` : ''}<input class="opt-edit" value="${esc(label)}" data-rename-opt="${cfg.key}" data-rename-id="${esc(idv)}" title="Edit name">
          <button class="rm" data-del-opt="${cfg.key}" data-del-val="${esc(idv)}">✕</button></div>`; }).join('')
        || '<div class="td-sub" style="padding:4px">None yet.</div>'}
      </div><form class="add-row" data-add-opt="${cfg.key}"><input placeholder="Add…" required><button class="btn sm primary">Add</button></form></div>`;
  }).join('');

  // Every export in one place, rather than a button buried in each tab.
  const exportCard = `<div class="card settings-card">
    <h3>Export</h3>
    <p class="card-hint">Download planning data, or a full backup you keep yourself.</p>
    <div class="export-row">
      <select id="exportPick">
        <option value="backup">Full backup (.json)</option>
        <option value="hours-matrix">Build hours by stage (.csv)</option>
        <option value="hours">Hours summary (.csv)</option>
        <option value="report">Performance report (.csv)</option>
        <option value="history">Change history (.csv)</option>
      </select>
      <button class="btn primary" id="exportGo">Download</button>
    </div>
  </div>`;

  $('#settingsRoot').innerHTML = `
    <p class="settings-intro">These lists drive every build's fields and the planning engine. Line capacity feeds overbooking detection; stages define the production sequence the scheduler walks. Changes save immediately and persist.</p>
    <div class="settings-actions">
      <button class="btn" id="importBtn">Import backup</button>
      <input type="file" id="importFile" accept="application/json" hidden>
      <span class="td-sub" id="storageNote"></span>
    </div>
    <div class="settings-grid"><div id="adminPeopleRoot"></div>${exportCard}${lineCards}${peopleCard}${stageCard}${optCards}</div>`;
  makeSettingsCollapsible();
  // Admins get the People & Access panel. The hook is only defined when main.js
  // loaded admin-ui.js, so this is a no-op for editors and viewers.
  globalThis.__TRAVELER_RENDER_ADMIN__?.();
  $('#storageNote').textContent = repo.backend.isMemory ? 'Storage: in-memory (this browser lacks IndexedDB — data will not persist)' : 'Storage: IndexedDB (persists across refreshes on this device)';
}

// ----------------------------- Build detail modal -----------------------------
function openBuild(id) { state.draftBuild = null; state.openBuildId = id; state.modalTab = 'details'; renderBuildModal(); $('#buildOverlay').classList.add('open'); }
function closeBuild() { state.openBuildId = null; state.draftBuild = null; $('#buildOverlay').classList.remove('open'); }

// The build currently shown in the modal: an unsaved draft (from New Build) or a
// stored build. Draft edits stay in memory until the user clicks Save build.
function currentBuild() {
  if (state.draftBuild && state.draftBuild.id === state.openBuildId) return state.draftBuild;
  return state.builds.find((x) => x.id === state.openBuildId);
}
function isDraftOpen() { return !!(state.draftBuild && state.draftBuild.id === state.openBuildId); }

// Re-render the modal after an external data change WITHOUT disrupting an active edit:
// remember what's focused (and cursor position), rebuild, then restore focus.
function renderBuildModalPreservingFocus() {
  const active = document.activeElement;
  const inModal = active && $('#buildModal').contains(active);
  let key = null, selStart = null, selEnd = null;
  if (inModal) {
    key = active.dataset.field ? `field:${active.dataset.field}`
      : active.dataset.stageDays !== undefined && active.matches('[data-stage-days]') ? `days:${active.closest('[data-stage]')?.dataset.stage}`
      : null;
    try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch { /* non-text inputs */ }
  }
  // If the user is mid-edit in a text/date/number field, don't rebuild the whole
  // modal (that would fight the cursor) — but DO update every derived display in
  // place so forecast, totals, and header stats stay live as they type.
  if (inModal && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    updateModalDerived();
    return;
  }
  renderBuildModal();
  if (key) {
    const sel = key.startsWith('field:') ? `[data-field="${key.slice(6)}"]`
      : key.startsWith('days:') ? `[data-stage="${key.slice(5)}"] [data-stage-days]` : null;
    const el = sel && $(sel, $('#buildModal'));
    if (el) { el.focus(); try { el.setSelectionRange(selStart, selEnd); } catch { /* ignore */ } }
  }
}

// Refresh every computed display inside the open modal in place — without
// rebuilding inputs — so live edits reflect immediately.
function updateHoursSummary() {
  // Read straight from the inputs so the summary is always in sync with what the
  // user sees, independent of async state refresh timing.
  const projInput = $('#buildModal input[data-field="projectedHours"]');
  const proj = Number(projInput?.value) || 0;
  let actual = 0;
  $$('#buildModal .st-hours').forEach((el) => { actual += Number(el.value) || 0; });
  const variance = actual - proj;
  const tone = variance > 0 ? 'over' : variance < 0 ? 'under' : 'even';
  const cells = $$('#buildModal .hs-cell .hs-val');
  if (cells[0]) cells[0].textContent = proj || '—';
  if (cells[1]) cells[1].textContent = actual || 0;
  if (cells[2]) cells[2].textContent = proj ? `${variance > 0 ? '+' : ''}${variance}` : '—';
  const varCell = $('#buildModal .hs-var');
  if (varCell) varCell.className = `hs-cell hs-var ${tone}`;
  const note = $('#buildModal .hs-note');
  if (note) {
    if (proj && actual) {
      note.className = `hs-note ${tone}`;
      note.textContent = variance > 0 ? `Over budget by ${variance} hours`
        : variance < 0 ? `Under budget by ${Math.abs(variance)} hours`
        : 'Exactly on the projected hours';
      note.style.display = '';
    } else { note.style.display = 'none'; }
  }
}

function updateModalDerived() {
  const b = currentBuild();
  if (!b) return;
  // Header name + subtitle update live as the user types name/client.
  const h2 = $('#buildModal .modal-head h2');
  if (h2 && document.activeElement?.dataset?.field !== undefined) h2.textContent = b.name || 'Untitled Build';
  const sub = $('#buildModal .mono-sub');
  if (sub) sub.textContent = `${b.id} · ${b.client || 'No client'}`;
  // Forecast banner
  const banner = $('.forecast-banner');
  if (banner) {
    const f = forecastBuild(b, state.stages, calendar(), state.today);
    const m = riskMeta(f.risk);
    banner.style.borderColor = m.color;
    banner.innerHTML = `<div><span class="fb-label">Forecast</span><span class="badge" style="background:${m.color}">${m.label}</span></div>
      <div class="fb-detail">${esc(f.reason)}${f.projectedShip ? ` · projected ${fmtDate(f.projectedShip)}` : ''}</div>`;
  }
  // Stage total (planned working days), only refresh if the focused field isn't itself the total
  const totalNote = $('#stageTotalNote');
  if (totalNote) totalNote.textContent = `${buildDuration(b, state.stages)} planned working days total`;
  // Header portfolio stats behind the modal
  renderHeaderStats();
}

// Convert a picked/dropped file to a stored attachment (base64 data URL). Guards
// against very large files that would bloat the local database.
const ATTACH_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
async function fileToAttachment(file) {
  if (file.size > ATTACH_MAX_BYTES) {
    alert(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the 15 MB limit for stored files. For large files, link them from Google Drive instead.`);
    return null;
  }
  // In cloud mode files go to object storage and we keep only a URL. Embedding
  // base64 in the database would bloat it badly once several people upload.
  const cloud = globalThis.__TRAVELER_CLOUD__;
  if (cloud) {
    try {
      const up = await cloud.uploadFile(file);
      return { kind: 'file', name: up.name, mime: up.type || '', size: up.size, path: up.path, addedAt: new Date().toISOString() };
    } catch (err) {
      alert(`Upload failed: ${err.message || err}`);
      return null;
    }
  }
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  return { kind: 'file', name: file.name, mime: file.type || '', size: file.size, data, addedAt: new Date().toISOString() };
}

async function addAttachment(id, key, att) {
  const b = (await repo.getBuild(id)) || currentBuild();
  if (!b) return;
  const attachments = { ...(b.attachments || {}) };
  attachments[key] = [...(attachments[key] || []), att];
  await patchBuild(id, { attachments });
}

// Derive a friendly name from a Google Drive (or any) URL.
function driveLinkName(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('google')) {
      if (u.pathname.includes('/document/')) return 'Google Doc';
      if (u.pathname.includes('/spreadsheets/')) return 'Google Sheet';
      if (u.pathname.includes('/presentation/')) return 'Google Slides';
      return 'Google Drive file';
    }
    return u.hostname.replace('www.', '');
  } catch { return 'Link'; }
}

// Render one attachment category (Build Documents / Workbook / Bill of Materials):
// a drop zone for local files, a Google Drive link input, and the list of items.
function attachField(build, key, label) {
  const items = build.attachments?.[key] || [];
  const list = items.map((it, i) => {
    if (it.kind === 'link') {
      return `<div class="attach-item link"><span class="ai-icon">🔗</span><a class="ai-name" href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.url)}">${esc(it.name || it.url)}</a><button class="ai-rm" data-attach-remove="${key}" data-attach-idx="${i}" title="Remove">✕</button></div>`;
    }
    const sizeKb = it.size ? `${(it.size / 1024).toFixed(0)} KB` : '';
    return `<div class="attach-item file"><span class="ai-icon">📄</span><button class="ai-name ai-download" data-attach-open="${key}" data-attach-idx="${i}" title="Download ${esc(it.name)}">${esc(it.name)}</button><span class="ai-size">${sizeKb}</span><button class="ai-rm" data-attach-remove="${key}" data-attach-idx="${i}" title="Remove">✕</button></div>`;
  }).join('');
  return `<div class="attach-group" data-attach-key="${key}">
    <div class="attach-label">${label}</div>
    <div class="attach-drop" data-attach-drop="${key}">
      <span class="attach-drop-text">Drop a file here, or <button type="button" class="attach-browse" data-attach-browse="${key}">browse</button></span>
      <input type="file" class="attach-input" data-attach-file="${key}" hidden>
    </div>
    <div class="attach-linkrow">
      <input type="url" class="attach-linkinput" data-attach-linkurl="${key}" placeholder="Paste a Google Drive link…">
      <button type="button" class="btn sm" data-attach-addlink="${key}">Link</button>
    </div>
    ${items.length ? `<div class="attach-list">${list}</div>` : ''}
  </div>`;
}

function renderBuildModal() {
  const b = currentBuild();
  if (!b) return;
  const draft = isDraftOpen();
  const f = forecastBuild(b, state.stages, calendar(), state.today);
  const m = riskMeta(f.risk);
  const health = state.settings.healthStatuses || [];
  const stageStatuses = state.settings.stageStatuses || [];
  const dur = buildDuration(b, state.stages);

  const stageRows = state.stages.map((s) => {
    const prog = Math.round((b.stageProgress?.[s.id] || 0) * 100);
    const days = b.stageDurations?.[s.id] || 0;
    const hrs = b.stageHours?.[s.id] || 0;
    return `<div class="stage-row" data-stage="${s.id}">
      <span class="st-order">${s.order}</span>
      <span class="st-label" title="${esc(s.label)}">${esc(s.label)}</span>
      <input type="number" class="st-days" min="0" value="${days}" data-stage-days title="Planned working days">
      <input type="number" class="st-hours" min="0" step="0.5" value="${hrs}" data-stage-hours title="Actual hours logged" placeholder="hrs">
      <input type="range" class="st-range" min="0" max="100" step="10" value="${prog}" data-stage-prog title="% complete">
      <span class="st-prog">${prog}%</span>
    </div>`;
  }).join('');

  // Build-hours reconciliation: projected total vs. actual hours summed from stages.
  const projectedHours = Number(b.projectedHours) || 0;
  const actualHours = state.stages.reduce((sum, s) => sum + (Number(b.stageHours?.[s.id]) || 0), 0);
  const hoursVariance = actualHours - projectedHours;
  const varTone = hoursVariance > 0 ? 'over' : hoursVariance < 0 ? 'under' : 'even';

  const attachCount = ['buildDocuments', 'workbook', 'billOfMaterials']
    .reduce((n, k) => n + ((b.attachments?.[k] || []).length), 0);
  const tab = state.modalTab || 'details';
  // Badges: crew assigned count, and inspection status summary.
  const crewCount = new Set(Object.values(b.stageCrew || {}).flat().filter(Boolean)).size;
  const inspections = state.settings.inspections || [];
  const inspOf = (i) => (b.inspectionData && b.inspectionData[i.id]?.status) || (b.inspectionStatus && b.inspectionStatus[i.id]) || '';
  const inspFailed = inspections.filter((i) => inspOf(i) === 'failed').length;
  const inspPassed = inspections.filter((i) => inspOf(i) === 'passed').length;

  $('#buildModal').innerHTML = `
    <div class="modal-head"><div><h2>${esc(b.name || 'Untitled Build')}</h2><div class="mono-sub">${esc(b.id)} · ${esc(b.client || 'No client')}</div></div>
      <button class="ghost" data-close-build>✕</button></div>
    <div class="modal-tabs">
      <button class="modal-tab ${tab === 'details' ? 'active' : ''}" data-modal-tab="details">Details</button>
      <button class="modal-tab ${tab === 'crew' ? 'active' : ''}" data-modal-tab="crew">Crew${crewCount ? ` <span class="mt-badge">${crewCount}</span>` : ''}</button>
      <button class="modal-tab ${tab === 'inspections' ? 'active' : ''}" data-modal-tab="inspections">Inspections${inspFailed ? ` <span class="mt-badge fail">${inspFailed}!</span>` : inspPassed ? ` <span class="mt-badge ok">${inspPassed}</span>` : ''}</button>
      <button class="modal-tab ${tab === 'files' ? 'active' : ''}" data-modal-tab="files">Files &amp; Documents${attachCount ? ` <span class="mt-badge">${attachCount}</span>` : ''}</button>
    </div>
    <div class="modal-body">
      <div class="modal-panel" ${tab === 'details' ? '' : 'hidden'}>
      <div class="forecast-banner" style="border-color:${m.color}">
        <div><span class="fb-label">Forecast</span><span class="badge" style="background:${m.color}">${m.label}</span></div>
        <div class="fb-detail">${esc(f.reason)}${f.projectedShip ? ` · projected ${fmtDate(f.projectedShip)}` : ''}</div>
      </div>

      <div class="field-grid">
        <label class="field field-wide"><span>Build name</span><input value="${esc(b.name || '')}" data-field="name" placeholder="e.g. Ofland — Mod A"></label>
        <label class="field"><span>Client</span><input value="${esc(b.client || '')}" data-field="client"></label>
        <label class="field"><span>Module type</span><select data-field="moduleType"><option value="">— None —</option>${(state.settings.moduleTypes || []).map((t) => `<option ${b.moduleType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field"><span>Production line</span><select data-field="lineId">${state.lines.map((l) => `<option value="${l.id}" ${b.lineId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Bay</span><select data-field="bay">${bayOptions(b)}</select></label>
        <label class="field"><span>Status</span><select data-field="status">${['pipeline', 'confirmed', 'active', 'complete'].map((s) => `<option ${b.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field"><span>Start date <em class="hint">(confirmed / actual)</em></span><input type="date" value="${b.confirmedStart || ''}" data-field="startDate"></label>
        <label class="field"><span>Tentative start</span><input type="date" value="${b.tentativeStart || ''}" data-field="tentativeStart"></label>
        <label class="field"><span>Target ship</span><input type="date" value="${b.targetShip || ''}" data-field="targetShip"></label>
        <label class="field"><span>Priority</span><input type="number" value="${b.priority ?? 100}" data-field="priority"></label>
        <label class="field"><span>Projected build hours</span><input type="number" min="0" step="0.5" value="${b.projectedHours ?? ''}" data-field="projectedHours" placeholder="e.g. 320"></label>
      </div>
      ${bayConflictWarning(b)}

      <div class="section-head"><h3>Production Stages</h3><div class="section-head-actions"><button class="btn sm" id="completeAllStages" type="button">Complete all</button><span class="td-sub" id="stageTotalNote">${dur} planned working days total</span></div></div>
      <div class="stage-list-head"><span></span><span style="text-align:left">Stage</span><span>Days</span><span>Hrs</span><span>Progress</span><span></span></div>
      <div class="stage-list">${stageRows}</div>

      <div class="hours-summary">
        <div class="hs-cell"><span class="hs-label">Projected hours</span><span class="hs-val">${projectedHours || '—'}</span></div>
        <div class="hs-cell"><span class="hs-label">Actual hours (logged)</span><span class="hs-val">${actualHours || 0}</span></div>
        <div class="hs-cell hs-var ${varTone}"><span class="hs-label">Variance</span><span class="hs-val">${projectedHours ? `${hoursVariance > 0 ? '+' : ''}${hoursVariance}` : '—'}</span></div>
      </div>
      <div class="hs-note ${varTone}" style="${projectedHours && actualHours ? '' : 'display:none'}">${
        hoursVariance > 0 ? `Over budget by ${hoursVariance} hours` :
        hoursVariance < 0 ? `Under budget by ${Math.abs(hoursVariance)} hours` :
        'Exactly on the projected hours'}</div>

      <label class="field"><span>Notes</span><textarea data-field="notes" rows="2">${esc(b.notes || '')}</textarea></label>
      </div>

      <div class="modal-panel" ${tab === 'crew' ? '' : 'hidden'}>
      <p class="panel-sub" style="margin:2px 0 14px">Drag a crew member into a stage to assign them, or between stages to reassign. Drag back to the pool (or click the ✕) to unassign. The Labor view compares assigned hours against scheduled work.</p>
      ${(state.settings.people || []).length ? (() => {
        const peopleById = Object.fromEntries((state.settings.people || []).map((p) => [p.id, p]));
        const assignedAnywhere = new Set(Object.values(b.stageCrew || {}).flat().filter(Boolean));
        const pool = (state.settings.people || []).filter((p) => !assignedAnywhere.has(p.id));
        const chip = (p, sid) => `<span class="crew-chip assigned" draggable="true" data-crew-person="${p.id}" data-crew-from="${sid || ''}" title="${esc(p.role || '')} — drag to reassign">${esc(p.name)}<button type="button" class="crew-chip-x" data-crew-remove="${p.id}" data-crew-stage="${sid}" title="Unassign">✕</button></span>`;
        return `
        <div class="crew-pool" data-crew-drop="__pool__">
          <div class="crew-lane-label">Available crew — by role</div>
          ${pool.length ? (() => {
            // Group unassigned people by role so each role is its own column.
            const byRole = {};
            for (const p of pool) { const r = (p.role || '').trim() || 'Unassigned role'; (byRole[r] ||= []).push(p); }
            const roles = Object.keys(byRole).sort((a, b) => a.localeCompare(b));
            return `<div class="crew-pool-cols">${roles.map((r) => `
              <div class="crew-role-col">
                <div class="crew-role-head">${esc(r)} <span class="crew-role-n">${byRole[r].length}</span></div>
                <div class="crew-role-chips">${byRole[r].map((p) => `<span class="crew-chip pool" draggable="true" data-crew-person="${p.id}" data-crew-from="" title="${esc(p.role || '')} — drag to a stage">${esc(p.name)}</span>`).join('')}</div>
              </div>`).join('')}</div>`;
          })() : '<span class="crew-lane-empty">Everyone is assigned.</span>'}
        </div>
        <div class="crew-lanes">
          ${state.stages.map((s) => {
            const assigned = (b.stageCrew?.[s.id] || []).map((id) => peopleById[id]).filter(Boolean);
            return `<div class="crew-lane" data-crew-drop="${s.id}">
              <div class="crew-lane-label">${esc(s.label)}</div>
              <div class="crew-lane-chips">${assigned.length ? assigned.map((p) => chip(p, s.id)).join('') : '<span class="crew-lane-empty">Drop crew here</span>'}</div>
            </div>`;
          }).join('')}
        </div>`;
      })() : `<div class="forecast-detail-note">No crew added yet. Add people in <strong>Settings → Crew</strong>, then assign them to stages here.</div>`}
      </div>

      <div class="modal-panel" ${tab === 'inspections' ? '' : 'hidden'}>
      <p class="panel-sub" style="margin:2px 0 12px">Record the inspecting company and contact once for this build, then mark each inspection's result, attach completion photos, and note any issues found.</p>
      ${(() => {
        const ib = b.inspectionInfo || {};
        return `<div class="insp-build-info">
          <div class="insb-title">Inspection contact — this build</div>
          <div class="insp-fields">
            <label class="field"><span>Inspecting company</span><input value="${esc(ib.company || '')}" data-insp-build="company" placeholder="e.g. State Modular Inspections"></label>
            <label class="field"><span>Inspector name</span><input value="${esc(ib.inspector || '')}" data-insp-build="inspector" placeholder="Inspector"></label>
            <label class="field"><span>Contact (phone / email)</span><input value="${esc(ib.contact || '')}" data-insp-build="contact" placeholder="Phone or email"></label>
            <label class="field"><span>Inspection date</span><input type="date" value="${ib.date || ''}" data-insp-build="date"></label>
          </div>
        </div>`;
      })()}
      ${inspections.length ? `<div class="insp-list">
        ${inspections.map((ins) => {
          const d = (b.inspectionData && b.inspectionData[ins.id]) || {};
          // Back-compat: fall back to the old status-only field if present.
          const st = d.status || (b.inspectionStatus && b.inspectionStatus[ins.id]) || '';
          const photos = d.photos || [];
          const resultClass = st === 'passed' ? 'passed' : st === 'failed' ? 'failed' : '';
          return `<div class="insp-card ${resultClass}" data-insp-card="${ins.id}">
            <div class="insp-card-head">
              <span class="insp-name">${esc(ins.label)}</span>
              <div class="insp-opts">
                ${[['passed', 'Passed'], ['failed', 'Failed']].map(([val, lbl]) =>
                  `<button type="button" class="insp-opt ${st === val ? 'on ' + val : ''}" data-insp="${ins.id}" data-insp-val="${val}">${lbl}</button>`).join('')}
                ${st ? `<button type="button" class="insp-opt insp-clear" data-insp="${ins.id}" data-insp-val="">Clear</button>` : ''}
              </div>
            </div>
            <div class="insp-photos-wrap">
              <div class="insp-sub-label">Completion photos</div>
              <div class="insp-drop" data-insp-photo-drop="${ins.id}">
                <span class="attach-drop-text">Drop photos here, or <button type="button" class="attach-browse" data-insp-photo-browse="${ins.id}">browse</button></span>
                <input type="file" accept="image/*" multiple class="attach-input" data-insp-photo-file="${ins.id}" hidden>
              </div>
              ${photos.length ? `<div class="insp-photo-grid">${photos.map((ph, i) =>
                `<div class="insp-photo"><img ${ph.data ? `src="${ph.data}"` : (ph.path ? `data-signed-path="${esc(ph.path)}"` : `src="${esc(ph.url || '')}"`)} alt="${esc(ph.name || 'photo')}"><button type="button" class="insp-photo-x" data-insp-photo-remove="${ins.id}" data-insp-photo-idx="${i}" title="Remove">✕</button></div>`).join('')}</div>` : ''}
            </div>
            <label class="field"><span>Notes / issues found</span><textarea rows="2" data-insp-field="notes" data-insp-id="${ins.id}" placeholder="Note any issues found during inspection…">${esc(d.notes || '')}</textarea></label>
          </div>`;
        }).join('')}
      </div>` : `<div class="forecast-detail-note">No inspection points defined. Add them in <strong>Settings → Inspection Points</strong>.</div>`}
      </div>

      <div class="modal-panel" ${tab === 'files' ? '' : 'hidden'}>
      <p class="panel-sub" style="margin:2px 0 14px">Attach local files (stored in Traveler) or paste Google Drive links for each category.</p>
      <div class="attach-groups">
        ${attachField(b, 'buildDocuments', 'Build Documents')}
        ${attachField(b, 'workbook', 'Workbook')}
        ${attachField(b, 'billOfMaterials', 'Bill of Materials')}
      </div>
      </div>
    </div>
    <div class="modal-foot">${draft
      ? `<span class="draft-note">Unsaved — this build won't be added until you save.</span><button class="btn" data-cancel-draft>Cancel</button><button class="btn primary" data-save-build>Save build</button>`
      : `<button class="btn danger" data-delete-build>Delete build</button><button class="btn" data-close-build>Close</button>`}</div>`;
  // Now that the markup is on the page, resolve signed URLs for any
  // private-bucket images it produced.
  hydrateSigned($('#buildModal'));
}

// ----------------------------- Mutations -----------------------------
async function patchBuild(id, patch) {
  // Belt-and-braces: never attempt a write this session isn't allowed to make.
  // UI locking is cosmetic and can be bypassed — by a control type that ignores
  // readOnly, a handler bound to a container, or devtools. Guarding here means a
  // viewer's edit is dropped before it reaches storage, so they never see a value
  // appear to change and then snap back.
  if (!CAN_WRITE) return;

  // Edits to an unsaved draft update the in-memory draft only — no storage write,
  // no history event — until the user explicitly saves.
  if (state.draftBuild && state.draftBuild.id === id) {
    Object.assign(state.draftBuild, patch);
    renderBuildModalPreservingFocus();
    return;
  }
  // Merge against the freshest stored record (not the possibly-stale render cache)
  // so rapid successive edits to different fields don't clobber one another.
  const current = (await repo.getBuild(id)) || state.builds.find((x) => x.id === id);
  if (!current) return;
  await repo.saveBuild({ ...current, ...patch }, actor());
}

// ----------------------------- Events -----------------------------
// ----------------------------- Drag-to-reorder -----------------------------
// Generic reorder for any container of [data-reorder-id] rows. On drop, computes
// the new id order and persists it — stages rewrite their `order` field; settings
// lists are reordered in place.
let reorderDragId = null;
let crewDrag = null; // { personId, from } while dragging a crew chip between stages

async function persistReorder(kind, orderedIds) {
  if (kind === 'stages') {
    const byId = Object.fromEntries(state.stages.map((s) => [s.id, s]));
    let i = 1;
    for (const id of orderedIds) { const s = byId[id]; if (s) { await repo.saveStage({ ...s, order: i++ }); } }
  } else if (kind.startsWith('opt:')) {
    const key = kind.slice(4);
    const items = state.settings[key] || [];
    const simple = isSimpleList(key);
    const byId = Object.fromEntries(items.map((it) => [simple ? it : it.id, it]));
    const next = orderedIds.map((id) => byId[id]).filter(Boolean);
    await repo.saveSettings({ ...state.settings, [key]: next });
  }
}

function wireReorder(rootSel) {
  const root = $(rootSel);
  if (!root) return;
  root.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-reorder-id]');
    if (row) { reorderDragId = row.dataset.reorderId; row.classList.add('reorder-dragging'); e.dataTransfer.effectAllowed = 'move'; }
  });
  root.addEventListener('dragend', (e) => { const row = e.target.closest('[data-reorder-id]'); if (row) row.classList.remove('reorder-dragging'); $$('.reorder-over').forEach((el) => el.classList.remove('reorder-over')); });
  root.addEventListener('dragover', (e) => {
    const row = e.target.closest('[data-reorder-id]');
    const container = e.target.closest('[data-reorder]');
    if (row && container && reorderDragId) { e.preventDefault(); $$('.reorder-over').forEach((el) => el.classList.remove('reorder-over')); row.classList.add('reorder-over'); }
  });
  root.addEventListener('drop', async (e) => {
    const row = e.target.closest('[data-reorder-id]');
    const container = e.target.closest('[data-reorder]');
    if (!row || !container || !reorderDragId) return;
    e.preventDefault();
    const kind = container.dataset.reorder;
    const ids = $$('[data-reorder-id]', container).map((el) => el.dataset.reorderId);
    const from = ids.indexOf(reorderDragId);
    const to = ids.indexOf(row.dataset.reorderId);
    if (from === -1 || to === -1 || from === to) { reorderDragId = null; return; }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorderDragId = null;
    await persistReorder(kind, ids);
  });
}

function wireGlobalEvents() {
  // The Print button is a convenience only — it opens the browser's own dialog.
  // beforeprint does the preparation, so Ctrl+P and the File menu behave identically.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-print]')) window.print();
  });
  window.addEventListener('beforeprint', preparePrint);
  window.addEventListener('afterprint', cleanupPrint);
  let textSaveTimer = null;
  $$('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));
  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#lineFilter').addEventListener('change', (e) => { state.lineFilter = e.target.value; render(); });

  // Global open-build delegation.
  document.body.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open && !e.target.closest('input,select,button,textarea,[data-card]')) return openBuild(open.dataset.open);
    if (open && e.target.closest('.b-card') && !e.target.closest('button')) { /* card click handled on mouseup vs drag below */ }
  });

  // Board: open on click, drag to change status.
  let dragId = null;
  $('#boardRoot').addEventListener('dragstart', (e) => { const c = e.target.closest('[data-card]'); if (c) dragId = c.dataset.card; });
  $('#boardRoot').addEventListener('dragover', (e) => { if (e.target.closest('.b-zone')) e.preventDefault(); });
  $('#boardRoot').addEventListener('drop', async (e) => {
    const zone = e.target.closest('.b-zone'); if (!zone || !dragId) return;
    e.preventDefault(); await patchBuild(dragId, { status: zone.dataset.status }); dragId = null;
  });
  $('#boardRoot').addEventListener('click', (e) => { const c = e.target.closest('[data-card]'); if (c) openBuild(c.dataset.card); });

  // Dashboard bays: drag a build chip between bays to update its bay assignment.
  // The bay field is the single source of truth, so this reflects everywhere at once.
  let bayDragId = null;
  $('#dashboardRoot').addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-bay-build]');
    if (chip) { bayDragId = chip.dataset.bayBuild; e.dataTransfer.effectAllowed = 'move'; chip.classList.add('dragging'); }
  });
  $('#dashboardRoot').addEventListener('dragend', (e) => {
    const chip = e.target.closest('[data-bay-build]'); if (chip) chip.classList.remove('dragging');
    $$('.lc-bay.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
  });
  $('#dashboardRoot').addEventListener('dragover', (e) => {
    const slot = e.target.closest('[data-bay-drop]');
    if (slot && bayDragId) { e.preventDefault(); slot.classList.add('drop-hover'); }
  });
  $('#dashboardRoot').addEventListener('dragleave', (e) => {
    const slot = e.target.closest('[data-bay-drop]'); if (slot) slot.classList.remove('drop-hover');
  });
  $('#dashboardRoot').addEventListener('drop', async (e) => {
    const slot = e.target.closest('[data-bay-drop]');
    if (!slot || !bayDragId) return;
    e.preventDefault();
    const build = state.builds.find((b) => b.id === bayDragId);
    const targetLine = slot.dataset.bayLine;
    const targetBay = Number(slot.dataset.bayDrop);
    // Moving across lines reassigns the build's line too, so the bay stays valid.
    const patch = { bay: targetBay };
    if (build && build.lineId !== targetLine) patch.lineId = targetLine;
    await patchBuild(bayDragId, patch);
    bayDragId = null;
  });

  // Dashboard / pipeline row open (and bay chips open their build on click).
  ['#dashboardRoot', '#pipelineRoot'].forEach((sel) => $(sel)?.addEventListener('click', (e) => {
    if (e.target.closest('.scenario-controls') || e.target.closest('#scenarioResult')) return; // scenario tool handles its own clicks
    const chip = e.target.closest('[data-bay-build]'); if (chip) { openBuild(chip.dataset.bayBuild); return; }
    const row = e.target.closest('[data-open]'); if (row && !e.target.closest('button')) openBuild(row.dataset.open);
  }));

  // What-if scenario: preview a build's forecast under a hypothetical start date.
  $('#dashboardRoot').addEventListener('click', (e) => {
    if (!e.target.closest('#scenarioRun')) return;
    const buildId = $('#scenarioBuild')?.value;
    const date = $('#scenarioDate')?.value;
    state.scenario = { buildId, date };
    runScenario(buildId, date);
  });

  // Pipeline: confirm suggested start.
  $('#pipelineRoot').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-confirm-suggest]'); if (!btn) return;
    const b = state.builds.find((x) => x.id === btn.dataset.confirmSuggest);
    const line = state.lines.find((l) => l.id === b.lineId);
    const sug = suggestStart(b, line, state.builds, state.stages, calendar(), state.today);
    if (sug.start) await patchBuild(b.id, { confirmedStart: sug.start, status: 'active' });
  });

  // Build modal delegation.
  $('#buildOverlay').addEventListener('click', (e) => { if (e.target.id === 'buildOverlay' || e.target.closest('[data-close-build]')) closeBuild(); });
  $('#bayPickerOverlay').addEventListener('click', (e) => { if (e.target.id === 'bayPickerOverlay') closeBayPicker(); });
  // Escape closes the open build modal — a standard expectation for daily use.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openBuildId) closeBuild();
  });
  $('#buildModal').addEventListener('change', async (e) => {
    const id = state.openBuildId;
    // Attachment file picked via browse.
    const fileInput = e.target.closest('[data-attach-file]');
    if (fileInput && fileInput.files?.length) {
      const key = fileInput.dataset.attachFile;
      for (const file of fileInput.files) {
        const att = await fileToAttachment(file);
        if (att) await addAttachment(id, key, att);
      }
      renderBuildModalPreservingFocus();
      return;
    }
    // Inspection photos picked via browse.
    const inspPhotoInput = e.target.closest('[data-insp-photo-file]');
    if (inspPhotoInput && inspPhotoInput.files?.length) {
      const iid = inspPhotoInput.dataset.inspPhotoFile;
      const cur = currentBuild(); const data = { ...(cur.inspectionData || {}) };
      const entry = { ...(data[iid] || {}) }; const photos = [...(entry.photos || [])];
      for (const file of inspPhotoInput.files) {
        const att = await fileToAttachment(file);
        if (att) photos.push({ name: att.name, data: att.data, url: att.url, path: att.path });
      }
      entry.photos = photos; data[iid] = entry;
      await patchBuild(id, { inspectionData: data });
      renderBuildModalPreservingFocus();
      return;
    }
    // Build-level inspection contact (company / inspector / contact / date).
    const inspBuild = e.target.dataset.inspBuild;
    if (inspBuild) {
      const cur = currentBuild();
      await patchBuild(id, { inspectionInfo: { ...(cur.inspectionInfo || {}), [inspBuild]: e.target.value } });
      return;
    }
    // Inspection notes (per inspection point).
    const inspField = e.target.dataset.inspField;
    if (inspField) {
      const iid = e.target.dataset.inspId;
      const cur = currentBuild(); const data = { ...(cur.inspectionData || {}) };
      data[iid] = { ...(data[iid] || {}), [inspField]: e.target.value };
      await patchBuild(id, { inspectionData: data });
      return;
    }
    const field = e.target.dataset.field;
    if (field) {
      let v = e.target.value;
      if (field === 'priority') v = Number(v) || 0;
      if (field === 'projectedHours') { await patchBuild(id, { projectedHours: Number(v) || 0, hoursUpdatedAt: new Date().toISOString() }); updateHoursSummary(); return; }
      if (['startDate', 'confirmedStart', 'tentativeStart', 'targetShip', 'actualStart', 'actualShip'].includes(field)) v = v || null;
      // The consolidated "Start date" writes to both the planning anchor
      // (confirmedStart, used by the forecast engine) and the actual-start
      // record (used by cycle-time/accuracy reports) so downstream logic is intact.
      if (field === 'startDate') {
        await patchBuild(id, { confirmedStart: v, actualStart: v });
        return;
      }
      // Setting a tentative start date defaults the target ship to 12 calendar
      // weeks (84 days) later. If a target is already set, ask before overwriting.
      if (field === 'tentativeStart' && v) {
        const b = currentBuild();
        const suggested = addDaysLocal(v, 84);
        const patch = { tentativeStart: v };
        if (!b.targetShip) {
          patch.targetShip = suggested;
        } else if (b.targetShip !== suggested) {
          if (confirm(`Set target ship to 12 weeks after the tentative start (${fmtDate(suggested)})? This replaces the current target of ${fmtDate(b.targetShip)}.`)) {
            patch.targetShip = suggested;
          }
        }
        await patchBuild(id, patch);
        renderBuildModal(); // reflect the new target in the field + forecast
        return;
      }
      // When a build is marked complete, default the actual ship date to today
      // (if not already set) — a sensible starting point the user can adjust.
      if (field === 'status' && v === 'complete') {
        const b = currentBuild();
        const patch = { status: 'complete' };
        if (!b.actualShip) patch.actualShip = state.today;
        if (!b.actualStart && effectiveStart(b)) patch.actualStart = effectiveStart(b);
        await patchBuild(id, patch);
        renderBuildModal(); // status change reveals the actual-date fields
        return;
      }
      // Changing status to/from active, or changing the line (which changes the
      // available bays), re-renders so bay options and warnings stay correct.
      const wasStatus = field === 'status';
      const wasLine = field === 'lineId';
      if (field === 'bay') v = v || null;
      await patchBuild(id, { [field]: v });
      if (wasStatus || wasLine) renderBuildModal();
      return;
    }
    const stageRow = e.target.closest('[data-stage]');
    if (stageRow) {
      const b = currentBuild(); const sid = stageRow.dataset.stage;
      if (e.target.matches('[data-stage-days]')) await patchBuild(id, { stageDurations: { ...b.stageDurations, [sid]: Number(e.target.value) || 0 } });
      if (e.target.matches('[data-stage-hours]')) {
        // Rebuild the full stageHours map from the DOM so rapid successive edits
        // aren't lost to async state-refresh timing.
        const stageHours = {};
        $$('#buildModal .stage-row').forEach((row) => {
          const rid = row.dataset.stage; const inp = row.querySelector('.st-hours');
          if (inp) stageHours[rid] = Number(inp.value) || 0;
        });
        suppressModalRerenderUntil = Date.now() + 400; // keep the DOM authoritative briefly
        await patchBuild(id, { stageHours, hoursUpdatedAt: new Date().toISOString() });
        updateHoursSummary();
        return;
      }
      if (e.target.matches('[data-stage-prog]')) await patchBuild(id, { stageProgress: { ...b.stageProgress, [sid]: Number(e.target.value) / 100 } });
      return;
    }
  });
  // Crew chip drag start — remember who's being dragged and from which stage.
  $('#buildModal').addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-crew-person]');
    if (chip) { crewDrag = { personId: chip.dataset.crewPerson, from: chip.dataset.crewFrom || '' }; chip.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
  });
  $('#buildModal').addEventListener('dragend', (e) => {
    const chip = e.target.closest('[data-crew-person]'); if (chip) chip.classList.remove('dragging');
    $$('#buildModal .crew-lane.drop-hover, #buildModal .crew-pool.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
  });
  // Drag-and-drop files onto an attachment drop zone.
  $('#buildModal').addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-attach-drop]');
    if (zone) { e.preventDefault(); zone.classList.add('drag-over'); }
    const inspZone = e.target.closest('[data-insp-photo-drop]');
    if (inspZone) { e.preventDefault(); inspZone.classList.add('drag-over'); }
    const lane = e.target.closest('[data-crew-drop]');
    if (lane && crewDrag) { e.preventDefault(); $$('#buildModal .drop-hover').forEach((el) => el.classList.remove('drop-hover')); lane.classList.add('drop-hover'); }
  });
  $('#buildModal').addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-attach-drop]'); if (zone) zone.classList.remove('drag-over');
    const inspZone = e.target.closest('[data-insp-photo-drop]'); if (inspZone) inspZone.classList.remove('drag-over');
  });
  $('#buildModal').addEventListener('drop', async (e) => {
    // Crew reassignment via drag.
    const lane = e.target.closest('[data-crew-drop]');
    if (lane && crewDrag) {
      e.preventDefault(); lane.classList.remove('drop-hover');
      const target = lane.dataset.crewDrop; // stage id, or '__pool__'
      const { personId, from } = crewDrag; crewDrag = null;
      if (target === from) { renderBuildModalPreservingFocus(); return; }
      const cur = currentBuild(); const stageCrew = { ...(cur.stageCrew || {}) };
      // Remove from the origin stage (if any).
      if (from) stageCrew[from] = (stageCrew[from] || []).filter((x) => x !== personId);
      // Add to the target stage (unless dropped back into the pool).
      if (target !== '__pool__') {
        const list = new Set(stageCrew[target] || []); list.add(personId); stageCrew[target] = [...list];
      }
      await patchBuild(state.openBuildId, { stageCrew });
      renderBuildModalPreservingFocus();
      return;
    }
    // Inspection photos dropped onto an inspection's photo zone.
    const inspZone = e.target.closest('[data-insp-photo-drop]');
    if (inspZone) {
      e.preventDefault(); inspZone.classList.remove('drag-over');
      const iid = inspZone.dataset.inspPhotoDrop; const id = state.openBuildId;
      const cur = currentBuild(); const data = { ...(cur.inspectionData || {}) };
      const entry = { ...(data[iid] || {}) }; const photos = [...(entry.photos || [])];
      for (const file of [...(e.dataTransfer?.files || [])]) {
        if (!file.type.startsWith('image/')) continue;
        const att = await fileToAttachment(file);
        if (att) photos.push({ name: att.name, data: att.data, url: att.url, path: att.path });
      }
      entry.photos = photos; data[iid] = entry;
      await patchBuild(id, { inspectionData: data });
      renderBuildModalPreservingFocus();
      return;
    }
    const zone = e.target.closest('[data-attach-drop]');
    if (!zone) return;
    e.preventDefault(); zone.classList.remove('drag-over');
    const key = zone.dataset.attachDrop; const id = state.openBuildId;
    const files = [...(e.dataTransfer?.files || [])];
    for (const file of files) { const att = await fileToAttachment(file); if (att) await addAttachment(id, key, att); }
    renderBuildModalPreservingFocus();
  });

  $('#buildModal').addEventListener('input', (e) => { // live % label without full re-render churn
    if (e.target.matches('[data-stage-prog]')) { const row = e.target.closest('.stage-row'); row.querySelector('.st-prog').textContent = e.target.value + '%'; }
    // Hours summary recalculates live from the inputs as you type.
    if (e.target.matches('[data-stage-hours]') || e.target.matches('input[data-field="projectedHours"]')) updateHoursSummary();
    // Debounced save for free-text fields so content persists as you type,
    // not only when you click away (guards against lost edits on close/refresh).
    if (e.target.matches('input[data-field], textarea[data-field]') && e.target.type !== 'date') {
      const field = e.target.dataset.field;
      const val = field === 'priority' ? (Number(e.target.value) || 0) : e.target.value;
      clearTimeout(textSaveTimer);
      textSaveTimer = setTimeout(() => patchBuild(state.openBuildId, { [field]: val }), 350);
    }
  });
  $('#buildModal').addEventListener('click', async (e) => {
    const id = state.openBuildId; const b = currentBuild();
    // Switch between Details and Files tabs.
    const tabBtn = e.target.closest('[data-modal-tab]');
    if (tabBtn) { state.modalTab = tabBtn.dataset.modalTab; renderBuildModal(); return; }
    // --- Crew: remove a person from a stage via the ✕ button ---
    const crewRemove = e.target.closest('[data-crew-remove]');
    if (crewRemove) {
      const pid = crewRemove.dataset.crewRemove; const sid = crewRemove.dataset.crewStage;
      const cur = currentBuild(); const stageCrew = { ...(cur.stageCrew || {}) };
      stageCrew[sid] = (stageCrew[sid] || []).filter((x) => x !== pid);
      await patchBuild(id, { stageCrew });
      renderBuildModalPreservingFocus();
      return;
    }
    // --- Inspection result (Passed / Failed / Clear) ---
    const inspBtn = e.target.closest('[data-insp]');
    if (inspBtn) {
      const iid = inspBtn.dataset.insp; const val = inspBtn.dataset.inspVal;
      const cur = currentBuild();
      const data = { ...(cur.inspectionData || {}) };
      data[iid] = { ...(data[iid] || {}), status: val };
      await patchBuild(id, { inspectionData: data });
      renderBuildModalPreservingFocus();
      return;
    }
    // --- Inspection photo: browse ---
    const inspPhotoBrowse = e.target.closest('[data-insp-photo-browse]');
    if (inspPhotoBrowse) { $(`input[data-insp-photo-file="${inspPhotoBrowse.dataset.inspPhotoBrowse}"]`, $('#buildModal'))?.click(); return; }
    // --- Inspection photo: remove ---
    const inspPhotoRm = e.target.closest('[data-insp-photo-remove]');
    if (inspPhotoRm) {
      const iid = inspPhotoRm.dataset.inspPhotoRemove; const idx = Number(inspPhotoRm.dataset.inspPhotoIdx);
      const cur = currentBuild(); const data = { ...(cur.inspectionData || {}) };
      const entry = { ...(data[iid] || {}) }; entry.photos = (entry.photos || []).filter((_, i) => i !== idx); data[iid] = entry;
      await patchBuild(id, { inspectionData: data });
      renderBuildModalPreservingFocus();
      return;
    }
    // --- Attachments ---
    const browse = e.target.closest('[data-attach-browse]');
    if (browse) { $(`input[data-attach-file="${browse.dataset.attachBrowse}"]`, $('#buildModal'))?.click(); return; }
    const addLink = e.target.closest('[data-attach-addlink]');
    if (addLink) {
      const key = addLink.dataset.attachAddlink;
      const inp = $(`input[data-attach-linkurl="${key}"]`, $('#buildModal'));
      const url = inp?.value.trim();
      if (!url) return;
      const name = driveLinkName(url);
      await addAttachment(id, key, { kind: 'link', name, url });
      renderBuildModalPreservingFocus();
      return;
    }
    const rm = e.target.closest('[data-attach-remove]');
    if (rm) {
      const key = rm.dataset.attachRemove; const idx = Number(rm.dataset.attachIdx);
      const cur = currentBuild(); const arr = [...(cur.attachments?.[key] || [])];
      arr.splice(idx, 1);
      await patchBuild(id, { attachments: { ...(cur.attachments || {}), [key]: arr } });
      renderBuildModalPreservingFocus();
      return;
    }
    const open = e.target.closest('[data-attach-open]');
    if (open) {
      const key = open.dataset.attachOpen; const idx = Number(open.dataset.attachIdx);
      const cur = currentBuild(); const it = cur.attachments?.[key]?.[idx];
      if (!it) return;
      // Private bucket: mint a signed URL now rather than storing one, so links
      // can't be copied out of the record and used later or by someone else.
      const href = await attachmentHref(it);
      if (!href) { alert(`"${it.name || 'That file'}" could not be opened. It may have been removed from storage.`); return; }
      const a = document.createElement('a');
      a.href = href; a.download = it.name || 'file';
      if (!it.data) { a.target = '_blank'; a.rel = 'noopener'; }
      a.click();
      return;
    }
    // --- end attachments ---
    // Save an unsaved draft: require at least a name so the reports feed stays clean.
    if (e.target.closest('[data-save-build]')) {
      if (!b.name || !b.name.trim()) {
        alert('Please give the build a name before saving.');
        const nameInput = $('input[data-field="name"]', $('#buildModal')); if (nameInput) nameInput.focus();
        return;
      }
      const toSave = { ...state.draftBuild };
      state.draftBuild = null;
      await repo.saveBuild(toSave, actor()); // first real write → single "created" event
      state.openBuildId = toSave.id;
      renderBuildModal(); // re-render as a normal saved build (Delete/Close footer)
      return;
    }
    if (e.target.closest('[data-cancel-draft]')) { closeBuild(); return; }
    if (e.target.closest('[data-delete-build]')) { if (confirm('Delete this build permanently?')) { await repo.deleteBuild(id, actor()); closeBuild(); } return; }
    if (e.target.id === 'completeAllStages') {
      // Mark every production stage 100% complete in one click.
      const stageProgress = Object.fromEntries(state.stages.map((s) => [s.id, 1]));
      await patchBuild(id, { stageProgress });
      renderBuildModal();
      return;
    }
  });

  // New build.
  $('#newBuildBtn').addEventListener('click', () => {
    const id = 'mod-' + Date.now().toString(36);
    const defaultDurations = Object.fromEntries(state.stages.map((s) => [s.id, s.defaultDays || 2]));
    // Hold the new build as an in-memory DRAFT — it isn't written to storage (and
    // so doesn't appear in history/reports) until the user clicks "Save build".
    state.draftBuild = { id, name: '', client: '', moduleType: '', lineId: state.lines[0]?.id, status: 'pipeline', confirmedStart: null, tentativeStart: null, targetShip: null, actualStart: null, actualShip: null, stageDurations: defaultDurations, stageProgress: {}, stageHours: {}, projectedHours: 0, stageCrew: {}, inspectionStatus: {}, inspectionData: {}, inspectionInfo: {}, attachments: {}, bay: null, priority: 100, notes: '' };
    state.openBuildId = id;
    state.modalTab = 'details';
    renderBuildModal();
    $('#buildOverlay').classList.add('open');
  });

  // Settings delegation.
  wireReorder('#settingsRoot');
  $('#settingsRoot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const addOpt = e.target.closest('[data-add-opt]');
    const addLine = e.target.closest('[data-add-line]');
    const addStage = e.target.closest('[data-add-stage]');
    if (addOpt) {
      const key = addOpt.dataset.addOpt; const val = addOpt.querySelector('input').value.trim(); if (!val) return;
      const cur = state.settings[key] || []; const simple = isSimpleList(key);
      if (simple) { if (!cur.includes(val)) await repo.saveSettings({ ...state.settings, [key]: [...cur, val] }); }
      else { const idv = val.toLowerCase().replace(/[^a-z0-9]+/g, '-'); await repo.saveSettings({ ...state.settings, [key]: [...cur, { id: idv, label: val, color: pickColor(cur.length) }] }); }
    }
    if (addLine) { const inputs = addLine.querySelectorAll('input'); const name = inputs[0].value.trim(); if (!name) return; await repo.saveLine({ id: 'line-' + Date.now().toString(36), name, capacity: Number(inputs[1].value) || 1, workdaysPerWeek: Number(inputs[2].value) || 5 }); }
    if (addStage) { const name = addStage.querySelector('input').value.trim(); if (!name) return; const order = Math.max(0, ...state.stages.map((s) => s.order)) + 1; await repo.saveStage({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: name, order, defaultDays: 2 }); }
    const addCrew = e.target.closest('[data-add-crew]');
    if (addCrew) {
      const name = addCrew.querySelector('.ac-name').value.trim(); if (!name) return;
      const role = addCrew.querySelector('.ac-role').value.trim();
      const weeklyHours = Number(addCrew.querySelector('.ac-hours').value) || 40;
      const people = state.settings.people || [];
      await repo.saveSettings({ ...state.settings, people: [...people, { id: 'p-' + Date.now().toString(36), name, role, weeklyHours }] });
    }
  });
  $('#settingsRoot').addEventListener('click', async (e) => {
    const delOpt = e.target.closest('[data-del-opt]'); const delLine = e.target.closest('[data-del-line]'); const delStage = e.target.closest('[data-del-stage]');
    if (delOpt) { const key = delOpt.dataset.delOpt; const val = delOpt.dataset.delVal; const simple = isSimpleList(key); const next = (state.settings[key] || []).filter((it) => (simple ? it : it.id) !== val); await repo.saveSettings({ ...state.settings, [key]: next }); }
    if (delLine) { if ((state.lines.length <= 1)) return alert('Keep at least one line.'); await repo.deleteLine(delLine.dataset.delLine); }
    if (delStage) { if (state.stages.length <= 1) return alert('Keep at least one stage.'); await repo.deleteStage(delStage.dataset.delStage); }
    const delCrew = e.target.closest('[data-del-crew]');
    if (delCrew) {
      const id = delCrew.dataset.delCrew;
      const people = (state.settings.people || []).filter((p) => p.id !== id);
      await repo.saveSettings({ ...state.settings, people });
      // Also unassign this person from any build stages so we don't keep stale ids.
      for (const b of state.builds) {
        if (!b.stageCrew) continue;
        let changed = false; const next = {};
        for (const [sid, ids] of Object.entries(b.stageCrew)) {
          const filtered = (ids || []).filter((pid) => pid !== id);
          if (filtered.length !== (ids || []).length) changed = true;
          next[sid] = filtered;
        }
        if (changed) await patchBuild(b.id, { stageCrew: next });
      }
    }
    if (e.target.id === 'exportGo') {
      // Each export recomputes what it needs, since the data used to come from
      // whichever tab hosted the button.
      const pick = document.getElementById('exportPick')?.value;
      if (pick === 'backup') exportBackup();
      else if (pick === 'hours-matrix') exportBuildHoursMatrix(state.builds);
      else if (pick === 'hours') exportHoursCSV();
      else if (pick === 'report') {
        exportReportCSV(buildReport(state.builds, state.lines, state.stages, calendar(), state.today));
      } else if (pick === 'history') {
        repo.historyEvents().then(exportHistoryCSV);
      }
    }
    if (e.target.id === 'importBtn') $('#importFile').click();
  });
  $('#settingsRoot').addEventListener('change', async (e) => {
    // Filter the crew list by role.
    if (e.target.matches('[data-crew-filter]')) { state.crewRoleFilter = e.target.value; renderSettings(); return; }
    // Edit a crew member's name / role / weekly hours.
    const crewField = e.target.dataset.crewField;
    if (crewField) {
      const id = e.target.dataset.crewId;
      const people = (state.settings.people || []).map((p) => {
        if (p.id !== id) return p;
        let v = e.target.value;
        if (crewField === 'weeklyHours') v = Math.max(0, Number(v) || 0);
        else if (crewField === 'name' && !String(v).trim()) return p;
        return { ...p, [crewField]: v };
      });
      await repo.saveSettings({ ...state.settings, people });
      return;
    }
    // Rename a production stage (keep its id so logged hours stay linked to it).
    const renameStage = e.target.dataset.renameStage;
    if (renameStage) {
      const s = state.stages.find((x) => x.id === renameStage);
      const v = e.target.value.trim();
      if (s && v) await repo.saveStage({ ...s, label: v });
      return;
    }
    // Rename a settings option (module type / status).
    const renameOpt = e.target.dataset.renameOpt;
    if (renameOpt) {
      const key = renameOpt; const id = e.target.dataset.renameId; const v = e.target.value.trim();
      if (!v) return;
      const simple = isSimpleList(key);
      const cur = state.settings[key] || [];
      if (simple) {
        const next = cur.map((it) => (it === id ? v : it));
        await repo.saveSettings({ ...state.settings, [key]: next });
        // Keep dependent records pointing at the new name.
        if (key === 'moduleTypes') {
          for (const b of state.builds) if (b.moduleType === id) await patchBuild(b.id, { moduleType: v });
        } else if (key === 'roles') {
          const people = (state.settings.people || []).map((p) => (p.role === id ? { ...p, role: v } : p));
          await repo.saveSettings({ ...state.settings, [key]: next, people });
        }
      } else {
        const next = cur.map((it) => (it.id === id ? { ...it, label: v } : it));
        await repo.saveSettings({ ...state.settings, [key]: next });
      }
      return;
    }
    // Inline edit of an existing production line (name / capacity / workdays per week).
    const lineField = e.target.dataset.lineField;
    if (lineField) {
      const line = state.lines.find((l) => l.id === e.target.dataset.lineId);
      if (line) {
        let v = e.target.value;
        if (lineField === 'capacity' || lineField === 'workdaysPerWeek') v = Math.max(1, Number(v) || 1);
        if (lineField === 'name' && !String(v).trim()) return;
        await repo.saveLine({ ...line, [lineField]: v });
      }
      return;
    }
    if (e.target.id === 'importFile' && e.target.files[0]) {
      const text = await e.target.files[0].text();
      try { await repo.importAll(JSON.parse(text)); alert('Backup imported.'); } catch { alert('Could not read that backup file.'); }
    }
  });
}

function pickColor(i) { return ['#4F7CB5', '#8B6BC2', '#D9728F', '#3FAE9E', '#4FAE54', '#D9A33E', '#C44F3A'][i % 7]; }
async function exportBackup() {
  const dump = await repo.exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `traveler-backup-${state.today}.json`; a.click(); URL.revokeObjectURL(a.href);
}

boot().catch((err) => {
  // boot() was previously called bare, so any failure here vanished into an
  // unhandled rejection and left a blank page with nothing in the UI.
  console.error('Traveler: startup failed', err);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:#F5F1E8;color:#1F2A33;font-family:system-ui,sans-serif;z-index:9998;text-align:center';
  el.innerHTML = '<div style="max-width:460px"><h2 style="margin:0 0 10px;font-size:19px">Traveler couldn\'t finish loading</h2>'
    + '<p style="margin:0;line-height:1.5;font-size:13.5px">' + String((err && err.message) || err).replace(/</g, '&lt;')
    + '</p></div>';
  document.body.appendChild(el);
});
