/* ═══════════════════════════════════════════════════════════
   app.js — FRC Caster's Tool UI Controller
   ═══════════════════════════════════════════════════════════ */

// ── Tooltip positioning (fixed to viewport) ───────────────
document.addEventListener('mouseover', e => {
    // Find the closest .has-tooltip that directly contains the event target
    const badge = e.target.closest('.has-tooltip');
    if (!badge) return;

    // Only act on the innermost .has-tooltip (skip if target is inside a nested one)
    const tip = badge.querySelector(':scope > .custom-tooltip');
    if (!tip) return;

    // Don't reposition if mouse just moved within the same badge
    if (badge._tipActive) return;
    badge._tipActive = true;
    badge.addEventListener('mouseleave', function handler() {
        badge._tipActive = false;
        tip.style.display = '';
        badge.removeEventListener('mouseleave', handler);
    });

    // Force display to measure, but off-screen
    tip.style.display = 'block';
    tip.style.left = '-9999px';
    tip.style.top = '0';
    tip.classList.remove('above', 'below');

    const tipRect = tip.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();

    const spaceAbove = badgeRect.top;
    const gap = 8;
    let top, cls;

    if (spaceAbove >= tipRect.height + gap) {
        top = badgeRect.top - tipRect.height - gap;
        cls = 'above';
    } else {
        top = badgeRect.bottom + gap;
        cls = 'below';
    }

    let left = badgeRect.left + badgeRect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add(cls);
});

let currentEvent = null;   // event_key once loaded
let playoffData  = null;   // cached playoff matches
let allianceData = null;   // cached alliance data
let summaryData  = null;   // cached event summary
let pbpData      = null;   // cached play-by-play data
let pbpIndex     = 0;      // current match index
let highlightForeign = false; // settings: highlight non-Turkish teams
let bdData       = null;   // cached breakdown match list (same as pbpData)
let bdIndex      = 0;      // current breakdown match index
let bdCache      = {};     // match_key -> breakdown data

// Season events
let seasonEventsRaw = [];          // full list from backend
let seasonEventsFiltered = [];     // after applying region/week/search
let seasonDropdownIdx = -1;        // keyboard-highlighted index in dropdown

// Auto-refresh polling
let rankingsRefreshTimer = null;   // setInterval id for rankings polling
let currentEventStatus = null;     // 'ongoing' | 'completed' | 'upcoming' | null

// Track which tabs have been rendered from preloaded data
let renderedTabs = { playoff: false, alliance: false, playbyplay: false, breakdown: false };

// ── Settings ───────────────────────────────────────────────
function toggleSettings() {
    document.getElementById('settings-menu').classList.toggle('hidden');
}
// Close settings when clicking outside
document.addEventListener('click', e => {
    const wrapper = e.target.closest('.settings-wrapper');
    if (!wrapper) document.getElementById('settings-menu')?.classList.add('hidden');
});

// ── Theme Toggle ───────────────────────────────────────────
function toggleTheme(isLight) {
    document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

// Restore saved theme on load
(function initTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        // Sync checkbox once DOM is ready
        document.addEventListener('DOMContentLoaded', () => {
            const cb = document.getElementById('toggle-theme');
            if (cb) cb.checked = true;
        });
    }
})();

function toggleHighlightForeign(on) {
    highlightForeign = on;
    applyForeignHighlight();
    // Re-render PBP if it's loaded so team cards update
    if (pbpData) renderPbpMatch();
}

function applyForeignHighlight() {
    document.querySelectorAll('[data-country]').forEach(el => {
        const c = el.dataset.country;
        const isTurkish = !c || c === 'Turkey' || c === 'Türkiye' || c === 'Turkiye';
        if (highlightForeign && !isTurkish) {
            el.classList.add('foreign-team');
        } else {
            el.classList.remove('foreign-team');
        }
    });
}

// ── Tab switching ──────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

        // Auto-load data when switching to dependent tabs
        // Summary is heavy (awards + history) — stays lazy-loaded
        if (btn.dataset.tab === 'summary' && currentEvent && !summaryData) loadSummary();

        // Lightweight tabs: render from preloaded cache, or fetch if missing
        if (btn.dataset.tab === 'playoff' && currentEvent && !renderedTabs.playoff) {
            if (playoffData) {
                hide('playoff-empty');
                currentBracket = 'all';
                renderBracketNav();
                renderPlayoffs();
                renderedTabs.playoff = true;
            } else {
                loadPlayoffs();
            }
        }
        if (btn.dataset.tab === 'alliance' && currentEvent && !renderedTabs.alliance) {
            if (allianceData) {
                hide('alliance-empty');
                hide('alliance-loading');
                renderAlliances(allianceData);
                renderedTabs.alliance = true;
            } else {
                loadAlliances();
            }
        }
        if (btn.dataset.tab === 'playbyplay' && currentEvent && !renderedTabs.playbyplay) {
            if (pbpData) {
                pbpIndex = 0;
                hide('pbp-empty');
                show('pbp-container');
                buildPbpSelector();
                renderPbpMatch();
                renderedTabs.playbyplay = true;
            } else {
                loadPlayByPlay();
            }
        }
        if (btn.dataset.tab === 'breakdown' && currentEvent && !renderedTabs.breakdown) {
            if (bdData) {
                bdIndex = 0;
                bdCache = {};
                hide('bd-empty');
                show('bd-container');
                buildBdSelector();
                loadBdMatch();
                renderedTabs.breakdown = true;
            } else {
                loadBreakdownTab();
            }
        }
    });
});

// Allow enter key in inputs
document.getElementById('event-year')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadEvent(); });
document.getElementById('event-code')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadEvent(); });

// ── Restore last event on page load ───────────────────────
(function restoreEvent() {
    const saved = localStorage.getItem('selectedEvent');
    if (!saved) return;
    try {
        const { year, eventCode } = JSON.parse(saved);
        if (!year || !eventCode) return;
        const apply = () => {
            const yEl = document.getElementById('event-year');
            const cEl = document.getElementById('event-code');
            if (yEl) yEl.value = year;
            if (cEl) cEl.value = eventCode;
            loadEvent();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply);
        } else {
            apply();
        }
    } catch (_) { /* ignore corrupt data */ }
})();
document.getElementById('team-number')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadTeam(); });
document.getElementById('h2h-team-b')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadH2H(); });

// ── Arrow key navigation for Play by Play & Score Breakdown ──
document.addEventListener('keydown', e => {
    // Skip if user is typing in an input/select/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const pbpActive = $('tab-playbyplay')?.classList.contains('active');
        const bdActive  = $('tab-breakdown')?.classList.contains('active');
        if (pbpActive && pbpData) {
            e.preventDefault();
            e.key === 'ArrowLeft' ? pbpPrev() : pbpNext();
        } else if (bdActive && bdData) {
            e.preventDefault();
            e.key === 'ArrowLeft' ? bdPrev() : bdNext();
        }
    }
});


// ── Helpers ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = (id) => $(id)?.classList.remove('hidden');
const hide = (id) => $(id)?.classList.add('hidden');
const loading = (on) => on ? show('loading-overlay') : hide('loading-overlay');


// ═══════════════════════════════════════════════════════════
// 1. EVENT SELECTION
// ═══════════════════════════════════════════════════════════

// ── Season events loader ──────────────────────────────────
async function loadSeasonEvents() {
    const status = $('season-status');
    status.textContent = 'Loading 2026 events…';
    try {
        // Load from bundled static JSON (instant, no API call)
        const resp = await fetch('/data/season_2026.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        seasonEventsRaw = await resp.json();
        populateSeasonFilters();
        filterSeasonEvents();
        status.textContent = '';
        const badge = $('season-count-badge');
        if (badge) badge.textContent = `${seasonEventsRaw.length} events`;
    } catch (err) {
        // Fallback: fetch live from API if static file missing
        try {
            seasonEventsRaw = await API.seasonEvents(2026);
            populateSeasonFilters();
            filterSeasonEvents();
            status.textContent = '';
            const badge = $('season-count-badge');
            if (badge) badge.textContent = `${seasonEventsRaw.length} events`;
        } catch (err2) {
            status.textContent = `Failed to load events: ${err2.message}`;
        }
    }
}

async function refreshSeasonEventsFromAPI() {
    const status = $('season-status');
    const btn = $('season-refresh-btn');
    btn.classList.add('spinning');
    status.textContent = 'Refreshing from TBA…';
    try {
        seasonEventsRaw = await API.seasonEvents(2026);
        populateSeasonFilters();
        filterSeasonEvents();
        status.textContent = 'Updated from TBA ✓';
        setTimeout(() => { if (status.textContent === 'Updated from TBA ✓') status.textContent = ''; }, 3000);
        const badge = $('season-count-badge');
        if (badge) badge.textContent = `${seasonEventsRaw.length} events`;
    } catch (err) {
        status.textContent = `Refresh failed: ${err.message}`;
    } finally {
        btn.classList.remove('spinning');
    }
}

function populateSeasonFilters() {
    // Region filter
    const regions = [...new Set(seasonEventsRaw.map(e => e.region))].sort();
    const regionSel = $('season-filter-region');
    regionSel.innerHTML = '<option value="">All Regions</option>'
        + regions.map(r => `<option value="${r}">${r}</option>`).join('');

    // Week filter
    const weeks = [...new Set(seasonEventsRaw.map(e => e.week).filter(w => w !== null && w !== undefined))].sort((a, b) => a - b);
    const weekSel = $('season-filter-week');
    weekSel.innerHTML = '<option value="">All Weeks</option>'
        + weeks.map(w => `<option value="${w}">Week ${w + 1}</option>`).join('');
}

function filterSeasonEvents() {
    const region = $('season-filter-region').value;
    const week = $('season-filter-week').value;
    const search = ($('season-search').value || '').toLowerCase().trim();

    seasonEventsFiltered = seasonEventsRaw.filter(e => {
        if (region && e.region !== region) return false;
        if (week !== '' && String(e.week) !== week) return false;
        if (search && !e.name.toLowerCase().includes(search) && !e.key.toLowerCase().includes(search)) return false;
        return true;
    });

    // Only show dropdown when the search input is focused
    if (document.activeElement === $('season-search')) {
        renderSeasonDropdown();
    }

    $('season-status').textContent = `${seasonEventsFiltered.length} of ${seasonEventsRaw.length} events`;
}

function renderSeasonDropdown() {
    const list = $('season-dropdown-list');
    const dropdown = $('season-dropdown');
    seasonDropdownIdx = -1;

    if (seasonEventsFiltered.length === 0) {
        list.innerHTML = '<div class="season-dropdown-item" style="color:var(--text-muted);justify-content:center">No events match your filters</div>';
        dropdown.classList.remove('hidden');
        return;
    }

    list.innerHTML = seasonEventsFiltered.map((e, i) => {
        const weekLabel = e.week !== null && e.week !== undefined ? `Wk ${e.week + 1}` : 'CMP';
        const loc = [e.city, e.country].filter(Boolean).join(', ');
        return `<div class="season-dropdown-item" data-idx="${i}" onclick="selectSeasonEvent(${i})">
            <span class="sdi-name">${e.name}</span>
            <span class="sdi-week">${weekLabel}</span>
            <span class="sdi-loc">${loc}</span>
        </div>`;
    }).join('');

    dropdown.classList.remove('hidden');
}

function selectSeasonEvent(idx) {
    const ev = seasonEventsFiltered[idx];
    if (!ev) return;
    $('season-dropdown').classList.add('hidden');
    $('season-search').value = ev.name;
    // Fill manual fields too for consistency
    const year = ev.key.substring(0, 4);
    const code = ev.key.substring(4);
    $('event-year').value = year;
    $('event-code').value = code;
    loadEvent();
}

// Keyboard navigation in season dropdown
$('season-search')?.addEventListener('keydown', e => {
    const dropdown = $('season-dropdown');
    if (dropdown.classList.contains('hidden')) return;
    const items = dropdown.querySelectorAll('.season-dropdown-item[data-idx]');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        seasonDropdownIdx = Math.min(seasonDropdownIdx + 1, items.length - 1);
        highlightDropdownItem(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        seasonDropdownIdx = Math.max(seasonDropdownIdx - 1, 0);
        highlightDropdownItem(items);
    } else if (e.key === 'Enter' && seasonDropdownIdx >= 0) {
        e.preventDefault();
        selectSeasonEvent(seasonDropdownIdx);
    } else if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
    }
});

function highlightDropdownItem(items) {
    items.forEach(el => el.classList.remove('highlighted'));
    if (items[seasonDropdownIdx]) {
        items[seasonDropdownIdx].classList.add('highlighted');
        items[seasonDropdownIdx].scrollIntoView({ block: 'nearest' });
    }
}

// Show dropdown on focus, hide on outside click
$('season-search')?.addEventListener('focus', () => {
    if (seasonEventsFiltered.length) {
        renderSeasonDropdown();
    }
});
document.addEventListener('click', e => {
    if (!e.target.closest('.season-search-wrap')) {
        $('season-dropdown')?.classList.add('hidden');
    }
});

// Load season events on page init
loadSeasonEvents();

function toggleManualEntry() {
    const body = $('manual-entry-body');
    const icon = $('manual-toggle-icon');
    body.classList.toggle('collapsed');
    icon.textContent = body.classList.contains('collapsed') ? '▼' : '▲';
}

function clearActiveEvent() {
    currentEvent = null;
    currentEventStatus = null;
    localStorage.removeItem('selectedEvent');
    stopRankingsPolling();
    hide('active-event-banner');
    const badge = $('event-badge');
    badge.classList.remove('status-ongoing', 'status-upcoming', 'status-completed');
    hide('event-badge');
    $('season-search').value = '';
    $('event-year').value = '';
    $('event-code').value = '';
    // Reset Rankings tab
    show('rankings-empty');
    hide('rankings-container');
    $('event-teams').innerHTML = '';
}

// ── Auto-refresh rankings polling ─────────────────────────
const RANKINGS_POLL_INTERVAL = 60_000; // 60 seconds

function startRankingsPolling() {
    stopRankingsPolling();
    if (currentEventStatus !== 'ongoing') return;
    rankingsRefreshTimer = setInterval(refreshRankings, RANKINGS_POLL_INTERVAL);
}

function stopRankingsPolling() {
    if (rankingsRefreshTimer) {
        clearInterval(rankingsRefreshTimer);
        rankingsRefreshTimer = null;
    }
}

async function refreshRankings() {
    if (!currentEvent) { stopRankingsPolling(); return; }
    try {
        const teams = await API.refreshRankings(currentEvent);
        $('event-teams').innerHTML = buildTeamTable(teams);
    } catch (_) {
        // Silently ignore — network hiccups shouldn't disrupt the UI
    }
}

// ── Manual event load ─────────────────────────────────────
async function loadEvent() {
    const year = $('event-year').value.trim();
    const eventCode = $('event-code').value.trim().toLowerCase();
    if (!year || !eventCode) return;
    const code = `${year}${eventCode}`;

    loading(true);
    playoffData = null;
    allianceData = null;
    summaryData = null;
    pbpData = null;
    pbpIndex = 0;
    bdData = null;
    bdIndex = 0;
    bdCache = {};
    renderedTabs = { playoff: false, alliance: false, playbyplay: false, breakdown: false };

    try {
        const [info, teams] = await Promise.all([
            API.eventInfo(code),
            API.eventTeams(code),
        ]);

        currentEvent = code;
        localStorage.setItem('selectedEvent', JSON.stringify({ year, eventCode }));

        // Sync season search box if this is a 2026 event
        const matchedSeason = seasonEventsRaw.find(e => e.key === code);
        if (matchedSeason) {
            $('season-search').value = matchedSeason.name;
        }

        // Badge
        const badge = $('event-badge');
        badge.textContent = `${info.name} (${info.year})`;
        badge.classList.remove('status-ongoing', 'status-upcoming', 'status-completed');
        if (info.status) badge.classList.add(`status-${info.status}`);
        currentEventStatus = info.status || null;
        show('event-badge');

        // Start auto-refresh for ongoing events
        startRankingsPolling();

        // Active event banner
        const statusBadge = info.status
            ? `<span class="aeb-status-badge status-${info.status}">${info.status.toUpperCase()}</span>`
            : '';
        $('aeb-name').textContent = info.name;
        $('aeb-meta').innerHTML = `<span>${info.event_type_string} — ${info.city}, ${info.state_prov} · ${info.start_date} → ${info.end_date} · ${teams.length} teams</span>${statusBadge}`;

        // Match dot color to event status
        const dot = document.querySelector('.aeb-dot');
        if (dot) {
            dot.classList.remove('dot-ongoing', 'dot-upcoming', 'dot-completed');
            if (info.status) dot.classList.add(`dot-${info.status}`);
        }
        show('active-event-banner');

        // Rankings & Teams tab — default sort by team number for upcoming events
        if (currentEventStatus === 'upcoming') {
            teamsSortCol = 'team_number';
            teamsSortAsc = true;
        } else {
            teamsSortCol = 'rank';
            teamsSortAsc = true;
        }
        hide('rankings-empty');
        show('rankings-container');
        $('event-teams').innerHTML = buildTeamTable(teams);

        // Reset dependent tabs
        $('summary-empty')?.classList.remove('hidden');
        $('summary-container')?.classList.add('hidden');
        $('playoff-empty')?.classList.remove('hidden');
        $('playoff-nav').innerHTML = '';
        $('playoff-matches').innerHTML = '';
        $('playoff-bracket-nav').innerHTML = '';
        $('alliance-empty')?.classList.remove('hidden');
        $('alliance-grid').innerHTML = '';
        $('bd-empty')?.classList.remove('hidden');
        $('bd-container')?.classList.add('hidden');
        $('bd-content') && ($('bd-content').innerHTML = '');
        $('bd-status') && ($('bd-status').innerHTML = '');
        $('pbp-empty')?.classList.remove('hidden');
        $('pbp-container')?.classList.add('hidden');

        // ── Preload lightweight data in parallel ───────────
        const [matchData, playoffResult, allianceResult] = await Promise.all([
            API.allMatches(code).catch(() => null),
            API.playoffMatches(code).catch(() => null),
            API.alliances(code).catch(() => null),
        ]);

        // Stash matches (shared by PBP + Breakdown)
        if (matchData) {
            pbpData = matchData;
            bdData  = matchData;
        }

        // Stash playoffs
        if (playoffResult && playoffResult.matches) {
            playoffData = playoffResult.matches;
        }

        // Stash alliances
        if (allianceResult) {
            allianceData = allianceResult;
        }

    } catch (err) {
        alert(`Error loading event: ${err.message}`);
    } finally {
        loading(false);
    }
}

let teamsData = null;      // cached teams list for sorting
let teamsSortCol = 'rank';  // current sort column
let teamsSortAsc = true;    // sort direction

function buildTeamTable(teams) {
    teamsData = teams;
    // Apply the current sort so upcoming events (sorted by team_number) render correctly
    sortTeamsData();
    return renderTeamTable(teamsData, teamsSortCol, teamsSortAsc);
}

function sortTeamsData() {
    if (!teamsData) return;
    const col = teamsSortCol;
    const asc = teamsSortAsc;
    teamsData.sort((a, b) => {
        let va, vb;
        switch (col) {
            case 'rank':
                va = typeof a.rank === 'number' ? a.rank : 999;
                vb = typeof b.rank === 'number' ? b.rank : 999;
                return asc ? va - vb : vb - va;
            case 'team_number':
                return asc ? a.team_number - b.team_number : b.team_number - a.team_number;
            case 'nickname':
                va = (a.nickname || '').toLowerCase();
                vb = (b.nickname || '').toLowerCase();
                return asc ? va.localeCompare(vb) : vb.localeCompare(va);
            case 'location':
                va = [a.city, a.state_prov, a.country].filter(Boolean).join(', ').toLowerCase();
                vb = [b.city, b.state_prov, b.country].filter(Boolean).join(', ').toLowerCase();
                return asc ? va.localeCompare(vb) : vb.localeCompare(va);
            case 'record':
                va = a.wins - a.losses;
                vb = b.wins - b.losses;
                if (va !== vb) return asc ? vb - va : va - vb;
                return asc ? b.wins - a.wins : a.wins - b.wins;
            case 'opr':
                return asc ? b.opr - a.opr : a.opr - b.opr;
            case 'dpr':
                return asc ? a.dpr - b.dpr : b.dpr - a.dpr;
            case 'ccwm':
                return asc ? b.ccwm - a.ccwm : a.ccwm - b.ccwm;
            default:
                return 0;
        }
    });
}

function renderTeamTable(teams, sortCol, asc) {
    const arrow = asc ? ' ▲' : ' ▼';
    const th = (key, label) =>
        `<th class="sortable-th${sortCol === key ? ' sorted' : ''}" onclick="sortTeams('${key}')">${label}${sortCol === key ? arrow : ''}</th>`;

    return `
    <table class="data-table">
        <thead>
            <tr>
                ${th('rank', 'Rank')}
                <th></th>
                ${th('team_number', 'Team')}
                ${th('nickname', 'Name')}
                ${th('location', 'Location')}
                ${th('record', 'Record')}
                ${th('opr', 'OPR')}
                ${th('dpr', 'DPR')}
                ${th('ccwm', 'CCWM')}
            </tr>
        </thead>
        <tbody>
            ${teams.map(t => {
                const loc = [t.city, t.state_prov, t.country].filter(Boolean).join(', ');
                const name = formatTeamName(t.nickname);
                const avatarImg = t.avatar
                    ? `<img src="${t.avatar}" class="team-avatar" alt="" loading="lazy">`
                    : `<span class="team-avatar team-avatar-placeholder">${t.team_number}</span>`;
                return `
            <tr>
                <td class="rank">${t.rank}</td>
                <td class="team-avatar-cell">${avatarImg}</td>
                <td class="team-num">${t.team_number}</td>
                <td>${name}</td>
                <td class="location">${loc}</td>
                <td class="stat">${t.wins}-${t.losses}-${t.ties}</td>
                <td class="stat stat-opr">${t.opr}</td>
                <td class="stat stat-dpr">${t.dpr}</td>
                <td class="stat">${t.ccwm}</td>
            </tr>`;
            }).join('')}
        </tbody>
    </table>`;
}

function formatTeamName(name) {
    if (!name) return '';
    // Title-case: capitalize first letter of each word, lowercase the rest
    return name.replace(/\S+/g, w => {
        // Keep acronyms (all-caps 2+ letters) as-is
        if (w.length >= 2 && w === w.toUpperCase() && /^[A-Z]+$/.test(w)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
}

function sortTeams(col) {
    if (!teamsData) return;
    if (teamsSortCol === col) {
        teamsSortAsc = !teamsSortAsc;
    } else {
        teamsSortCol = col;
        teamsSortAsc = true;
    }

    sortTeamsData();
    $('event-teams').innerHTML = renderTeamTable(teamsData, teamsSortCol, teamsSortAsc);
}


// ═══════════════════════════════════════════════════════════
// 1b. EVENT SUMMARY
// ═══════════════════════════════════════════════════════════

async function loadSummary() {
    if (!currentEvent) return;
    hide('summary-empty');
    show('summary-loading');
    hide('summary-container');

    try {
        const data = await API.eventSummary(currentEvent);
        summaryData = data;
        renderSummary(data);
    } catch (err) {
        alert(`Error loading summary: ${err.message}`);
        show('summary-empty');
    } finally {
        hide('summary-loading');
    }
}

async function refreshSummaryStats() {
    if (!currentEvent) return;
    const btn = document.querySelector('.summary-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }

    try {
        const data = await API.eventSummaryRefresh(currentEvent);
        if (data.top_scorers && summaryData) {
            summaryData.top_scorers = data.top_scorers;
            renderTopScorers(data.top_scorers);
        }
    } catch (err) {
        alert(`Error refreshing stats: ${err.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Stats'; }
    }
}

function renderSummary(data) {
    $('summary-title').textContent = `Event Summary — ${currentEvent.toUpperCase()}`;
    show('summary-container');

    // Demographics
    const d = data.demographics;
    $('summary-demographics').innerHTML = `
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.total_teams}</div>
            <div class="summary-stat-label">Total Teams</div>
        </div>
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.rookie_pct}%</div>
            <div class="summary-stat-label">Rookie Teams <span class="summary-stat-sub">(${d.rookie_count})</span></div>
        </div>
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.veteran_pct}%</div>
            <div class="summary-stat-label">Veteran Teams <span class="summary-stat-sub">(${d.veteran_count}, 5+ yrs)</span></div>
        </div>
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.foreign_pct}%</div>
            <div class="summary-stat-label">Foreign Teams <span class="summary-stat-sub">(${d.foreign_count})</span></div>
        </div>
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.country_count}</div>
            <div class="summary-stat-label">Countries</div>
            <div class="summary-stat-sub">${d.countries.join(', ')}</div>
        </div>`;

    // Hall of Fame
    const hofEl = $('summary-hof');
    if (data.hall_of_fame.length > 0) {
        $('summary-hof-list').innerHTML = data.hall_of_fame.map(t => `
            <div class="summary-hof-team">
                <span class="summary-hof-num">${t.team_number}</span>
                <span class="summary-hof-name">${t.nickname}</span>
                <span class="summary-hof-loc">${[t.city, t.state_prov, t.country].filter(Boolean).join(', ')}</span>
            </div>`).join('');
        hofEl.classList.remove('hidden');
    } else {
        hofEl.classList.add('hidden');
    }

    // Impact Award Finalists
    const impactEl = $('summary-impact');
    if (data.impact_finalists && data.impact_finalists.length > 0) {
        $('summary-impact-list').innerHTML = data.impact_finalists.map(t => `
            <div class="summary-hof-team">
                <span class="summary-hof-num" style="color:var(--primary)">${t.team_number}</span>
                <span class="summary-hof-name">${t.nickname}</span>
                <span class="summary-hof-loc">${t.impact_years.join(', ')}</span>
            </div>`).join('');
        impactEl.classList.remove('hidden');
    } else {
        impactEl.classList.add('hidden');
    }

    // Prior connections
    const histEl = $('summary-history');
    if (data.connections.length > 0) {
        renderConnections(data.connections, 'all');
        // Reset filter to "All"
        document.querySelectorAll('.conn-filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.conn-filter-btn[data-conn-filter="all"]')?.classList.add('active');
        histEl.classList.remove('hidden');
    } else {
        histEl.classList.add('hidden');
    }

    // Top scorers
    renderTopScorers(data.top_scorers);
}

let currentConnFilter = 'all';

function toggleConnections() {
    const body = $('summary-history-body');
    const icon = $('conn-toggle-icon');
    body.classList.toggle('collapsed');
    icon.textContent = body.classList.contains('collapsed') ? '▼' : '▲';
}

function filterConnections(filter, btn) {
    currentConnFilter = filter;
    document.querySelectorAll('.conn-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (summaryData) renderConnections(summaryData.connections, filter);
}

function renderConnections(connections, filter) {
    const filtered = connections.filter(c => {
        if (filter === 'partners') return c.partnered_at.length > 0;
        if (filter === 'opponents') return c.opponents_at.length > 0;
        return true;
    });

    if (filtered.length === 0) {
        $('summary-history-list').innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">No connections match this filter.</p>';
        return;
    }

    $('summary-history-list').innerHTML = filtered.map(c => {
        const badges = [];
        if (c.partnered_at.length) {
            c.partnered_at.forEach(p => {
                const stage = p.stage ? ` ${p.stage}` : '';
                badges.push(`<span class="conn-badge conn-partner">${p.year}${stage} — Partners</span>`);
            });
        }
        if (c.opponents_at.length) {
            c.opponents_at.forEach(o => {
                badges.push(`<span class="conn-badge conn-opponent">${o.year} ${o.stage} — Opponents</span>`);
            });
        }
        return `
        <div class="summary-conn-row">
            <span class="conn-team has-tooltip">${c.team_a}<span class="custom-tooltip">${c.team_a_name}</span></span>
            <span class="conn-vs">—</span>
            <span class="conn-team has-tooltip">${c.team_b}<span class="custom-tooltip">${c.team_b_name}</span></span>
            <div class="conn-badges">${badges.join('')}</div>
        </div>`;
    }).join('');
}

function renderTopScorers(scorers) {
    const el = $('summary-top-scorers');
    if (scorers.length > 0) {
        const medals = ['1st', '2nd', '3rd'];
        $('summary-top-list').innerHTML = scorers.map((s, i) => `
            <div class="summary-top-row">
                <span class="top-medal">${medals[i] || ''}</span>
                <span class="top-team-num">${s.team_number}</span>
                <span class="top-team-name">${s.nickname}</span>
                <span class="top-opr">OPR ${s.opr}</span>
                <span class="top-rank">${s.rank !== '-' ? `Rank #${s.rank}` : ''}</span>
            </div>`).join('');
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}


// ═══════════════════════════════════════════════════════════
// 2. PLAYOFFS
// ═══════════════════════════════════════════════════════════
let currentBracket = 'all'; // 'all', 'upper', 'lower', 'final'

async function loadPlayoffs() {
    if (!currentEvent) return;
    loading(true);
    try {
        const data = await API.playoffMatches(currentEvent);
        playoffData = data.matches;
        hide('playoff-empty');
        currentBracket = 'all';
        renderBracketNav();
        renderPlayoffs();
    } catch (err) {
        alert(`Error loading playoffs: ${err.message}`);
    } finally {
        loading(false);
    }
}

function renderBracketNav() {
    $('playoff-bracket-nav').innerHTML = `
        <button class="bracket-btn active" onclick="setBracket('all', this)">All Matches</button>
        <button class="bracket-btn" onclick="setBracket('upper', this)">▲ Upper Bracket</button>
        <button class="bracket-btn" onclick="setBracket('lower', this)">▼ Lower Bracket</button>
        <button class="bracket-btn" onclick="setBracket('final', this)">★ Grand Final</button>
    `;
}

function setBracket(bracket, btn) {
    currentBracket = bracket;
    document.querySelectorAll('.bracket-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderPlayoffs();
}

function renderPlayoffs() {
    if (!playoffData || !playoffData.length) {
        $('playoff-matches').innerHTML = '<p class="empty">No playoff matches found.</p>';
        return;
    }

    // Filter by bracket
    let filtered = playoffData;
    if (currentBracket !== 'all') {
        filtered = playoffData.filter(m => m.bracket === currentBracket);
    }

    // Build unique rounds in order
    const roundOrder = [1, 2, 3, 4, 5, 0]; // 0 = Grand Final
    const roundsPresent = roundOrder.filter(r => filtered.some(m => m.round === r));
    const roundLabels = {1: 'Round 1', 2: 'Round 2', 3: 'Round 3', 4: 'Round 4', 5: 'Round 5', 0: 'Grand Final'};

    $('playoff-nav').innerHTML = roundsPresent.map((r, i) =>
        `<button class="round-btn ${i === 0 ? 'active' : ''}" data-round="${r}"
                 onclick="filterRound(${r}, this)">${roundLabels[r]}</button>`
    ).join('');

    if (roundsPresent.length) filterRound(roundsPresent[0]);
    else $('playoff-matches').innerHTML = '<p class="empty">No matches in this bracket.</p>';
}

function filterRound(round, btn) {
    if (btn) {
        document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    } else {
        document.querySelector(`.round-btn[data-round="${round}"]`)?.classList.add('active');
    }

    const matches = playoffData.filter(m => {
        if (m.round !== round) return false;
        if (currentBracket !== 'all' && m.bracket !== currentBracket) return false;
        return true;
    });

    // Sort by set_number then match_number
    matches.sort((a, b) => a.set_number - b.set_number || a.match_number - b.match_number);

    // Render each match as its own card — no series grouping
    $('playoff-matches').innerHTML = matches.map(m => {
        const redNums = m.red?.alliance_number ? `Alliance #${m.red.alliance_number}` : '';
        const blueNums = m.blue?.alliance_number ? `Alliance #${m.blue.alliance_number}` : '';
        const bracketTag = m.bracket === 'upper' ? '▲ Upper'
                         : m.bracket === 'lower' ? '▼ Lower'
                         : m.bracket === 'final' ? '★ Final' : '';

        return `
        <div class="series-card">
            <div class="series-header">
                <span class="series-title">Match ${m.set_number}${m.match_number > 1 ? ` (Replay ${m.match_number})` : ''}
                    <span class="bracket-tag ${m.bracket}">${bracketTag}</span>
                    <span class="muted" style="margin-left:.6rem">${redNums} vs ${blueNums}</span>
                </span>
            </div>
            ${renderMatchCard(m)}
        </div>`;
    }).join('') || '<p class="empty">No matches in this bracket.</p>';
}

function renderMatchCard(m) {
    const upcoming = m.red.score < 0 && m.blue.score < 0;
    return `
    <div class="match-card ${upcoming ? 'upcoming' : ''}">
        <div class="match-alliances">
            ${renderAlliance('red', m)}
            ${renderAlliance('blue', m)}
        </div>
    </div>`;
}

function renderAlliance(color, m) {
    const a = m[color];
    const won = m.winning_alliance === color;
    const badgeCls = color === 'red' ? 'red-badge' : 'blue-badge';
    return `
    <div class="alliance ${color} ${won ? 'winner' : ''}">
        <div class="alliance-teams">
            ${a.team_numbers.map((tn, i) => {
                const name = (a.team_names && a.team_names[i]) || '';
                const country = (a.team_countries && a.team_countries[i]) || '';
                const foreignCls = highlightForeign && country && country !== 'Turkey' && country !== 'Türkiye' && country !== 'Turkiye' ? 'foreign-team' : '';
                return name
                    ? `<span class="team-badge ${badgeCls} ${foreignCls} has-tooltip" data-country="${country}">${tn}<span class="custom-tooltip">${name}</span></span>`
                    : `<span class="team-badge ${badgeCls} ${foreignCls}" data-country="${country}">${tn}</span>`;
            }).join('')}
        </div>
        <span class="alliance-opr">Σ OPR: ${a.total_opr}</span>
        <span class="alliance-score ${won ? 'winner-text' : ''}">${a.score >= 0 ? a.score : '–'}</span>
    </div>`;
}


// ═══════════════════════════════════════════════════════════
// 3. ALLIANCE SELECTION
// ═══════════════════════════════════════════════════════════
async function loadAlliances() {
    if (!currentEvent) return;
    hide('alliance-empty');
    show('alliance-loading');
    try {
        const data = await API.alliances(currentEvent);
        allianceData = data;
        hide('alliance-loading');
        renderAlliances(data);
    } catch (err) {
        hide('alliance-loading');
        alert(`Error loading alliances: ${err.message}`);
    }
}

function renderAlliances(data) {
    const { alliances, partnerships } = data;
    if (!alliances.length) {
        $('alliance-grid').innerHTML = '<p class="empty">Alliance selection has not occurred yet.</p>';
        return;
    }

    $('alliance-grid').innerHTML = alliances.map(a => {
        const totalOpr = a.teams.reduce((s, t) => s + t.opr, 0).toFixed(2);
        const roleLabels = ['Captain', '1st Pick', '2nd Pick', '3rd Pick', 'Backup'];

        return `
        <div class="alliance-card">
            <div class="alliance-header">
                <h3>${a.name || 'Alliance ' + a.number}</h3>
                <span class="combined-opr">Σ OPR ${totalOpr}</span>
            </div>
            <div class="alliance-teams-list">
                ${a.teams.map((t, idx) => {
                    // Figure out partnership badges for this team
                    const badges = [];
                    a.teams.forEach((other, oidx) => {
                        if (oidx === idx) return;
                        const pairKey = [t.team_key, other.team_key].sort().join('+');
                        const altKey = [other.team_key, t.team_key].sort().join('+');
                        const p = partnerships[pairKey] || partnerships[altKey]
                                 || partnerships[`${t.team_key}+${other.team_key}`]
                                 || partnerships[`${other.team_key}+${t.team_key}`];
                        if (p) {
                            if (p.first_time) {
                                badges.push(`<span class="badge first-time">1st w/ ${other.team_number}</span>`);
                            } else {
                                const tooltipRows = p.history.map(h =>
                                    `<div class="tip-row">${h.year} &mdash; ${h.event_name.replace(/</g, '&lt;')}</div>`
                                ).join('');
                                badges.push(`<span class="badge returning has-tooltip">⟳ w/ ${other.team_number} (${p.history.length}×)<span class="custom-tooltip">${tooltipRows}</span></span>`);
                            }
                        }
                    });

                    return `
                    <div class="alliance-team-row">
                        <span class="team-role">${roleLabels[idx] || ''}</span>
                        <span class="team-num ${highlightForeign && t.country && t.country !== 'Turkey' && t.country !== 'Türkiye' && t.country !== 'Turkiye' ? 'foreign-team' : ''} has-tooltip" data-country="${t.country || ''}">${t.team_number}${t.nickname ? `<span class="custom-tooltip">${t.nickname}</span>` : ''}</span>
                        <div class="team-stats-mini">
                            <span>Rank ${t.rank}</span>
                            <span>${t.wins}-${t.losses}-${t.ties}</span>
                            <span class="stat-opr">OPR ${t.opr}</span>
                            <span class="stat-dpr">DPR ${t.dpr}</span>
                        </div>
                        <div class="partner-badges">${badges.join('')}</div>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');
}


// ═══════════════════════════════════════════════════════════
// 4. TEAM LOOKUP
// ═══════════════════════════════════════════════════════════
async function loadTeam() {
    const num = parseInt($('team-number').value, 10);
    const year = $('team-year').value.trim() || null;
    if (!num) return;

    loading(true);
    try {
        const data = await API.teamStats(num, year);
        $('team-stats').innerHTML = renderTeamStats(data);
    } catch (err) {
        alert(`Error loading team: ${err.message}`);
    } finally {
        loading(false);
    }
}

function renderTeamStats(d) {
    return `
    <div class="team-card">
        <div class="team-header">
            <h2>${d.team_number} — ${d.nickname}</h2>
            <p>${[d.city, d.state_prov, d.country].filter(Boolean).join(', ')}</p>
            <p class="muted">Rookie: ${d.rookie_year || '?'} &nbsp;|&nbsp; ${d.years_active} season${d.years_active !== 1 ? 's' : ''} &nbsp;|&nbsp; Viewing: ${d.year}</p>
        </div>

        <div class="team-highlights">
            <div class="highlight-card">
                <div class="highlight-label">Highest Stage of Play (${d.year})</div>
                <div class="highlight-value">${d.highest_stage_of_play}</div>
            </div>
            <div class="highlight-card">
                <div class="highlight-label">Highest Event Level (${d.year})</div>
                <div class="highlight-value">${d.highest_event_level}</div>
            </div>
        </div>

        <h3>Event Results — ${d.year}</h3>
        ${d.events_this_year.length ? `
        <table class="data-table compact">
            <thead>
                <tr>
                    <th>Event</th><th>Type</th><th>Qual Rank</th><th>Qual Record</th>
                    <th>Playoff Level</th><th>Playoff Result</th>
                </tr>
            </thead>
            <tbody>
                ${d.events_this_year.map(e => `
                <tr>
                    <td>${e.event_name}</td>
                    <td class="muted">${e.event_type}</td>
                    <td class="rank">${e.qual_rank}</td>
                    <td class="stat">${e.qual_record}</td>
                    <td>${e.playoff_level}</td>
                    <td>${e.playoff_status === 'won'
                        ? '<span class="winner-text">Won</span>'
                        : e.playoff_status}</td>
                </tr>`).join('')}
            </tbody>
        </table>` : '<p class="empty">No events yet this year.</p>'}

        ${d.season_achievements && d.season_achievements.length ? `
        <h3>Season-by-Season Achievements (since ${d.rookie_year || '?'})</h3>
        <table class="data-table compact">
            <thead>
                <tr>
                    <th>Year</th><th>Biggest Achievement</th><th>Event</th>
                </tr>
            </thead>
            <tbody>
                ${[...d.season_achievements].reverse().map(s => `
                <tr>
                    <td class="stat">${s.year}</td>
                    <td>${s.achievement.includes('Winner')
                        ? '<span class="winner-text">' + s.achievement + '</span>'
                        : s.achievement}</td>
                    <td class="muted">${s.event_name}</td>
                </tr>`).join('')}
            </tbody>
        </table>` : ''}
    </div>`;
}


// ═══════════════════════════════════════════════════════════
// 5. HEAD TO HEAD
// ═══════════════════════════════════════════════════════════
async function loadH2H() {
    const a = parseInt($('h2h-team-a').value, 10);
    const b = parseInt($('h2h-team-b').value, 10);
    if (!a || !b) return;

    loading(true);
    try {
        const data = await API.headToHead(a, b);
        $('h2h-results').innerHTML = renderH2H(data);
    } catch (err) {
        alert(`Error loading H2H: ${err.message}`);
    } finally {
        loading(false);
    }
}

function renderH2H(d) {
    const s = d.h2h_summary;
    return `
    <div class="h2h-card">
        <div class="h2h-header">
            <span class="red-text">${d.team_a}</span>
            <span class="vs-label">vs</span>
            <span class="blue-text">${d.team_b}</span>
        </div>

        <div class="h2h-summary">
            <p>Checked years: ${d.years_checked.join(', ')}</p>
            <div class="h2h-score">
                <span class="red-text">${s.team_a_wins} W</span>
                <span>–</span>
                <span class="blue-text">${s.team_b_wins} W</span>
            </div>
            <p class="muted">${s.total_opponent_matches} opponent match${s.total_opponent_matches !== 1 ? 'es' : ''} &nbsp;|&nbsp;
               ${s.total_ally_matches} as allies</p>
        </div>

        ${d.opponent_matches.length ? `
        <h4>As Opponents</h4>
        <table class="data-table compact">
            <thead><tr>
                <th>Match</th><th>Event</th><th>Round</th>
                <th>Red</th><th>Score</th><th>Blue</th><th>Score</th><th>Winner</th>
            </tr></thead>
            <tbody>
                ${d.opponent_matches.map(m => `
                <tr>
                    <td class="stat">${m.match_key.split('_').pop()}</td>
                    <td class="muted">${m.event_key}</td>
                    <td>${m.comp_level}</td>
                    <td class="red-text stat">${m.red_teams.join(', ')}</td>
                    <td class="stat">${m.red_score}</td>
                    <td class="blue-text stat">${m.blue_teams.join(', ')}</td>
                    <td class="stat">${m.blue_score}</td>
                    <td class="${m.winner === String(d.team_a) ? 'red-text' : 'blue-text'} stat">
                        ${m.winner}</td>
                </tr>`).join('')}
            </tbody>
        </table>` : ''}

        ${d.ally_matches.length ? `
        <h4>As Allies</h4>
        <table class="data-table compact">
            <thead><tr>
                <th>Match</th><th>Event</th><th>Round</th>
                <th>Red</th><th>Score</th><th>Blue</th><th>Score</th><th>Result</th>
            </tr></thead>
            <tbody>
                ${d.ally_matches.map(m => `
                <tr>
                    <td class="stat">${m.match_key.split('_').pop()}</td>
                    <td class="muted">${m.event_key}</td>
                    <td>${m.comp_level}</td>
                    <td class="red-text stat">${m.red_teams.join(', ')}</td>
                    <td class="stat">${m.red_score}</td>
                    <td class="blue-text stat">${m.blue_teams.join(', ')}</td>
                    <td class="stat">${m.blue_score}</td>
                    <td class="stat">${m.winner === 'both' ? '✓ Won' : 'Lost'}</td>
                </tr>`).join('')}
            </tbody>
        </table>` : ''}

        ${!d.opponent_matches.length && !d.ally_matches.length
            ? '<p class="empty">No playoff history found between these teams.</p>' : ''}
    </div>`;
}


// ═══════════════════════════════════════════════════════════
// 6. PLAY BY PLAY
// ═══════════════════════════════════════════════════════════
async function loadPlayByPlay() {
    if (!currentEvent) return;
    loading(true);
    try {
        const data = await API.allMatches(currentEvent);
        pbpData = data;
        pbpIndex = 0;
        hide('pbp-empty');
        show('pbp-container');
        buildPbpSelector();
        renderPbpMatch();
    } catch (err) {
        alert(`Error loading matches: ${err.message}`);
    } finally {
        loading(false);
    }
}

function buildPbpSelector() {
    const sel = $('pbp-match-select');
    sel.innerHTML = pbpData.matches.map((m, i) =>
        `<option value="${i}">${m.label}</option>`
    ).join('');
    sel.value = pbpIndex;
}

function pbpGoTo(idx) {
    pbpIndex = parseInt(idx, 10);
    renderPbpMatch();
}

function pbpPrev() {
    if (pbpIndex > 0) {
        pbpIndex--;
        $('pbp-match-select').value = pbpIndex;
        renderPbpMatch();
    }
}

function pbpNext() {
    if (pbpData && pbpIndex < pbpData.matches.length - 1) {
        pbpIndex++;
        $('pbp-match-select').value = pbpIndex;
        renderPbpMatch();
    }
}

function renderPbpMatch() {
    if (!pbpData || !pbpData.matches.length) return;
    const m = pbpData.matches[pbpIndex];

    $('pbp-match-label').textContent = m.label;
    $('pbp-match-select').value = pbpIndex;

    const redWon = m.winning_alliance === 'red';
    const blueWon = m.winning_alliance === 'blue';
    const upcoming = m.red.score < 0 && m.blue.score < 0;

    $('pbp-arena').innerHTML = `
        <div class="pbp-alliance red-side ${redWon ? 'pbp-alliance-won' : ''}">
            <div class="pbp-alliance-header">
                <span class="pbp-alliance-title">Red Alliance</span>
                <span class="pbp-alliance-opr">Σ OPR ${m.red.total_opr}</span>
                <span class="pbp-alliance-score">${upcoming ? '–' : m.red.score}</span>
            </div>
            <div class="pbp-team-cards">
                ${m.red.teams.map(t => renderPbpTeam(t, 'red-side')).join('')}
            </div>
        </div>
        <div class="pbp-alliance blue-side ${blueWon ? 'pbp-alliance-won' : ''}">
            <div class="pbp-alliance-header">
                <span class="pbp-alliance-score">${upcoming ? '–' : m.blue.score}</span>
                <span class="pbp-alliance-opr">Σ OPR ${m.blue.total_opr}</span>
                <span class="pbp-alliance-title">Blue Alliance</span>
            </div>
            <div class="pbp-team-cards">
                ${m.blue.teams.map(t => renderPbpTeam(t, 'blue-side')).join('')}
            </div>
        </div>
    `;

    // Footer: quals high score
    const qs = pbpData.quals_high_score;
    $('pbp-footer').innerHTML = qs && qs.score > 0
        ? `<span class="pbp-footer-text">
               Quals High Score: <span class="pbp-footer-score">${qs.score}</span>
               in ${qs.match} (${qs.teams.join(', ')})
           </span>`
        : '';
}

function renderPbpTeam(t, sideCls) {
    const loc = [t.city, t.state_prov, t.country].filter(Boolean).join(', ');
    const foreignCls = highlightForeign && t.country && t.country !== 'Turkey' && t.country !== 'Türkiye' && t.country !== 'Turkiye' ? 'foreign-team' : '';

    return `
    <div class="pbp-team ${foreignCls}" data-country="${t.country || ''}">
        <div class="pbp-team-top">
            <div class="pbp-team-number">${t.team_number}</div>
            <div class="pbp-team-identity">
                <div class="pbp-team-nickname">${t.nickname || 'Team ' + t.team_number}</div>
                ${t.school_name ? `<div class="pbp-team-school">${t.school_name}</div>` : ''}
                ${loc ? `<div class="pbp-team-location">${loc}</div>` : ''}
            </div>
        </div>
        <div class="pbp-team-stats">
            <div class="pbp-stat">
                <div class="pbp-stat-label">Rank</div>
                <div class="pbp-stat-value">${t.rank}</div>
            </div>
            <div class="pbp-stat">
                <div class="pbp-stat-label">Qual Avg</div>
                <div class="pbp-stat-value">${t.qual_average}</div>
            </div>
            <div class="pbp-stat">
                <div class="pbp-stat-label">W-L-T</div>
                <div class="pbp-stat-value">${t.wins}-${t.losses}-${t.ties}</div>
            </div>
            <div class="pbp-stat">
                <div class="pbp-stat-label">OPR</div>
                <div class="pbp-stat-value opr-val">${t.opr}</div>
            </div>
            <div class="pbp-stat">
                <div class="pbp-stat-label">DPR</div>
                <div class="pbp-stat-value dpr-val">${t.dpr}</div>
            </div>
            <div class="pbp-stat">
                <div class="pbp-stat-label">Avg RP</div>
                <div class="pbp-stat-value">${t.avg_rp}</div>
            </div>
        </div>
        ${t.high_score > 0 ? `<div class="pbp-team-highscore">Team high score: ${t.high_score}${t.high_score_match ? ' in ' + t.high_score_match : ''}</div>` : ''}
    </div>`;
}


// ═══════════════════════════════════════════════════════════
// 7. SCORE BREAKDOWN
// ═══════════════════════════════════════════════════════════
async function loadBreakdownTab() {
    if (!currentEvent) return;
    loading(true);
    try {
        // Reuse the same all-matches data as PBP (or fetch if needed)
        if (!pbpData) {
            const data = await API.allMatches(currentEvent);
            pbpData = data;
        }
        bdData = pbpData;
        bdIndex = 0;
        bdCache = {};
        hide('bd-empty');
        show('bd-container');
        buildBdSelector();
        loadBdMatch();
    } catch (err) {
        alert(`Error loading matches: ${err.message}`);
    } finally {
        loading(false);
    }
}

function buildBdSelector() {
    const sel = $('bd-match-select');
    sel.innerHTML = bdData.matches.map((m, i) => {
        const hasBd = m.has_breakdown;
        return `<option value="${i}" ${hasBd ? 'class="has-breakdown" style="color:#22c55e"' : ''}>${hasBd ? '● ' : '○ '}${m.label}</option>`;
    }).join('');
    sel.value = bdIndex;
}

function bdGoTo(idx) {
    bdIndex = parseInt(idx, 10);
    loadBdMatch();
}

function bdPrev() {
    if (bdIndex > 0) {
        bdIndex--;
        $('bd-match-select').value = bdIndex;
        loadBdMatch();
    }
}

function bdNext() {
    if (bdData && bdIndex < bdData.matches.length - 1) {
        bdIndex++;
        $('bd-match-select').value = bdIndex;
        loadBdMatch();
    }
}

async function loadBdMatch() {
    if (!bdData || !bdData.matches.length) return;
    const m = bdData.matches[bdIndex];
    $('bd-match-label').textContent = m.label;
    $('bd-match-select').value = bdIndex;

    if (!m.has_breakdown) {
        $('bd-status').innerHTML = '<span class="bd-unavailable">Score breakdown not yet available for this match</span>';
        $('bd-content').innerHTML = '';
        return;
    }

    // Check cache
    if (bdCache[m.key]) {
        renderBreakdown(bdCache[m.key]);
        return;
    }

    $('bd-status').innerHTML = '<span style="color:var(--text-muted)">Loading breakdown…</span>';
    $('bd-content').innerHTML = '';

    try {
        const data = await API.matchBreakdown(m.key);
        if (data.available) {
            bdCache[m.key] = data;
            renderBreakdown(data);
        } else {
            $('bd-status').innerHTML = '<span class="bd-unavailable">Score breakdown not available</span>';
        }
    } catch (err) {
        $('bd-status').innerHTML = `<span style="color:#ef4444">Error: ${err.message}</span>`;
    }
}

function renderBreakdown(data) {
    $('bd-status').innerHTML = `<span class="bd-available">✓ Score breakdown available</span>`;

    // Build team_number -> nickname map from bdData match teams
    const nickMap = {};
    if (bdData && bdData.matches && bdData.matches[bdIndex]) {
        const m = bdData.matches[bdIndex];
        for (const side of ['red', 'blue']) {
            if (m[side] && m[side].teams) {
                m[side].teams.forEach(t => { if (t.nickname) nickMap[t.team_number] = t.nickname; });
            }
        }
    }

    const redWon = data.winning_alliance === 'red';
    const blueWon = data.winning_alliance === 'blue';

    $('bd-content').innerHTML = `
        ${renderBdAlliance(data.red, 'red', redWon, nickMap)}
        ${renderBdAlliance(data.blue, 'blue', blueWon, nickMap)}
    `;
}

function renderBdAlliance(alliance, color, won, nickMap) {
    const bd = alliance.breakdown;
    const sideCls = color === 'red' ? 'red-side' : 'blue-side';
    const title = color === 'red' ? 'Red Alliance' : 'Blue Alliance';

    const headerContent = color === 'blue'
        ? `<div class="bd-alliance-score-group">
                <span class="bd-alliance-score">${alliance.score}</span>
                ${won ? '<span class="bd-winner-label">WINNER</span>' : ''}
            </div>
            <span>${title}${won ? ' ★' : ''}</span>`
        : `<span>${title}${won ? ' ★' : ''}</span>
            <div class="bd-alliance-score-group">
                ${won ? '<span class="bd-winner-label">WINNER</span>' : ''}
                <span class="bd-alliance-score">${alliance.score}</span>
            </div>`;

    return `
    <div class="bd-alliance ${sideCls}">
        <div class="bd-alliance-header">
            ${headerContent}
        </div>

        <!-- Per-robot: Auto Leave + Barge -->
        <div class="bd-section">
            <div class="bd-section-title">Per-Team Performance</div>
            <div class="bd-robots">
                ${bd.robots.map(r => renderBdRobot(r, nickMap)).join('')}
            </div>
        </div>

        <!-- Autonomous -->
        <div class="bd-section">
            <div class="bd-section-title">Autonomous (${bd.autoPoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Mobility Points</span>
                    <span class="bd-stat-value">${bd.autoMobilityPoints}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Coral Scored</span>
                    <span class="bd-stat-value">${bd.autoCoralCount}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Coral Points</span>
                    <span class="bd-stat-value">${bd.autoCoralPoints}</span>
                </div>
            </div>
            ${renderReefGrid(bd.autoReef, bd.teleopReef, true)}
        </div>

        <!-- Teleop -->
        <div class="bd-section">
            <div class="bd-section-title">Teleop (${bd.teleopPoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Coral Scored</span>
                    <span class="bd-stat-value">${bd.teleopCoralCount}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Coral Points</span>
                    <span class="bd-stat-value">${bd.teleopCoralPoints}</span>
                </div>
            </div>
            ${renderReefGrid(bd.teleopReef, bd.autoReef, false)}
        </div>

        <!-- Algae -->
        <div class="bd-section">
            <div class="bd-section-title">Algae (${bd.algaePoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Net Algae</span>
                    <span class="bd-stat-value">${bd.netAlgaeCount}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Wall Algae</span>
                    <span class="bd-stat-value">${bd.wallAlgaeCount}</span>
                </div>
            </div>
        </div>

        <!-- Barge -->
        <div class="bd-section">
            <div class="bd-section-title">Barge (${bd.endGameBargePoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Barge Points</span>
                    <span class="bd-stat-value">${bd.endGameBargePoints}</span>
                </div>
            </div>
        </div>

        <!-- Fouls -->
        <div class="bd-section">
            <div class="bd-section-title">Fouls & Penalties</div>
            <div class="bd-fouls">
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Fouls:</span>
                    <span class="bd-foul-value">${bd.foulCount}</span>
                </div>
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Tech Fouls:</span>
                    <span class="bd-foul-value">${bd.techFoulCount}</span>
                </div>
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Foul Pts:</span>
                    <span class="bd-foul-value">${bd.foulPoints}</span>
                </div>
            </div>
            ${bd.g206Penalty || bd.g410Penalty || bd.g418Penalty || bd.g428Penalty ? `
                <div class="bd-bonuses" style="margin-top:.3rem">
                    ${bd.g206Penalty ? '<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">G206</span>' : ''}
                    ${bd.g410Penalty ? '<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">G410</span>' : ''}
                    ${bd.g418Penalty ? '<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">G418</span>' : ''}
                    ${bd.g428Penalty ? '<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">G428</span>' : ''}
                </div>
            ` : ''}
        </div>

        <!-- Bonuses / RP -->
        <div class="bd-section">
            <div class="bd-section-title">Bonuses & Ranking Points</div>
            <div class="bd-bonuses">
                <span class="bd-bonus-badge ${bd.autoBonusAchieved ? 'achieved' : ''}">Auto Bonus</span>
                <span class="bd-bonus-badge ${bd.coralBonusAchieved ? 'achieved' : ''}">Coral Bonus</span>
                <span class="bd-bonus-badge ${bd.bargeBonusAchieved ? 'achieved' : ''}">Barge Bonus</span>
                <span class="bd-bonus-badge ${bd.coopertitionCriteriaMet ? 'achieved' : ''}">Coopertition</span>
            </div>
            <div class="bd-stats" style="margin-top:.4rem">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Ranking Points</span>
                    <span class="bd-stat-value">${bd.rp}</span>
                </div>
                ${bd.adjustPoints ? `
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Adjust Points</span>
                    <span class="bd-stat-value">${bd.adjustPoints}</span>
                </div>` : ''}
            </div>
        </div>

        <!-- Total -->
        <div class="bd-total-bar">
            <span class="bd-total-label">Total</span>
            <span class="bd-total-score">${bd.totalPoints}</span>
        </div>
    </div>`;
}

function renderBdRobot(robot, nickMap) {
    const leaveVal = robot.autoLine === 'Yes' ? 'Yes' : 'No';
    const leaveCls = robot.autoLine === 'Yes' ? 'yes' : 'no';

    const endGameMap = {
        'DeepCage': { label: 'Deep Cage', cls: 'deep' },
        'ShallowCage': { label: 'Shallow Cage', cls: 'shallow' },
        'Parked': { label: 'Parked', cls: 'parked' },
        'None': { label: 'None', cls: 'no' },
    };
    const eg = endGameMap[robot.endGame] || { label: robot.endGame, cls: '' };
    const num = robot.team_number || '?';
    const nick = (nickMap && nickMap[num]) || '';
    const tooltipHtml = nick ? `<span class="custom-tooltip">${nick}</span>` : '';

    return `
    <div class="bd-robot-card">
        <div class="bd-robot-num has-tooltip">${num}${tooltipHtml}</div>
        <div class="bd-robot-field">
            <span class="bd-robot-label">Leave</span>
            <span class="bd-robot-value ${leaveCls}">${leaveVal}</span>
        </div>
        <div class="bd-robot-field">
            <span class="bd-robot-label">Barge</span>
            <span class="bd-robot-value ${eg.cls}">${eg.label}</span>
        </div>
    </div>`;
}

function renderReefGrid(reef, otherPhaseReef, isAuto) {
    const nodes = ['A','B','C','D','E','F','G','H','I','J','K','L'];
    const levels = [
        { key: 'topRow', label: 'L4 (Top)' },
        { key: 'midRow', label: 'L3 (Mid)' },
        { key: 'botRow', label: 'L2 (Bot)' },
    ];

    let html = '<div class="bd-reef">';
    html += `<div class="bd-reef-title">Reef Grid</div>`;
    html += '<div class="bd-reef-grid">';

    // Header row with node labels
    for (const n of nodes) {
        html += `<div class="bd-reef-cell" style="border:none;background:transparent;font-weight:700;color:var(--text-muted)">${n}</div>`;
    }

    for (const level of levels) {
        const row = reef[level.key] || {};
        const otherRow = otherPhaseReef ? (otherPhaseReef[level.key] || {}) : {};
        for (const n of nodes) {
            const nodeKey = `node${n}`;
            const filled = row[nodeKey] === true;
            // For teleop view, show auto-scored nodes differently
            const autoFilled = !isAuto && otherRow[nodeKey] === true;
            let cls = '';
            if (filled && isAuto) cls = 'filled-auto';
            else if (filled && !isAuto) cls = autoFilled ? 'filled-auto' : 'filled';
            else if (autoFilled && !isAuto) cls = 'filled-auto';
            html += `<div class="bd-reef-cell ${cls}" title="${n} ${level.label}${filled ? ' ●' : ''}">${filled || autoFilled ? '●' : ''}</div>`;
        }
    }

    html += '</div>';

    // Trough
    html += `<div class="bd-trough">
        <span class="bd-trough-label">Trough:</span>
        <span class="bd-trough-value">${reef.trough || 0}</span>
    </div>`;

    html += '</div>';
    return html;
}
