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
let currentEventYear = null; // numeric year of the loaded event
let eventInfoData = null;  // cached event info for saving
let playoffData  = null;   // cached playoff matches
let allianceData = null;   // cached alliance data
let summaryData  = null;   // cached event summary
let pbpData      = null;   // cached play-by-play data
let pbpIndex     = 0;      // current match index
let highlightForeign = false; // settings: highlight international teams
let rankingsCompact = false;      // toggle: compressed rankings view
let allianceShowDpr = false;      // toggle: show DPR/CCWM in alliance cards
let allianceShowPlayoff = false;  // toggle: show playoff ribbons/status
let allianceShowAvatars = true;  // toggle: show team avatars
let allianceShowNames = false;    // toggle: show team nicknames
let eventCountry = '';         // home country of the currently loaded event
let eventRegion  = '';         // resolved region name for the loaded event
let historyData  = null;       // cached event history data
let regionData   = null;       // cached region facts
let bdData       = null;   // cached breakdown match list (same as pbpData)
let bdIndex      = 0;      // current breakdown match index
let bdCache      = {};     // match_key -> breakdown data
let bdPollTimer  = null;   // auto-poll timer for pending breakdowns
let bdListTimer  = null;   // timer for refreshing match list has_breakdown flags
const BD_POLL_INTERVAL = 10_000;      // 10s — poll for breakdown availability
const BD_LIST_REFRESH  = 30_000;      // 30s — refresh match list flags

// Season events
let seasonEventsRaw = [];          // full list from backend
let seasonEventsFiltered = [];     // after applying region/week/search
let seasonDropdownIdx = -1;        // keyboard-highlighted index in dropdown

// Auto-refresh polling
let rankingsRefreshTimer = null;   // setInterval id for rankings polling
let currentEventStatus = null;     // 'ongoing' | 'completed' | 'upcoming' | null

// Track which tabs have been rendered from preloaded data
let renderedTabs = { playoff: false, alliance: false, playbyplay: false, breakdown: false, history: false };

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
    // Re-render tabs that embed highlight logic at render time
    if (teamsData) $('event-teams').innerHTML = renderTeamTable(teamsData, teamsSortCol, teamsSortAsc);
    if (allianceData) renderAlliances(allianceData);
    if (pbpData) renderPbpMatch();
}

function applyForeignHighlight() {
    document.querySelectorAll('[data-country]').forEach(el => {
        const c = el.dataset.country;
        const isLocal = !c || (eventCountry && c === eventCountry);
        if (highlightForeign && !isLocal) {
            el.classList.add('foreign-team');
        } else {
            el.classList.remove('foreign-team');
        }
    });
}

// ── Tab scroll fade indicators ─────────────────────────────
(() => {
    const wrap = document.querySelector('.tabs-wrap');
    const tabs = document.querySelector('.tabs');
    if (!wrap || !tabs) return;
    function updateFades() {
        const sl = tabs.scrollLeft, sw = tabs.scrollWidth, cw = tabs.clientWidth;
        wrap.classList.toggle('scroll-left', sl > 4);
        wrap.classList.toggle('scroll-right', sl + cw < sw - 4);
    }
    tabs.addEventListener('scroll', updateFades, { passive: true });
    window.addEventListener('resize', updateFades);
    // Run on next frame so layout is ready
    requestAnimationFrame(updateFades);
})();

// ── Tab switching ──────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

        // Stop breakdown polling when leaving the breakdown tab
        if (btn.dataset.tab !== 'breakdown') { stopBdPolling(); stopBdListRefresh(); }

        // Clear compare selection when leaving Rankings tab
        if (btn.dataset.tab !== 'rankings') { clearCompareSelection(); }

        // Auto-load data when switching to dependent tabs
        if (btn.dataset.tab === 'summary' && currentEvent) {
            if (summaryData) {
                hide('summary-empty');
                hide('summary-loading');
                renderSummary(summaryData);
            } else {
                loadSummary();
            }
        }

        // Lightweight tabs: render from preloaded cache, or fetch if missing
        if (btn.dataset.tab === 'playoff' && currentEvent && !renderedTabs.playoff) {
            if (playoffData) {
                hide('playoff-empty');
                renderBracketTree();
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
        if (btn.dataset.tab === 'breakdown' && currentEventYear && currentEventYear < 2025) {
            // Pre-2025: show unavailable message, skip loading
            hide('bd-container');
            const el = $('bd-empty');
            if (el) {
                el.innerHTML = 'Score breakdown is only available for 2025 events onwards.';
                el.classList.remove('hidden');
            }
        } else if (btn.dataset.tab === 'breakdown' && currentEvent && !renderedTabs.breakdown) {
            if (bdData) {
                bdIndex = 0;
                bdCache = {};
                hide('bd-empty');
                show('bd-container');
                buildBdSelector();
                loadBdMatch();
                startBdListRefresh();
                renderedTabs.breakdown = true;
            } else {
                loadBreakdownTab();
            }
        }
        // Re-entering breakdown tab after it was already loaded — resume timers
        if (btn.dataset.tab === 'breakdown' && renderedTabs.breakdown && bdData) {
            startBdListRefresh();
            // If current match still has no breakdown, resume polling
            const cm = bdData.matches[bdIndex];
            if (cm && !cm.has_breakdown) startBdPolling();
        }

        // ── History tab ──
        if (btn.dataset.tab === 'history' && currentEvent && !renderedTabs.history) {
            loadHistory();
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

// Breathing indicator on the banner dot instead of fullscreen overlay
function loading(on) {
    const dot = document.querySelector('.aeb-dot');
    if (on) {
        // Add the breathing/loading class to the dot
        if (dot) dot.classList.add('aeb-dot-loading');
    } else {
        if (dot) dot.classList.remove('aeb-dot-loading');
    }
}

// ── API Status Polling ────────────────────────────────────
async function checkApiStatus() {
    try {
        const resp = await fetch('/api/status');
        const data = await resp.json();

        const tbaDot = document.querySelector('#status-tba .status-dot');
        const frcDot = document.querySelector('#status-frc .status-dot');
        if (tbaDot) {
            tbaDot.className = 'status-dot ' + (data.tba ? 'status-ok' : 'status-down');
        }
        if (frcDot) {
            frcDot.className = 'status-dot ' + (data.frc ? 'status-ok' : 'status-down');
        }
    } catch {
        document.querySelectorAll('.status-dot').forEach(d => d.className = 'status-dot status-down');
    }
}
// Check on load, then every 60 seconds
checkApiStatus();
setInterval(checkApiStatus, 60000);

// Load saved events list on startup
loadSavedEventsList();


// ═══════════════════════════════════════════════════════════
// 1. EVENT SELECTION
// ═══════════════════════════════════════════════════════════

// ── Season events loader ──────────────────────────────────
async function loadSeasonEvents() {
    const status = $('season-status');
    status.textContent = 'Loading 2026 events…';
    try {
        // Load from bundled static JSON (instant, no API call)
        const resp = await fetch('data/season_2026.json');
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
    $('season-search').classList.add('input-loading');
    // Show loading indicator in header
    const lb = $('season-loading-btn');
    if (lb) { lb.classList.remove('hidden'); lb.classList.add('btn-loading'); }
    loadEvent(ev.key);
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
    currentEventYear = null;
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
async function loadEvent(eventKey) {
    let code, year, eventCode;
    const fromSeason = !!eventKey; // true when called from season dropdown
    if (eventKey) {
        code = eventKey;
        year = eventKey.substring(0, 4);
        eventCode = eventKey.substring(4);
    } else {
        year = $('event-year').value.trim();
        eventCode = $('event-code').value.trim().toLowerCase();
        if (!year || !eventCode) return;
        code = `${year}${eventCode}`;
    }

    // Show inline loading indicator on the manual button (only for manual entry)
    const btn = fromSeason ? null : $('btn-load-event');
    if (btn) { btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = 'Loading…'; btn.classList.add('btn-loading'); }

    // Reset state
    playoffData = null;
    allianceData = null;
    summaryData = null;
    eventInfoData = null;
    pbpData = null;
    pbpIndex = 0;
    bdData = null;
    bdIndex = 0;
    bdCache = {};
    historyData = null;
    regionData = null;
    stopBdPolling();
    stopBdListRefresh();
    _pbpConnCache = {};
    _pbpConnAllTime = false;
    renderedTabs = { playoff: false, alliance: false, playbyplay: false, breakdown: false, history: false };

    try {
        // ── Phase 1: Fetch essentials, show UI immediately ──
        const [info, teams] = await Promise.all([
            API.eventInfo(code),
            API.eventTeams(code),
        ]);

        // Restore the load button and season search
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Load Event'; btn.classList.remove('btn-loading'); }
        $('season-search')?.classList.remove('input-loading');
        const _lb = $('season-loading-btn');
        if (_lb) { _lb.classList.add('hidden'); _lb.classList.remove('btn-loading'); }

        currentEvent = code;
        currentEventYear = parseInt(year, 10);
        eventInfoData = info;
        localStorage.setItem('selectedEvent', JSON.stringify({ year, eventCode }));

        // Disable breakdown tab for pre-2025 events
        updateBreakdownTabState();

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
        eventCountry = info.country || '';
        eventRegion = info.region || '';
        show('event-badge');

        // Auto-cache info + teams into IndexedDB
        autoCacheTab('info', info);
        autoCacheTab('teams', teams);

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

        // Rankings & Teams tab — sort by team number when no rankings exist
        const hasRankings = teams.some(t => typeof t.rank === 'number');
        if (!hasRankings || currentEventStatus === 'upcoming') {
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
        $('playoff-bracket').innerHTML = '';
        $('alliance-empty')?.classList.remove('hidden');
        $('alliance-grid').innerHTML = '';
        $('bd-empty')?.classList.remove('hidden');
        $('bd-container')?.classList.add('hidden');
        $('bd-content') && ($('bd-content').innerHTML = '');
        $('bd-status') && ($('bd-status').innerHTML = '');
        $('pbp-empty')?.classList.remove('hidden');
        $('pbp-container')?.classList.add('hidden');
        $('history-empty')?.classList.remove('hidden');
        $('history-container')?.classList.add('hidden');

        // Hide cache badge for fresh loads
        $('aeb-cache-badge')?.classList.add('hidden');

        // ── Phase 2: Preload secondary data in background (non-blocking) ──
        loading(true); // breathing dot while background data loads
        Promise.all([
            API.allMatches(code).catch(() => null),
            API.playoffMatches(code).catch(() => null),
            API.alliances(code).catch(() => null),
        ]).then(([matchData, playoffResult, allianceResult]) => {
            if (currentEvent !== code) return; // user switched events

            if (matchData) {
                pbpData = matchData;
                bdData  = matchData;
                autoCacheTab('matches', matchData);
            }
            if (playoffResult && playoffResult.matches) {
                playoffData = playoffResult.matches;
            }
            if (allianceResult) {
                allianceData = allianceResult;
                autoCacheTab('alliances', allianceResult);
            }
        }).catch(() => {}).finally(() => loading(false));

    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Load Event'; btn.classList.remove('btn-loading'); }
        $('season-search')?.classList.remove('input-loading');
        const _lb2 = $('season-loading-btn');
        if (_lb2) { _lb2.classList.add('hidden'); _lb2.classList.remove('btn-loading'); }
        alert(`Error loading event: ${err.message}`);
        loading(false);
    }
}

// ═══════════════════════════════════════════════════════════
//  Save / Load Event Cache
// ═══════════════════════════════════════════════════════════

/** Save current event — stores snapshot in browser IndexedDB (per-user) */
async function saveCurrentEvent() {
    if (!currentEvent) return;
    const btn = $('btn-save-event');
    const label = $('save-event-label');
    if (!btn || !label) return;

    btn.disabled = true;
    label.textContent = 'Saving…';
    btn.classList.add('saving');

    try {
        // Build the snapshot from already-loaded client data
        const snapshot = {
            info:       eventInfoData || null,
            teams:      teamsData || null,
            summary:    summaryData || null,
            matches:    pbpData || null,
            playoffs:   playoffData ? { matches: playoffData } : null,
            alliances:  allianceData || null,
            connections: null,
            connections_alltime: null,
        };

        // Store in browser IndexedDB (per-user, per-browser)
        await EventCache.put(currentEvent, snapshot);

        label.textContent = 'Saved ✓';
        btn.classList.remove('saving');
        btn.classList.add('saved');
        setTimeout(() => {
            label.textContent = 'Save Event';
            btn.classList.remove('saved');
            btn.disabled = false;
        }, 3000);

        // Refresh the saved events list
        loadSavedEventsList();
    } catch (err) {
        label.textContent = 'Error!';
        btn.classList.remove('saving');
        setTimeout(() => {
            label.textContent = 'Save Event';
            btn.disabled = false;
        }, 2000);
        console.error('Save event failed:', err);
    }
}

/** Load an event from saved cache (instant) — used by saved events list */
async function loadSavedEvent(eventKey) {
    // Reset state
    playoffData = null; allianceData = null; summaryData = null; eventInfoData = null;
    pbpData = null; pbpIndex = 0; bdData = null; bdIndex = 0; bdCache = {};
    historyData = null; regionData = null;
    stopBdPolling(); stopBdListRefresh();
    _pbpConnCache = {}; _pbpConnAllTime = false;
    renderedTabs = { playoff: false, alliance: false, playbyplay: false, breakdown: false, history: false };

    try {
        // Load from browser IndexedDB
        const snapshot = await EventCache.get(eventKey);
        if (!snapshot) throw new Error('Event not found in local cache');

        const data = snapshot.data || snapshot;
        if (!data.info || !data.teams) throw new Error('Incomplete saved data');

        // Parse event key
        const year = eventKey.substring(0, 4);
        const eventCode = eventKey.substring(4);
        $('event-year').value = year;
        $('event-code').value = eventCode;

        currentEvent = eventKey;
        currentEventYear = parseInt(year, 10);
        eventInfoData = data.info;
        localStorage.setItem('selectedEvent', JSON.stringify({ year, eventCode }));

        // Disable breakdown tab for pre-2025 events
        updateBreakdownTabState();

        const info = data.info;
        const teams = data.teams;

        // Sync season search
        const matchedSeason = seasonEventsRaw.find(e => e.key === eventKey);
        if (matchedSeason) $('season-search').value = matchedSeason.name;

        // Badge
        const badge = $('event-badge');
        badge.textContent = `${info.name} (${info.year})`;
        badge.classList.remove('status-ongoing', 'status-upcoming', 'status-completed');
        if (info.status) badge.classList.add(`status-${info.status}`);
        currentEventStatus = info.status || null;
        eventCountry = info.country || '';
        eventRegion = info.region || '';

        // If saved snapshot is missing region, fetch it live
        if (!eventRegion && currentEvent) {
            try {
                const liveInfo = await API.eventInfo(currentEvent);
                if (liveInfo && liveInfo.region) {
                    eventRegion = liveInfo.region;
                    info.region = liveInfo.region;
                }
            } catch (_) { /* non-critical */ }
        }

        show('event-badge');

        // Active event banner
        const statusBadge = info.status
            ? `<span class="aeb-status-badge status-${info.status}">${info.status.toUpperCase()}</span>`
            : '';
        $('aeb-name').textContent = info.name;
        $('aeb-meta').innerHTML = `<span>${info.event_type_string || ''} — ${info.city || ''}, ${info.state_prov || ''} · ${info.start_date || ''} → ${info.end_date || ''} · ${teams.length} teams</span>${statusBadge}`;

        const dot = document.querySelector('.aeb-dot');
        if (dot) {
            dot.classList.remove('dot-ongoing', 'dot-upcoming', 'dot-completed');
            if (info.status) dot.classList.add(`dot-${info.status}`);
        }
        show('active-event-banner');

        // Show cache badge
        const cacheBadge = $('aeb-cache-badge');
        if (cacheBadge) {
            const savedTime = snapshot.saved_at
                ? new Date(typeof snapshot.saved_at === 'number' && snapshot.saved_at > 1e12
                    ? snapshot.saved_at  // already ms
                    : snapshot.saved_at * 1000  // unix seconds → ms
                ).toLocaleString()
                : 'Unknown';
            cacheBadge.innerHTML = `<svg class="cache-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Loaded from cache (${savedTime})`;
            cacheBadge.classList.remove('hidden');
        }

        // Sort — by team number when no rankings exist
        const hasRankings = teams.some(t => typeof t.rank === 'number');
        if (!hasRankings || currentEventStatus === 'upcoming') {
            teamsSortCol = 'team_number'; teamsSortAsc = true;
        } else {
            teamsSortCol = 'rank'; teamsSortAsc = true;
        }
        hide('rankings-empty');
        show('rankings-container');
        $('event-teams').innerHTML = buildTeamTable(teams);

        // Reset dependent tabs
        $('summary-empty')?.classList.remove('hidden');
        $('summary-container')?.classList.add('hidden');
        $('playoff-empty')?.classList.remove('hidden');
        $('playoff-bracket').innerHTML = '';
        $('alliance-empty')?.classList.remove('hidden');
        $('alliance-grid').innerHTML = '';
        $('bd-empty')?.classList.remove('hidden');
        $('bd-container')?.classList.add('hidden');
        $('pbp-empty')?.classList.remove('hidden');
        $('pbp-container')?.classList.add('hidden');
        $('history-empty')?.classList.remove('hidden');
        $('history-container')?.classList.add('hidden');

        // Pre-populate tab data from cache
        if (data.matches) { pbpData = data.matches; bdData = data.matches; }
        if (data.playoffs && data.playoffs.matches) {
            playoffData = data.playoffs.matches;
        }
        if (data.alliances) allianceData = data.alliances;
        if (data.summary) {
            summaryData = data.summary;
            if (data.summary.connections) summaryData._connections_past3 = data.summary.connections;
        }
        if (data.connections) {
            // Pre-populate cache but don't block — this is from a saved snapshot
        }

        // For ongoing events, do a background refresh
        if (currentEventStatus === 'ongoing') {
            backgroundRefreshEvent(eventKey);
        }

    } catch (err) {
        alert(`Error loading saved event: ${err.message}`);
    }
}

/** Background refresh for ongoing events — update data silently */
async function backgroundRefreshEvent(eventKey) {
    try {
        const [freshTeams, freshMatches, freshPlayoffs, freshAlliances] = await Promise.all([
            API.eventTeams(eventKey).catch(() => null),
            API.allMatches(eventKey).catch(() => null),
            API.playoffMatches(eventKey).catch(() => null),
            API.alliances(eventKey).catch(() => null),
        ]);

        // Guard: user may have switched events during fetch
        if (currentEvent !== eventKey) return;

        // Update rankings/teams
        if (freshTeams) {
            $('event-teams').innerHTML = buildTeamTable(freshTeams);
            autoCacheTab('teams', freshTeams);
        }

        // Update match data (PBP + Breakdown share this)
        if (freshMatches) {
            pbpData = freshMatches;
            bdData  = freshMatches;
            autoCacheTab('matches', freshMatches);
            // If PBP or Breakdown tab was already rendered, refresh their selectors
            if (renderedTabs.playbyplay) buildPbpSelector();
            if (renderedTabs.breakdown)  buildBdSelector();
        }

        // Update playoff bracket
        if (freshPlayoffs && freshPlayoffs.matches) {
            playoffData = freshPlayoffs.matches;
            if (renderedTabs.playoff) renderBracketTree();
        }

        // Update alliance data
        if (freshAlliances) {
            allianceData = freshAlliances;
            if (renderedTabs.alliance) renderAlliances(freshAlliances);
        }

        // Brief "updated" flash on cache badge
        const cacheBadge = $('aeb-cache-badge');
        if (cacheBadge && !cacheBadge.classList.contains('hidden')) {
            const prev = cacheBadge.textContent;
            cacheBadge.innerHTML = '<svg class="cache-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Live data refreshed';
            cacheBadge.classList.add('cache-badge-flash');
            setTimeout(() => {
                cacheBadge.textContent = prev;
                cacheBadge.classList.remove('cache-badge-flash');
            }, 3000);
        }
    } catch (_) { /* silent */ }
}

/** Auto-cache tab data to IndexedDB as user visits each tab */
async function autoCacheTab(tabName, tabData) {
    if (!currentEvent || !tabData) return;
    await EventCache.patchTab(currentEvent, tabName, tabData);
}

/** Load and render the saved events list on the Events tab */
async function loadSavedEventsList() {
    try {
        // Load saved events from browser IndexedDB only (per-user)
        const events = (await EventCache.list()).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));

        const card = $('saved-events-card');
        const list = $('saved-events-list');
        if (!card || !list) return;

        if (events.length === 0) {
            card.classList.add('hidden');
            return;
        }

        card.classList.remove('hidden');
        list.innerHTML = events.map(e => {
            const time = e.saved_at
                ? new Date(e.saved_at > 1e12 ? e.saved_at : e.saved_at * 1000).toLocaleString()
                : '';
            const statusCls = e.status ? `status-${e.status}` : '';
            const statusLabel = e.status ? e.status.charAt(0).toUpperCase() + e.status.slice(1) : '';
            return `
                <div class="saved-event-item" onclick="loadSavedEvent('${e.event_key}')">
                    <div class="saved-event-info">
                        <span class="saved-event-name">${e.name || e.event_key}</span>
                        ${statusLabel ? `<span class="saved-event-status ${statusCls}">${statusLabel}</span>` : ''}
                    </div>
                    <div class="saved-event-meta">
                        <span class="saved-event-time">${time}</span>
                        <button class="saved-event-delete" onclick="event.stopPropagation(); deleteSavedEvent('${e.event_key}')" title="Remove saved event">✕</button>
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        console.error('Failed to load saved events:', err);
    }
}

/** Delete a saved event from browser cache */
async function deleteSavedEvent(eventKey) {
    await EventCache.remove(eventKey);
    loadSavedEventsList();
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
                if (va !== vb) return asc ? va - vb : vb - va;
                return a.team_number - b.team_number;  // tiebreak: lowest number first
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

function toggleRankingsCompact(on) {
    rankingsCompact = on;
    if (teamsData) {
        $('event-teams').innerHTML = renderTeamTable(teamsData, teamsSortCol, teamsSortAsc);
    }
}

function renderTeamTable(teams, sortCol, asc) {
    const arrow = asc ? ' ▲' : ' ▼';
    const th = (key, label) =>
        `<th class="sortable-th col-${key}${sortCol === key ? ' sorted' : ''}" onclick="sortTeams('${key}')">${label}${sortCol === key ? arrow : ''}</th>`;
    const compact = rankingsCompact;

    const toolbar = `<div class="rankings-toolbar">
        <label class="toggle-label"><input type="checkbox" ${compact ? 'checked' : ''} onchange="toggleRankingsCompact(this.checked)"> Compact</label>
    </div>`;

    return toolbar + `
    <table class="data-table${compact ? ' compact' : ''}">
        <thead>
            <tr>
                <th class="compare-th"></th>
                ${th('rank', 'Rank')}
                <th></th>
                ${th('team_number', 'Team')}
                ${th('nickname', 'Name')}
                ${compact ? '' : th('location', 'Location')}
                ${th('record', 'Record')}
                ${th('opr', 'OPR')}
                ${compact ? '' : th('dpr', 'DPR')}
                ${compact ? '' : th('ccwm', 'CCWM')}
            </tr>
        </thead>
        <tbody>
            ${teams.map(t => {
                const loc = [t.city, t.state_prov, t.country].filter(Boolean).join(', ');
                const name = formatTeamName(t.nickname);
                const avatarImg = t.avatar
                    ? `<img src="${t.avatar}" class="team-avatar" alt="" loading="lazy">`
                    : `<span class="team-avatar team-avatar-placeholder">${t.team_number}</span>`;
                const checked = compareSelection.has(t.team_key) ? 'checked' : '';
                const isIntl = highlightForeign && t.country && eventCountry && t.country !== eventCountry;
                return `
            <tr class="${isIntl ? 'foreign-team-row' : ''}" data-country="${t.country || ''}">
                <td class="compare-td"><input type="checkbox" class="compare-cb" data-team="${t.team_key}" ${checked} onclick="toggleCompareTeam('${t.team_key}')"></td>
                <td class="rank">${t.rank}</td>
                <td class="team-avatar-cell">${avatarImg}</td>
                <td class="team-num">${t.team_number}</td>
                <td>${name}</td>
                ${compact ? '' : `<td class="location">${loc}</td>`}
                <td class="stat">${t.wins}-${t.losses}-${t.ties}</td>
                <td class="stat stat-opr">${t.opr}</td>
                ${compact ? '' : `<td class="stat stat-dpr">${t.dpr}</td>`}
                ${compact ? '' : `<td class="stat">${t.ccwm}</td>`}
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
        autoCacheTab('summary', data);
    } catch (err) {
        alert(`Error loading summary: ${err.message}`);
        show('summary-empty');
    } finally {
        hide('summary-loading');
    }
}

/** Lazy-load prior playoff connections for the summary tab */
async function loadSummaryConnections() {
    if (!currentEvent || !summaryData) return;
    try {
        const connections = await API.eventConnections(currentEvent, false);
        if (!summaryData) return; // user switched events
        summaryData.connections = connections;
        summaryData._connections_past3 = connections;
        const histEl = $('summary-history');
        if (connections.length > 0) {
            renderConnections(connections, 'all');
            document.querySelectorAll('.conn-filter-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.conn-filter-btn[data-conn-filter="all"]')?.classList.add('active');
            histEl.classList.remove('hidden');
        } else {
            histEl.classList.add('hidden');
        }
    } catch {
        $('summary-history-list').innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">Could not load connections.</p>';
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
            <div class="summary-stat-label">Veteran Teams <span class="summary-stat-sub">(${d.veteran_count})</span></div>
            <div class="summary-stat-sub">Avg team age: ${d.avg_team_age} yrs</div>
        </div>
        <div class="summary-stat-card">
            <div class="summary-stat-value">${d.foreign_pct}%</div>
            <div class="summary-stat-label">International Teams <span class="summary-stat-sub">(${d.foreign_count}${d.event_country ? ', non-' + d.event_country : ''})</span></div>
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

    // Prior connections — lazy-load on demand
    const histEl = $('summary-history');
    histEl.classList.remove('hidden');
    if (data.connections && data.connections.length > 0) {
        // Connections came from cache — render immediately
        renderConnections(data.connections, 'all');
        document.querySelectorAll('.conn-filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.conn-filter-btn[data-conn-filter="all"]')?.classList.add('active');
    } else if (!data.connections) {
        // Not loaded yet — show placeholder, fetch in background
        $('summary-history-list').innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">Loading connections…</p>';
        loadSummaryConnections();
    } else {
        histEl.classList.add('hidden');
    }

    // Top scorers
    renderTopScorers(data.top_scorers);
}

let currentConnFilter = 'all';
let currentConnSearch = '';
let currentConnSort = 'most';

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
    applyConnFilters();
}

function setConnSort(sort, btn) {
    currentConnSort = sort;
    document.querySelectorAll('.conn-sort-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyConnFilters();
}

function applyConnFilters() {
    currentConnSearch = ($('conn-team-search')?.value || '').trim();
    if (summaryData) renderConnections(summaryData.connections, currentConnFilter);
}

async function toggleConnRange(allTime) {
    if (!currentEvent || !summaryData) return;
    // Update toggle label styling
    const sides = document.querySelectorAll('.conn-range-side');
    if (sides.length === 2) {
        sides[0].classList.toggle('active', !allTime);
        sides[1].classList.toggle('active', allTime);
    }
    const list = $('summary-history-list');

    try {
        let connections;
        if (allTime) {
            // Try cached all-time data first
            if (summaryData._connections_alltime) {
                connections = summaryData._connections_alltime;
            } else {
                list.innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">Loading connections…</p>';
                connections = await API.eventConnections(currentEvent, true);
                summaryData._connections_alltime = connections;
            }
        } else {
            // Past 3: use the original connections that came with the summary
            connections = summaryData._connections_past3 || summaryData.connections;
        }
        summaryData.connections = connections;
        applyConnFilters();
    } catch (err) {
        list.innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">Error loading connections.</p>';
    }
}

function toggleConnRow(el) {
    el.classList.toggle('expanded');
}

function renderConnections(connections, filter) {
    const search = currentConnSearch;

    let filtered = connections.filter(c => {
        // type filter
        if (filter === 'partners' && c.partnered_at.length === 0) return false;
        if (filter === 'opponents' && c.opponents_at.length === 0) return false;
        if (filter === 'winners' && !c.partnered_at.some(p => p.result === 'winner')) return false;
        if (filter === 'finalists' && !c.partnered_at.some(p => p.result === 'finalist')) return false;
        // team search
        if (search) {
            const q = search.toLowerCase();
            if (!String(c.team_a).includes(q) && !String(c.team_b).includes(q)
                && !c.team_a_name.toLowerCase().includes(q) && !c.team_b_name.toLowerCase().includes(q)) return false;
        }
        return true;
    });

    // Sort
    if (currentConnSort === 'recent') {
        filtered.sort((a, b) => {
            const ya = Math.max(...[...a.partnered_at, ...a.opponents_at].map(e => e.year));
            const yb = Math.max(...[...b.partnered_at, ...b.opponents_at].map(e => e.year));
            return yb - ya;
        });
    } else if (currentConnSort === 'oldest') {
        filtered.sort((a, b) => {
            const ya = Math.min(...[...a.partnered_at, ...a.opponents_at].map(e => e.year));
            const yb = Math.min(...[...b.partnered_at, ...b.opponents_at].map(e => e.year));
            return ya - yb;
        });
    } else {
        // 'most' — default: most total connections first
        filtered.sort((a, b) => (b.partnered_at.length + b.opponents_at.length) - (a.partnered_at.length + a.opponents_at.length));
    }

    if (filtered.length === 0) {
        $('summary-history-list').innerHTML = '<p class="empty" style="margin:.5rem 0;font-size:.82rem">No connections match this filter.</p>';
        return;
    }

    $('summary-history-list').innerHTML = filtered.map(c => {
        const partnerCount = c.partnered_at.length;
        const opponentCount = c.opponents_at.length;
        const totalCount = partnerCount + opponentCount;

        // Summary chips for the header
        const chips = [];
        const svgPartner = '<svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4 4 4 0 0 1 4-4h1"/><path d="M13 17a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-1"/><path d="M7 13 5 3l4 2 3-2 3 2 4-2-2 10"/></svg>';
        const svgOpponent = '<svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-2 2"/></svg>';
        if (partnerCount) chips.push(`<span class="conn-chip conn-chip-partner">${svgPartner} ${partnerCount}</span>`);
        if (opponentCount) chips.push(`<span class="conn-chip conn-chip-opponent">${svgOpponent} ${opponentCount}</span>`);

        // Detail lines (shown on expand)
        const lines = [];
        c.partnered_at.forEach(p => {
            const resultBadge = p.result === 'winner' ? '<span class="conn-detail-result conn-result-winner">Winner</span>'
                : p.result === 'finalist' ? '<span class="conn-detail-result conn-result-finalist">Finalist</span>' : '';
            lines.push(`<div class="conn-detail-line conn-line-partner">
                <span class="conn-detail-icon">${svgPartner}</span>
                <span class="conn-detail-event">${p.event_name || p.event_key}</span>
                <span class="conn-detail-year">${p.year}</span>
                ${resultBadge}
                <span class="conn-detail-stage">${p.stage}</span>
            </div>`);
        });
        c.opponents_at.forEach(o => {
            lines.push(`<div class="conn-detail-line conn-line-opponent">
                <span class="conn-detail-icon">${svgOpponent}</span>
                <span class="conn-detail-event">${o.event_name || o.event_key}</span>
                <span class="conn-detail-year">${o.year}</span>
                <span class="conn-detail-stage">${o.stage}</span>
            </div>`);
        });

        return `
        <div class="conn-row" onclick="toggleConnRow(this)">
            <div class="conn-row-header">
                <span class="conn-team has-tooltip">${c.team_a}<span class="custom-tooltip">${c.team_a_name}</span></span>
                <span class="conn-vs">&amp;</span>
                <span class="conn-team has-tooltip">${c.team_b}<span class="custom-tooltip">${c.team_b_name}</span></span>
                <span class="conn-chips">${chips.join('')}</span>
                <span class="conn-expand-icon">▸</span>
            </div>
            <div class="conn-row-details">${lines.join('')}</div>
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
async function loadPlayoffs() {
    if (!currentEvent) return;
    try {
        const data = await API.playoffMatches(currentEvent);
        playoffData = data.matches;
        hide('playoff-empty');
        renderBracketTree();
    } catch (err) {
        alert(`Error loading playoffs: ${err.message}`);
    }
}

/* ── FRC Double-Elimination Bracket Tree ─────────────────── */

// Upper bracket structure: sets that merge
// [pair] → winner
const UPPER_R1_PAIRS = [[1, 2], [3, 4]]; // → sets 7, 8
const UPPER_R2_PAIR  = [7, 8];           // → set 11

// Lower bracket structure
const LOWER_R2_SETS  = [5, 6];         // L(R1) play-in
const LOWER_R3_SETS  = [9, 10];        // W(R2L) vs L(R2U)
const LOWER_R3_PAIR  = [9, 10];        // → set 12
const LOWER_R5_SET   = 13;             // W(12) vs L(11)

// Descriptions for each set
const SET_DESCRIPTIONS = {
    1: '#1 vs #8', 2: '#4 vs #5', 3: '#2 vs #7', 4: '#3 vs #6',
    5: 'L1 vs L2', 6: 'L3 vs L4',
    7: 'W1 vs W2', 8: 'W3 vs W4',
    9: 'W5 vs L8', 10: 'W6 vs L7',
    11: 'W7 vs W8', 12: 'W9 vs W10', 13: 'W12 vs L11',
    'f': 'W11 vs W13'
};

function renderBracketTree() {
    if (!playoffData || !playoffData.length) {
        $('playoff-bracket').innerHTML = '<p class="empty">No playoff matches found.</p>';
        return;
    }

    // Index matches by set_number; keep latest replay per set
    const bySet = {};
    const finals = [];
    playoffData.forEach(m => {
        if (m.bracket === 'final') {
            finals.push(m);
        } else {
            const s = m.set_number;
            if (!bySet[s] || m.match_number > bySet[s].match_number) bySet[s] = m;
        }
    });
    const gf = finals.length ? finals.reduce((a, b) => b.match_number > a.match_number ? b : a) : null;

    // Build team_number -> nickname map from loaded teamsData
    const _nickMap = {};
    if (teamsData) teamsData.forEach(t => { if (t.nickname) _nickMap[t.team_number] = t.nickname; });
    const _teamSpan = (num) => {
        const nick = _nickMap[num];
        return nick
            ? `<span class="has-tooltip bkt-team-num">${num}<span class="custom-tooltip">${nick}</span></span>`
            : `<span class="bkt-team-num">${num}</span>`;
    };
    const _teamsHtml = (nums) => nums.map(_teamSpan).join(' · ');

    // Render helpers
    const slot = (setNum, label) => {
        const m = setNum === 'f' ? gf : bySet[setNum];
        const desc = SET_DESCRIPTIONS[setNum] || '';
        if (!m) {
            return `<div class="bkt-slot bkt-tbd">
                        <div class="bkt-slot-header">${label}</div>
                        <div class="bkt-slot-body"><span class="bkt-tbd-text">TBD</span></div>
                        ${desc ? `<div class="bkt-slot-desc">${desc}</div>` : ''}
                    </div>`;
        }
        const redWon  = m.winning_alliance === 'red';
        const blueWon = m.winning_alliance === 'blue';
        const upcoming = m.red.score < 0 && m.blue.score < 0;
        const replay = m.match_number > 1 ? ` <span class="bkt-replay">R${m.match_number}</span>` : '';
        const redSeed  = m.red.alliance_number  ? `<span class="bkt-seed">#${m.red.alliance_number}</span>` : '';
        const blueSeed = m.blue.alliance_number ? `<span class="bkt-seed">#${m.blue.alliance_number}</span>` : '';
        return `<div class="bkt-slot ${upcoming ? 'bkt-upcoming' : ''} ${redWon || blueWon ? 'bkt-decided' : ''}">
                    <div class="bkt-slot-header">${label}${replay}</div>
                    <div class="bkt-row bkt-red ${redWon ? 'bkt-won' : ''}">
                        ${redSeed}
                        <span class="bkt-teams">${_teamsHtml(m.red.team_numbers)}</span>
                        <span class="bkt-score">${upcoming ? '–' : m.red.score}</span>
                    </div>
                    <div class="bkt-row bkt-blue ${blueWon ? 'bkt-won' : ''}">
                        ${blueSeed}
                        <span class="bkt-teams">${_teamsHtml(m.blue.team_numbers)}</span>
                        <span class="bkt-score">${upcoming ? '–' : m.blue.score}</span>
                    </div>
                    ${desc ? `<div class="bkt-slot-desc">${desc}</div>` : ''}
                </div>`;
    };

    $('playoff-bracket').innerHTML = `
        <div class="bracket-tree">
            <!-- ── Upper Bracket ─────────────────────────── -->
            <div class="bracket-section bracket-upper-section">
                <div class="bracket-section-label upper-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
                    Upper Bracket
                </div>
                <div class="bracket-flow">
                    <div class="bkt-round">
                        <div class="bkt-pair">
                            ${slot(1, 'M1')}
                            ${slot(2, 'M2')}
                        </div>
                        <div class="bkt-pair">
                            ${slot(3, 'M3')}
                            ${slot(4, 'M4')}
                        </div>
                    </div>
                    <div class="bkt-connectors bkt-conn-4to2">
                        <div class="bkt-conn-pair"><div class="bkt-conn-top"></div><div class="bkt-conn-bot"></div></div>
                        <div class="bkt-conn-pair"><div class="bkt-conn-top"></div><div class="bkt-conn-bot"></div></div>
                    </div>
                    <div class="bkt-round">
                        <div class="bkt-pair">
                            ${slot(7, 'M7')}
                            ${slot(8, 'M8')}
                        </div>
                    </div>
                    <div class="bkt-connectors bkt-conn-2to1">
                        <div class="bkt-conn-pair"><div class="bkt-conn-top"></div><div class="bkt-conn-bot"></div></div>
                    </div>
                    <div class="bkt-round">
                        ${slot(11, 'M11')}
                    </div>
                </div>
            </div>

            <!-- ── Grand Final ─────────────────────────── -->
            <div class="bracket-section bracket-final-section">
                <div class="bracket-section-label final-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    Grand Final
                </div>
                <div class="bracket-flow bracket-flow-single">
                    ${slot('f', 'Final')}
                </div>
            </div>

            <!-- ── Lower Bracket ─────────────────────────── -->
            <div class="bracket-section bracket-lower-section">
                <div class="bracket-section-label lower-label">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                    Lower Bracket
                </div>
                <div class="bracket-flow">
                    <div class="bkt-round">
                        ${slot(5, 'M5')}
                        ${slot(6, 'M6')}
                    </div>
                    <div class="bkt-connectors bkt-conn-straight">
                        <div class="bkt-conn-horiz"></div>
                        <div class="bkt-conn-horiz"></div>
                    </div>
                    <div class="bkt-round">
                        ${slot(9, 'M9')}
                        ${slot(10, 'M10')}
                    </div>
                    <div class="bkt-connectors bkt-conn-2to1">
                        <div class="bkt-conn-pair"><div class="bkt-conn-top"></div><div class="bkt-conn-bot"></div></div>
                    </div>
                    <div class="bkt-round">
                        ${slot(12, 'M12')}
                    </div>
                    <div class="bkt-connectors bkt-conn-straight bkt-conn-single">
                        <div class="bkt-conn-horiz"></div>
                    </div>
                    <div class="bkt-round">
                        ${slot(13, 'M13')}
                    </div>
                </div>
            </div>
        </div>
    `;
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
        autoCacheTab('alliances', data);
    } catch (err) {
        hide('alliance-loading');
        alert(`Error loading alliances: ${err.message}`);
    }
}

function toggleAllianceAvatars(on) {
    allianceShowAvatars = on;
    if (allianceData) renderAlliances(allianceData);
}
function toggleAllianceNames(on) {
    allianceShowNames = on;
    if (allianceData) renderAlliances(allianceData);
}
function toggleAllianceDpr(on) {
    allianceShowDpr = on;
    if (allianceData) renderAlliances(allianceData);
}
function toggleAlliancePlayoff(on) {
    allianceShowPlayoff = on;
    if (allianceData) renderAlliances(allianceData);
}

function renderAlliances(data) {
    const { alliances, partnerships, max_combined_opr } = data;
    if (!alliances.length) {
        $('alliance-grid').innerHTML = '<p class="empty">Alliance selection has not occurred yet.</p>';
        return;
    }

    // Show toolbar once data is loaded
    const tb = $('alliance-toolbar');
    if (tb) tb.classList.remove('hidden');

    const roleLabels = ['Captain', '1st Pick', '2nd Pick', '3rd Pick', 'Backup'];

    $('alliance-grid').innerHTML = alliances.map(a => {
        const strengthPct = max_combined_opr ? Math.round((a.combined_opr / max_combined_opr) * 100) : 0;

        // Playoff ribbon (conditional)
        let ribbonHtml = '';
        let cardCls = '';
        if (allianceShowPlayoff && a.playoff_result) {
            const ribbonCls = a.playoff_type ? `ribbon-${a.playoff_type}` : '';
            ribbonHtml = `<span class="playoff-ribbon ${ribbonCls}">${a.playoff_type === 'winner' ? '🏆 ' : ''}${a.playoff_result}${a.playoff_record ? ` (${a.playoff_record})` : ''}</span>`;
            cardCls = a.playoff_type ? 'alliance-' + a.playoff_type : '';
        }

        // Combined stats
        const dprCcwmHtml = allianceShowDpr
            ? `<span class="combined-dpr">Σ DPR ${a.combined_dpr}</span><span class="combined-ccwm">Σ CCWM ${a.combined_ccwm}</span>`
            : '';

        // Collect all partnerships for this alliance into a summary section
        const partnerSummary = [];
        const seen = new Set();
        a.teams.forEach((t) => {
            a.teams.forEach((other) => {
                if (t.team_key === other.team_key) return;
                const pairKey = [t.team_key, other.team_key].sort().join('+');
                if (seen.has(pairKey)) return;
                seen.add(pairKey);
                const p = partnerships[pairKey]
                         || partnerships[`${t.team_key}+${other.team_key}`]
                         || partnerships[`${other.team_key}+${t.team_key}`];
                if (p && p.history && p.history.length > 0) {
                    const tooltipRows = p.history.map(h =>
                        `<div class="tip-row">${h.year} &mdash; ${h.event_name.replace(/</g, '&lt;')}</div>`
                    ).join('');
                    partnerSummary.push(`<span class="badge returning has-tooltip">⟳ ${t.team_number} + ${other.team_number} (${p.history.length}×)<span class="custom-tooltip">${tooltipRows}</span></span>`);
                }
            });
        });

        return `
        <div class="alliance-card ${cardCls}">
            <div class="alliance-header">
                <div class="alliance-header-left">
                    <h3>${a.name || 'Alliance ' + a.number}</h3>
                    ${ribbonHtml}
                </div>
                <div class="alliance-header-stats">
                    <span class="combined-opr">Σ OPR ${a.combined_opr}</span>
                    ${dprCcwmHtml}
                </div>
            </div>
            <div class="alliance-strength-bar"><div class="alliance-strength-fill" style="width:${strengthPct}%"></div></div>
            <div class="alliance-teams-list">
                ${a.teams.map((t, idx) => {
                    const avatarHtml = allianceShowAvatars
                        ? (t.avatar
                            ? `<img class="alliance-team-avatar" src="${t.avatar}" alt="">`
                            : `<div class="alliance-team-avatar-placeholder"></div>`)
                        : '';

                    const isIntl = highlightForeign && t.country && eventCountry && t.country !== eventCountry;

                    const teamDprHtml = allianceShowDpr
                        ? `<span class="stat-dpr">DPR ${t.dpr}</span>`
                        : '';

                    return `
                    <div class="alliance-team-row ${isIntl ? 'intl-highlight' : ''}">
                        <span class="team-role">${roleLabels[idx] || ''}</span>
                        ${avatarHtml}
                        <span class="team-num has-tooltip" data-country="${t.country || ''}">${t.team_number}${t.nickname ? `<span class="custom-tooltip">${t.nickname}</span>` : ''}</span>
                        ${allianceShowNames ? `<span class="team-nick">${t.nickname || ''}</span>` : ''}
                        <div class="team-stats-mini">
                            <span>Rank ${t.rank}</span>
                            <span>${t.wins}-${t.losses}-${t.ties}</span>
                            <span class="stat-opr">OPR ${t.opr}</span>
                            ${teamDprHtml}
                        </div>
                    </div>`;
                }).join('')}
            </div>
            ${partnerSummary.length ? `<div class="alliance-partners-row">${partnerSummary.join('')}</div>` : ''}
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
        loading(false); // breathing dot only
    }
}

function renderTeamStats(d) {
    const avatarHtml = d.avatar
        ? `<img class="team-avatar" src="${d.avatar}" alt="Team ${d.team_number} avatar">`
        : '';
    return `
    <div class="team-card">
        <div class="team-header">
            <div class="team-header-top">
                ${avatarHtml}
                <div class="team-header-text">
                    <h2>${d.team_number} — ${d.nickname}</h2>
                    <p>${[d.city, d.state_prov, d.country].filter(Boolean).join(', ')}</p>
                    <p class="muted">Rookie: ${d.rookie_year || '?'} &nbsp;|&nbsp; ${d.years_active} season${d.years_active !== 1 ? 's' : ''} &nbsp;|&nbsp; Viewing: ${d.year}</p>
                </div>
            </div>
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
let _h2hAllTime = false;

async function loadH2H() {
    const a = parseInt($('h2h-team-a').value, 10);
    const b = parseInt($('h2h-team-b').value, 10);
    if (!a || !b) return;

    loading(true);
    try {
        const data = await API.headToHead(a, b, null, _h2hAllTime);
        $('h2h-results').innerHTML = renderH2H(data);
    } catch (err) {
        alert(`Error loading H2H: ${err.message}`);
    } finally {
        loading(false);
    }
}

function toggleH2HRange(allTime) {
    _h2hAllTime = allTime;
    const sides = document.querySelectorAll('.h2h-range-side');
    if (sides.length === 2) {
        sides[0].classList.toggle('active', !allTime);
        sides[1].classList.toggle('active', allTime);
    }
    // Auto re-fetch if teams are already filled in
    const a = parseInt($('h2h-team-a')?.value, 10);
    const b = parseInt($('h2h-team-b')?.value, 10);
    if (a && b) loadH2H();
}

function renderH2H(d) {
    const s = d.h2h_summary;
    const nicks = d.team_nicknames || {};

    // Helper: render a team number with hover tooltip showing nickname
    const tn = (num) => {
        const n = nicks[String(num)];
        if (n) return `<span class="has-tooltip">${num}<span class="custom-tooltip">${n}</span></span>`;
        return String(num);
    };
    // Helper: render a list of team numbers with tooltips
    const tList = (nums) => nums.map(tn).join(', ');

    return `
    <div class="h2h-card">
        <div class="h2h-header">
            <span class="red-text">${tn(d.team_a)}</span>
            <span class="vs-label">vs</span>
            <span class="blue-text">${tn(d.team_b)}</span>
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
                    <td class="stat">${m.match_label || m.match_key.split('_').pop()}</td>
                    <td class="muted">${m.event_name || m.event_key} (${m.year})</td>
                    <td>${m.comp_level}</td>
                    <td class="red-text stat">${tList(m.red_teams)}</td>
                    <td class="stat">${m.red_score}</td>
                    <td class="blue-text stat">${tList(m.blue_teams)}</td>
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
                    <td class="stat">${m.match_label || m.match_key.split('_').pop()}</td>
                    <td class="muted">${m.event_name || m.event_key} (${m.year})</td>
                    <td>${m.comp_level}</td>
                    <td class="red-text stat">${tList(m.red_teams)}</td>
                    <td class="stat">${m.red_score}</td>
                    <td class="blue-text stat">${tList(m.blue_teams)}</td>
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
                <div class="pbp-score-group">
                    ${redWon ? '<span class="pbp-winner-label">WINNER</span>' : ''}
                    <span class="pbp-alliance-score">${upcoming ? '–' : m.red.score}</span>
                </div>
            </div>
            <div class="pbp-team-cards">
                ${m.red.teams.map(t => renderPbpTeam(t, 'red-side')).join('')}
            </div>
        </div>
        <div class="pbp-alliance blue-side ${blueWon ? 'pbp-alliance-won' : ''}">
            <div class="pbp-alliance-header">
                <div class="pbp-score-group">
                    <span class="pbp-alliance-score">${upcoming ? '–' : m.blue.score}</span>
                    ${blueWon ? '<span class="pbp-winner-label">WINNER</span>' : ''}
                </div>
                <span class="pbp-alliance-opr">Σ OPR ${m.blue.total_opr}</span>
                <span class="pbp-alliance-title">Blue Alliance</span>
            </div>
            <div class="pbp-team-cards">
                ${m.blue.teams.map(t => renderPbpTeam(t, 'blue-side')).join('')}
            </div>
        </div>
    `;

    // Footer: quals high score + compare button
    const qs = pbpData.quals_high_score;
    $('pbp-footer').innerHTML = `
        <button class="pbp-compare-btn" onclick="compareCurrentMatch()" title="Compare all 6 teams side by side">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            Compare Teams
        </button>
        ${qs && qs.score > 0
            ? `<span class="pbp-footer-text">
                   Quals High Score: <span class="pbp-footer-score">${qs.score}</span>
                   in ${qs.match} (${qs.teams.join(', ')})
               </span>`
            : ''}
    `;

    // Prior connections between the 6 teams on the field
    renderPbpConnections(m);
}

let _pbpConnCache = {};           // keyed by "teamA,teamB,...,teamF|allTime" → connections array
let _pbpConnAllTime = false;      // current range toggle state

function _connCacheKey(teamNums, allTime) {
    return [...teamNums].sort((a, b) => a - b).join(',') + '|' + (allTime ? '1' : '0');
}

async function fetchMatchConnections(teamNums, forceAllTime) {
    const wantAllTime = forceAllTime !== undefined ? forceAllTime : _pbpConnAllTime;
    const key = _connCacheKey(teamNums, wantAllTime);
    if (_pbpConnCache[key]) return _pbpConnCache[key];
    try {
        const result = await API.eventConnections(currentEvent, wantAllTime, teamNums);
        _pbpConnCache[key] = result;
        return result;
    } catch {
        _pbpConnCache[key] = [];
        return [];
    }
}

async function renderPbpConnections(match) {
    // Collect team numbers on each side
    const redNums = new Set(match.red.teams.map(t => t.team_number));
    const blueNums = new Set(match.blue.teams.map(t => t.team_number));
    const allTeamNums = [...redNums, ...blueNums];

    // Show loading spinner while connections are being fetched
    let container = $('pbp-connections');
    if (!container) {
        container = document.createElement('div');
        container.id = 'pbp-connections';
        container.className = 'pbp-connections';
        $('pbp-footer').insertAdjacentElement('afterend', container);
    }
    const wasExpanded = container.classList.contains('pbp-conn-expanded');

    // Check if we already have cached data for these exact teams
    const cacheKey = _connCacheKey(allTeamNums, _pbpConnAllTime);
    const cached = _pbpConnCache[cacheKey];

    if (!cached) {
        container.innerHTML = `
            <div class="pbp-conn-header pbp-conn-loading-header" onclick="togglePbpConnections(event)">
                <svg class="pbp-conn-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                <svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4 4 4 0 0 1 4-4h1"/><path d="M13 17a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-1"/><path d="M7 13 5 3l4 2 3-2 3 2 4-2-2 10"/></svg>
                Prior Connections on the Field
                <span class="pbp-conn-loading-spinner"></span>
                <span style="color:var(--text-muted); font-size:.78rem; font-style:italic;">Loading connections…</span>
            </div>
            <div class="pbp-conn-body"></div>`;
        if (wasExpanded) container.classList.add('pbp-conn-expanded');
    }

    // Fetch connections for only the 6 teams on the field (cached if revisited)
    const connections = await fetchMatchConnections(allTeamNums);

    // Guard: user may have navigated away during fetch
    if (pbpData && pbpData.matches[pbpIndex] !== match) return;

    const svgPartner = '<svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4 4 4 0 0 1 4-4h1"/><path d="M13 17a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-1"/><path d="M7 13 5 3l4 2 3-2 3 2 4-2-2 10"/></svg>';
    const svgOpponent = '<svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-2 2"/></svg>';

    // Find relevant connections
    const allNums = new Set(allTeamNums);
    const items = [];
    for (const c of connections) {
        if (!allNums.has(c.team_a) || !allNums.has(c.team_b)) continue;

        // Determine context: are they on same side or opposing?
        const sameSide = (redNums.has(c.team_a) && redNums.has(c.team_b)) ||
                         (blueNums.has(c.team_a) && blueNums.has(c.team_b));
        const sideClass = sameSide
            ? (redNums.has(c.team_a) ? 'pbp-conn-red' : 'pbp-conn-blue')
            : 'pbp-conn-cross';

        // Build summary of prior history — pick the most notable entry
        const allEvents = [...c.partnered_at, ...c.opponents_at];
        allEvents.sort((a, b) => b.year - a.year);

        const highlights = [];
        for (const e of allEvents) {
            const isPartner = c.partnered_at.includes(e);
            const icon = isPartner ? svgPartner : svgOpponent;
            const typeLabel = isPartner ? 'Partners' : 'Opponents';
            const resultTag = e.result === 'winner' ? ' <span class="pbp-conn-winner">Winner</span>'
                : e.result === 'finalist' ? ' <span class="pbp-conn-finalist">Finalist</span>' : '';
            highlights.push(`${icon} <span class="pbp-conn-type">${typeLabel}</span> at ${e.event_name || e.event_key} ${e.year} <span class="pbp-conn-stage">${e.stage}</span>${resultTag}`);
        }

        const visibleHtml = highlights.slice(0, 2).join('<span class="pbp-conn-sep">·</span>');
        const extraCount = highlights.length - 2;
        let extraHtml = '';
        if (extraCount > 0) {
            const hiddenEntries = highlights.slice(2).join('<span class="pbp-conn-sep">·</span>');
            extraHtml = ` <span class="pbp-conn-more" onclick="this.parentElement.querySelector('.pbp-conn-extra').classList.toggle('hidden');this.textContent=this.textContent.startsWith('+')?'− collapse':'+${extraCount} more'">+${extraCount} more</span><span class="pbp-conn-extra hidden"><span class="pbp-conn-sep">·</span>${hiddenEntries}</span>`;
        }

        const groupOrder = sideClass === 'pbp-conn-red' ? 0 : sideClass === 'pbp-conn-blue' ? 1 : 2;
        items.push({ order: groupOrder, html: `
            <div class="pbp-conn-item ${sideClass}">
                <span class="pbp-conn-teams">${c.team_a} &amp; ${c.team_b}</span>
                <div class="pbp-conn-highlights">${visibleHtml}${extraHtml}</div>
            </div>` });
    }

    // Sort: red first, then blue, then cross-alliance
    items.sort((a, b) => a.order - b.order);

    // Render into the container (already created above)
    const isExpanded = container.classList.contains('pbp-conn-expanded');
    const checkedAttr = _pbpConnAllTime ? ' checked' : '';
    const bodyContent = items.length > 0
        ? items.map(i => i.html).join('')
        : '<div class="pbp-conn-empty">No prior connections for this match.</div>';
    container.innerHTML = `
        <div class="pbp-conn-header" onclick="togglePbpConnections(event)">
            <svg class="pbp-conn-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            <svg class="conn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4 4 4 0 0 1 4-4h1"/><path d="M13 17a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4 4 4 0 0 0-4-4h-1"/><path d="M7 13 5 3l4 2 3-2 3 2 4-2-2 10"/></svg>
            Prior Connections on the Field
            <span class="pbp-conn-count">${items.length}</span>
            <label class="pbp-conn-range-toggle" onclick="event.stopPropagation()">
                <span class="conn-range-side${!_pbpConnAllTime ? ' active' : ''}">Past 3 Seasons</span>
                <input type="checkbox"${checkedAttr} onchange="togglePbpConnRange(this.checked)">
                <span class="conn-toggle-slider"></span>
                <span class="conn-range-side${_pbpConnAllTime ? ' active' : ''}">All time</span>
            </label>
        </div>
        <div class="pbp-conn-body">
            ${bodyContent}
        </div>`;
    // Re-apply expanded state if it was open
    if (isExpanded) container.classList.add('pbp-conn-expanded');
}

function togglePbpConnections(e) {
    const container = $('pbp-connections');
    if (container) container.classList.toggle('pbp-conn-expanded');
}

async function togglePbpConnRange(allTime) {
    _pbpConnAllTime = allTime;
    // Update toggle label styling
    const container = $('pbp-connections');
    if (container) {
        const sides = container.querySelectorAll('.conn-range-side');
        if (sides.length === 2) {
            sides[0].classList.toggle('active', !allTime);
            sides[1].classList.toggle('active', allTime);
        }
    }
    // Re-render current match
    if (typeof pbpData !== 'undefined' && pbpData && pbpData.matches && pbpData.matches.length) {
        const idx = pbpIndex;
        const m = pbpData.matches[idx];
        if (m) {
            // Ensure expanded stays open through re-render
            const wasExpanded = container && container.classList.contains('pbp-conn-expanded');
            await renderPbpConnections(m);
            if (wasExpanded) $('pbp-connections')?.classList.add('pbp-conn-expanded');
        }
    }
}

function renderPbpTeam(t, sideCls) {
    const loc = [t.city, t.state_prov, t.country].filter(Boolean).join(', ');
    const foreignCls = highlightForeign && t.country && eventCountry && t.country !== eventCountry ? 'foreign-team' : '';

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

/** Enable or disable the Breakdown tab based on the loaded event year. */
function updateBreakdownTabState() {
    const bdBtn = document.querySelector('.tab[data-tab="breakdown"]');
    if (!bdBtn) return;
    if (currentEventYear && currentEventYear < 2025) {
        bdBtn.classList.add('disabled');
        bdBtn.title = 'Score breakdown is only available for 2025 events onwards';
    } else {
        bdBtn.classList.remove('disabled');
        bdBtn.title = '';
    }
}

async function loadBreakdownTab() {
    if (!currentEvent) return;
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
        startBdListRefresh();
    } catch (err) {
        alert(`Error loading matches: ${err.message}`);
    }
}

// ── Periodic match-list refresh (updates has_breakdown flags) ──
function startBdListRefresh() {
    stopBdListRefresh();
    bdListTimer = setInterval(refreshBdList, BD_LIST_REFRESH);
}
function stopBdListRefresh() {
    if (bdListTimer) { clearInterval(bdListTimer); bdListTimer = null; }
}
async function refreshBdList() {
    if (!currentEvent) return;
    try {
        const fresh = await API.allMatches(currentEvent);
        // Merge updated has_breakdown flags into existing data
        if (fresh && fresh.matches && bdData && bdData.matches) {
            const keyMap = {};
            fresh.matches.forEach(m => { keyMap[m.key] = m; });
            let changed = false;
            bdData.matches.forEach(m => {
                const fm = keyMap[m.key];
                if (fm && fm.has_breakdown && !m.has_breakdown) {
                    m.has_breakdown = true;
                    changed = true;
                }
            });
            if (changed) buildBdSelector();
        }
    } catch (_) { /* silent */ }
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
    stopBdPolling();
    closeSpotlight();  // clear spotlight when switching matches
    const m = bdData.matches[bdIndex];
    $('bd-match-label').textContent = m.label;
    $('bd-match-select').value = bdIndex;

    // Always try fetching from TBA (bypass cache on backend) — don't rely on stale has_breakdown flag
    $('bd-status').innerHTML = '<span style="color:var(--text-muted)">Loading breakdown…</span>';
    $('bd-content').innerHTML = '';

    try {
        const data = await API.matchBreakdown(m.key);
        if (data.available) {
            m.has_breakdown = true;   // update local flag
            bdCache[m.key] = data;
            renderBreakdown(data);
            stopBdPolling();
            return;
        }
    } catch (_) { /* will fall through to pending state */ }

    // Breakdown not available yet — show waiting state and start polling
    $('bd-status').innerHTML = '<span class="bd-unavailable">⏳ Waiting for score breakdown… <span class="bd-poll-dot"></span></span>';
    $('bd-content').innerHTML = '';
    startBdPolling();
}

// ── Breakdown auto-polling ────────────────────────────────
function startBdPolling() {
    stopBdPolling();
    bdPollTimer = setInterval(pollBdMatch, BD_POLL_INTERVAL);
}

function stopBdPolling() {
    if (bdPollTimer) { clearInterval(bdPollTimer); bdPollTimer = null; }
}

async function pollBdMatch() {
    if (!bdData || !bdData.matches.length) return;
    const m = bdData.matches[bdIndex];
    try {
        const data = await API.matchBreakdown(m.key);
        if (data.available) {
            m.has_breakdown = true;
            bdCache[m.key] = data;
            stopBdPolling();
            renderBreakdown(data);
            // Flash the status briefly to signal live update
            const statusEl = $('bd-status');
            statusEl.innerHTML = '<span class="bd-available">✓ Score breakdown available — just posted!</span>';
            setTimeout(() => {
                if (statusEl.querySelector('.bd-available'))
                    statusEl.innerHTML = '<span class="bd-available">✓ Score breakdown available</span>';
            }, 4000);
            buildBdSelector(); // update ● / ○ indicators
        }
    } catch (_) { /* keep polling */ }
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

    const renderFn = (data.game_year >= 2026) ? renderBdAlliance2026 : renderBdAlliance;

    $('bd-content').innerHTML = `
        ${renderFn(data.red, 'red', redWon, nickMap)}
        ${renderFn(data.blue, 'blue', blueWon, nickMap)}
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
            <span>${title}</span>`
        : `<span>${title}</span>
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
                ${bd.robots.map(r => renderBdRobot(r, nickMap, color)).join('')}
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

function renderBdRobot(robot, nickMap, color) {
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
    <div class="bd-robot-card" data-team="${num}" data-color="${color}">
        <div class="bd-robot-num has-tooltip bd-spotlight-trigger" onclick="toggleSpotlight(${num}, '${color}')">${num}${tooltipHtml}</div>
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


// ═══════════════════════════════════════════════════════════
//  2026 GAME — BREAKDOWN RENDERER
// ═══════════════════════════════════════════════════════════

function renderBdAlliance2026(alliance, color, won, nickMap) {
    const bd = alliance.breakdown;
    const sideCls = color === 'red' ? 'red-side' : 'blue-side';
    const title = color === 'red' ? 'Red Alliance' : 'Blue Alliance';

    const headerContent = color === 'blue'
        ? `<div class="bd-alliance-score-group">
                <span class="bd-alliance-score">${alliance.score}</span>
                ${won ? '<span class="bd-winner-label">WINNER</span>' : ''}
            </div>
            <span>${title}</span>`
        : `<span>${title}</span>
            <div class="bd-alliance-score-group">
                ${won ? '<span class="bd-winner-label">WINNER</span>' : ''}
                <span class="bd-alliance-score">${alliance.score}</span>
            </div>`;

    // Build fuel shift rows for teleop
    const shiftRows = [
        { label: 'Transition Shift', count: bd.transitionFuelCount, pts: bd.transitionFuelPoints },
        { label: 'Shift 1', count: bd.shift1FuelCount, pts: bd.shift1FuelPoints },
        { label: 'Shift 2', count: bd.shift2FuelCount, pts: bd.shift2FuelPoints },
        { label: 'Shift 3', count: bd.shift3FuelCount, pts: bd.shift3FuelPoints },
        { label: 'Shift 4', count: bd.shift4FuelCount, pts: bd.shift4FuelPoints },
        { label: 'Endgame Fuel', count: bd.endgameFuelCount, pts: bd.endgameFuelPoints },
    ];

    const penaltyStr = bd.penalties && bd.penalties !== 'None' ? bd.penalties : '';

    return `
    <div class="bd-alliance ${sideCls}">
        <div class="bd-alliance-header">
            ${headerContent}
        </div>

        <!-- Per-robot: Auto Tower + Endgame Tower -->
        <div class="bd-section">
            <div class="bd-section-title">Per-Team Performance</div>
            <div class="bd-robots">
                ${bd.robots.map(r => renderBdRobot2026(r, nickMap, color)).join('')}
            </div>
        </div>

        <!-- Autonomous -->
        <div class="bd-section">
            <div class="bd-section-title">Autonomous (${bd.totalAutoPoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Tower Points</span>
                    <span class="bd-stat-value">${bd.autoTowerPoints}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Fuel Scored</span>
                    <span class="bd-stat-value">${bd.autoFuelCount}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Fuel Points</span>
                    <span class="bd-stat-value">${bd.autoFuelPoints}</span>
                </div>
            </div>
        </div>

        <!-- Teleop -->
        <div class="bd-section">
            <div class="bd-section-title">Teleop (${bd.totalTeleopPoints} pts)</div>
            <div class="bd-stats">
                ${shiftRows.map(s => `
                <div class="bd-stat-row">
                    <span class="bd-stat-label">${s.label}</span>
                    <span class="bd-stat-value">${s.count} fuel · ${s.pts} pts</span>
                </div>`).join('')}
                <div class="bd-stat-row" style="border-top:1px solid var(--border);padding-top:.3rem;margin-top:.2rem">
                    <span class="bd-stat-label"><strong>Total Teleop Fuel</strong></span>
                    <span class="bd-stat-value"><strong>${bd.teleopFuelCount}</strong></span>
                </div>
            </div>
        </div>

        <!-- Tower -->
        <div class="bd-section">
            <div class="bd-section-title">Tower (${bd.totalTowerPoints} pts)</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Auto Tower Points</span>
                    <span class="bd-stat-value">${bd.autoTowerPoints}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Endgame Tower Points</span>
                    <span class="bd-stat-value">${bd.endGameTowerPoints}</span>
                </div>
            </div>
        </div>

        <!-- Fouls -->
        <div class="bd-section">
            <div class="bd-section-title">Fouls & Penalties</div>
            <div class="bd-fouls">
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Minor:</span>
                    <span class="bd-foul-value">${bd.minorFoulCount}</span>
                </div>
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Major:</span>
                    <span class="bd-foul-value">${bd.majorFoulCount}</span>
                </div>
                <div class="bd-foul-item">
                    <span class="bd-foul-label">Foul Pts:</span>
                    <span class="bd-foul-value">+${bd.foulPoints}</span>
                </div>
            </div>
            ${bd.g206Penalty || penaltyStr ? `
                <div class="bd-bonuses" style="margin-top:.3rem">
                    ${bd.g206Penalty ? '<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">G206</span>' : ''}
                    ${penaltyStr ? `<span class="bd-bonus-badge" style="border-color:rgba(239,68,68,.4);color:#ef4444">${penaltyStr}</span>` : ''}
                </div>
            ` : ''}
        </div>

        <!-- Fuel Summary -->
        <div class="bd-section">
            <div class="bd-section-title">Fuel Summary</div>
            <div class="bd-stats">
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Total Fuel Scored</span>
                    <span class="bd-stat-value">${bd.totalFuelCount}</span>
                </div>
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Total Fuel Points</span>
                    <span class="bd-stat-value">${bd.totalFuelPoints}</span>
                </div>
                ${bd.uncountedFuel ? `
                <div class="bd-stat-row">
                    <span class="bd-stat-label">Uncounted Fuel</span>
                    <span class="bd-stat-value">${bd.uncountedFuel}</span>
                </div>` : ''}
            </div>
        </div>

        <!-- RP Progress -->
        <div class="bd-section">
            <div class="bd-section-title">Ranking Points</div>
            <div class="bd-bonuses">
                <span class="bd-bonus-badge ${bd.energizedAchieved ? 'achieved' : ''}">⚡ Energized</span>
                <span class="bd-bonus-badge ${bd.superchargedAchieved ? 'achieved' : ''}">🔋 Supercharged</span>
                <span class="bd-bonus-badge ${bd.traversalAchieved ? 'achieved' : ''}">🗼 Traversal</span>
            </div>
            ${renderRpProgress(bd)}
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

function renderBdRobot2026(robot, nickMap, color) {
    const autoVal = robot.autoTower || 'None';
    const autoCls = autoVal === 'Leave' ? 'yes' : 'no';
    const autoLabel = autoVal === 'None' ? 'None' : autoVal;

    const endVal = robot.endGameTower || 'None';
    const endMap = {
        'None':   { label: 'None',   cls: 'no' },
        'Park':   { label: 'Park',   cls: 'parked' },
        'Shallow':{ label: 'Shallow', cls: 'shallow' },
        'Deep':   { label: 'Deep',   cls: 'deep' },
    };
    const eg = endMap[endVal] || { label: endVal, cls: '' };

    const num = robot.team_number || '?';
    const nick = (nickMap && nickMap[num]) || '';
    const tooltipHtml = nick ? `<span class="custom-tooltip">${nick}</span>` : '';

    return `
    <div class="bd-robot-card" data-team="${num}" data-color="${color}">
        <div class="bd-robot-num has-tooltip bd-spotlight-trigger" onclick="toggleSpotlight(${num}, '${color}')">${num}${tooltipHtml}</div>
        <div class="bd-robot-field">
            <span class="bd-robot-label">Auto Tower</span>
            <span class="bd-robot-value ${autoCls}">${autoLabel}</span>
        </div>
        <div class="bd-robot-field">
            <span class="bd-robot-label">Endgame</span>
            <span class="bd-robot-value ${eg.cls}">${eg.label}</span>
        </div>
    </div>`;
}

function renderRpProgress(bd) {
    const bars = [
        { label: 'Energized',    current: bd.totalPoints, threshold: 100, achieved: bd.energizedAchieved },
        { label: 'Supercharged', current: bd.totalPoints, threshold: 360, achieved: bd.superchargedAchieved },
        { label: 'Traversal',    current: bd.totalTowerPoints, threshold: 50, achieved: bd.traversalAchieved },
    ];

    return `<div class="bd-rp-progress">
        ${bars.map(b => {
            const pct = Math.min(100, (b.current / b.threshold) * 100);
            const cls = b.achieved ? 'rp-bar-achieved' : '';
            return `
            <div class="rp-progress-row">
                <span class="rp-progress-label">${b.label}</span>
                <div class="rp-progress-track">
                    <div class="rp-progress-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
                </div>
                <span class="rp-progress-text">${b.current} / ${b.threshold}</span>
            </div>`;
        }).join('')}
    </div>`;
}


// ═══════════════════════════════════════════════════════════
//  TEAM SPOTLIGHT — Focus on a single team in breakdown
// ═══════════════════════════════════════════════════════════

let _spotlightTeam = null;  // currently spotlighted team number

function toggleSpotlight(teamNum, color) {
    const panel = $('bd-spotlight');
    if (!panel) return;

    if (_spotlightTeam === teamNum) { closeSpotlight(); return; }
    _spotlightTeam = teamNum;

    const m = bdData && bdData.matches ? bdData.matches[bdIndex] : null;
    const bd = bdCache[m?.key];
    if (!bd) return;

    const alliance = bd[color];
    if (!alliance) return;
    const abdwn = alliance.breakdown;
    const robot = abdwn.robots.find(r => r.team_number === teamNum);
    if (!robot) return;

    // Nickname
    const nickMap = {};
    if (m) {
        for (const side of ['red', 'blue']) {
            if (m[side] && m[side].teams)
                m[side].teams.forEach(t => { if (t.nickname) nickMap[t.team_number] = t.nickname; });
        }
    }
    const nick = nickMap[teamNum] || '';

    const colorLabel = color === 'red' ? 'Red Alliance' : 'Blue Alliance';

    // Show loading state with header immediately
    panel.innerHTML = `
        <div class="spotlight-card spotlight-${color}">
            <div class="spotlight-header">
                <div class="spotlight-team-info">
                    <span class="spotlight-team-num">${teamNum}</span>
                    ${nick ? `<span class="spotlight-team-nick">${nick}</span>` : ''}
                    <span class="spotlight-alliance-badge spotlight-badge-${color}">${colorLabel}</span>
                </div>
                <button class="spotlight-close" onclick="closeSpotlight()" title="Close Spotlight">&times;</button>
            </div>
            <div class="spotlight-loading">Loading individual performance…</div>
        </div>`;

    panel.classList.remove('hidden');

    // Highlight/dim robot cards
    document.querySelectorAll('.bd-robot-card').forEach(card => {
        const cardTeam = parseInt(card.dataset.team);
        if (cardTeam === teamNum) {
            card.classList.add('bd-spotlight-active');
            card.classList.remove('bd-spotlight-dimmed');
        } else {
            card.classList.remove('bd-spotlight-active');
            card.classList.add('bd-spotlight-dimmed');
        }
    });

    // Determine the current match identification for highlighting
    const currentMatchNum = m?.match_number || 0;
    const currentCompLevel = m?.comp_level || 'qm';
    const frcLevel = currentCompLevel === 'qm' ? 'Qualification' : 'Playoff';

    // Fetch individual performance data from FRC Events API
    const eventKey = currentEvent;
    if (!eventKey) return;

    API.teamPerf(eventKey, teamNum).then(perf => {
        if (_spotlightTeam !== teamNum) return;  // user closed or switched

        _renderSpotlightContent(panel, perf, robot, bd.game_year, color, nick, teamNum, colorLabel, frcLevel, currentMatchNum);
    }).catch(err => {
        if (_spotlightTeam !== teamNum) return;
        // Fallback: show just the current-match per-robot data
        _renderSpotlightFallback(panel, robot, bd.game_year, color, nick, teamNum, colorLabel);
    });
}

function _towerBadge(val) {
    const cls = {
        'None': 'tower-none', 'Level1': 'tower-level1',
        'Level2': 'tower-level2', 'Level3': 'tower-level3',
    }[val] || 'tower-none';
    const label = {
        'None': '—', 'Level1': 'L1', 'Level2': 'L2', 'Level3': 'L3',
    }[val] || val;
    return `<span class="tower-badge ${cls}">${label}</span>`;
}

function _renderSpotlightContent(panel, perf, robot, gameYear, color, nick, teamNum, colorLabel, frcLevel, currentMatchNum) {
    let html = '';

    if (gameYear >= 2026) {
        // ── Current match individual data ──
        const autoTower = robot.autoTower || 'None';
        const endTower = robot.endGameTower || 'None';

        html += `
            <div class="spotlight-section">
                <div class="spotlight-section-title">This Match — Individual</div>
                <div class="spotlight-featured">
                    <div class="spotlight-feat-cell">
                        ${_towerBadge(autoTower)}
                        <span class="spotlight-feat-lbl">Auto Tower</span>
                    </div>
                    <div class="spotlight-feat-cell">
                        ${_towerBadge(endTower)}
                        <span class="spotlight-feat-lbl">Endgame Tower</span>
                    </div>
                </div>
            </div>`;

        // ── Aggregate performance across event ──
        if (perf.matches_played > 0) {
            const rec = perf.record;
            const winPct = perf.matches_played > 0 ? Math.round((rec.wins / perf.matches_played) * 100) : 0;

            html += `
            <div class="spotlight-section">
                <div class="spotlight-section-title">Event Performance — ${perf.matches_played} Matches</div>
                <div class="spotlight-stats-grid">
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${rec.wins}-${rec.losses}${rec.ties ? `-${rec.ties}` : ''}</span>
                        <span class="spotlight-stat-lbl">Record</span>
                    </div>
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${winPct}%</span>
                        <span class="spotlight-stat-lbl">Win Rate</span>
                    </div>
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${perf.avg_alliance_score}</span>
                        <span class="spotlight-stat-lbl">Avg Alliance Pts</span>
                    </div>
                </div>
                <div style="margin-top: .4rem;">
                    <div class="spotlight-bar-row">
                        <span class="spotlight-bar-label">Auto Tower</span>
                        <div class="spotlight-bar-track">
                            <div class="spotlight-bar-fill spotlight-bar-fill-green" style="width: ${perf.autoTower.activeRate}%"></div>
                        </div>
                        <span class="spotlight-bar-value">${perf.autoTower.activeRate}%</span>
                    </div>
                    <div class="spotlight-bar-row">
                        <span class="spotlight-bar-label">End Tower</span>
                        <div class="spotlight-bar-track">
                            <div class="spotlight-bar-fill spotlight-bar-fill-purple" style="width: ${perf.endGameTower.activeRate}%"></div>
                        </div>
                        <span class="spotlight-bar-value">${perf.endGameTower.activeRate}%</span>
                    </div>
                </div>
            </div>`;
        }

        // ── Match-by-match history ──
        if (perf.matches && perf.matches.length > 0) {
            let rows = '';
            for (const pm of perf.matches) {
                const isCurrent = pm.matchLevel === frcLevel && pm.matchNumber === currentMatchNum;
                const rowCls = isCurrent ? 'current-match' : '';
                const score = pm.allianceScore != null ? `${pm.allianceScore}-${pm.opponentScore}` : '—';
                rows += `<tr class="${rowCls}">
                    <td>${pm.description}</td>
                    <td><span class="result-badge result-${pm.result}">${pm.result}</span></td>
                    <td>${score}</td>
                    <td>${_towerBadge(pm.autoTower)}</td>
                    <td>${_towerBadge(pm.endGameTower)}</td>
                </tr>`;
            }

            html += `
            <div class="spotlight-section">
                <div class="spotlight-section-title">Match History</div>
                <table class="spotlight-matches-table">
                    <thead><tr>
                        <th>Match</th><th></th><th>Score</th><th>Auto</th><th>End</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        }
    } else {
        // 2025 REEFSCAPE
        const leave = robot.autoLine === 'Yes' ? 'Yes' : 'No';
        const leaveCls = robot.autoLine === 'Yes' ? 'yes' : 'no';
        const endGameMap = {
            'DeepCage': { label: 'Deep Cage', cls: 'deep' },
            'ShallowCage': { label: 'Shallow Cage', cls: 'shallow' },
            'Parked': { label: 'Parked', cls: 'parked' },
            'None': { label: 'None', cls: 'no' },
        };
        const eg = endGameMap[robot.endGame] || { label: robot.endGame, cls: '' };

        html += `
            <div class="spotlight-section">
                <div class="spotlight-section-title">This Match — Individual</div>
                <div class="spotlight-featured">
                    <div class="spotlight-feat-cell">
                        <span class="spotlight-feat-val bd-robot-value ${leaveCls}">${leave}</span>
                        <span class="spotlight-feat-lbl">Auto Leave</span>
                    </div>
                    <div class="spotlight-feat-cell">
                        <span class="spotlight-feat-val bd-robot-value ${eg.cls}">${eg.label}</span>
                        <span class="spotlight-feat-lbl">Endgame</span>
                    </div>
                </div>
            </div>`;

        // Event performance if we have it
        if (perf.matches_played > 0) {
            const rec = perf.record;
            const winPct = Math.round((rec.wins / perf.matches_played) * 100);
            html += `
            <div class="spotlight-section">
                <div class="spotlight-section-title">Event Performance — ${perf.matches_played} Matches</div>
                <div class="spotlight-stats-grid">
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${rec.wins}-${rec.losses}${rec.ties ? `-${rec.ties}` : ''}</span>
                        <span class="spotlight-stat-lbl">Record</span>
                    </div>
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${winPct}%</span>
                        <span class="spotlight-stat-lbl">Win Rate</span>
                    </div>
                    <div class="spotlight-stat-cell">
                        <span class="spotlight-stat-val">${perf.avg_alliance_score}</span>
                        <span class="spotlight-stat-lbl">Avg Alliance Pts</span>
                    </div>
                </div>
            </div>`;
        }
    }

    // Re-render the card with real data
    panel.innerHTML = `
        <div class="spotlight-card spotlight-${color}">
            <div class="spotlight-header">
                <div class="spotlight-team-info">
                    <span class="spotlight-team-num">${teamNum}</span>
                    ${nick ? `<span class="spotlight-team-nick">${nick}</span>` : ''}
                    <span class="spotlight-alliance-badge spotlight-badge-${color}">${colorLabel}</span>
                </div>
                <button class="spotlight-close" onclick="closeSpotlight()" title="Close Spotlight">&times;</button>
            </div>
            ${html}
        </div>`;
}

function _renderSpotlightFallback(panel, robot, gameYear, color, nick, teamNum, colorLabel) {
    let html = '';

    if (gameYear >= 2026) {
        const autoTower = robot.autoTower || 'None';
        const endTower = robot.endGameTower || 'None';

        html = `
            <div class="spotlight-section">
                <div class="spotlight-section-title">This Match — Individual</div>
                <div class="spotlight-featured">
                    <div class="spotlight-feat-cell">
                        ${_towerBadge(autoTower)}
                        <span class="spotlight-feat-lbl">Auto Tower</span>
                    </div>
                    <div class="spotlight-feat-cell">
                        ${_towerBadge(endTower)}
                        <span class="spotlight-feat-lbl">Endgame Tower</span>
                    </div>
                </div>
            </div>
            <div class="spotlight-section" style="text-align:center; padding:.6rem;">
                <span style="font-size:.7rem; color:var(--text-muted);">FRC Events API unavailable — showing current match only</span>
            </div>`;
    } else {
        const leave = robot.autoLine === 'Yes' ? 'Yes' : 'No';
        const leaveCls = robot.autoLine === 'Yes' ? 'yes' : 'no';
        const endGameMap = {
            'DeepCage': { label: 'Deep Cage', cls: 'deep' },
            'ShallowCage': { label: 'Shallow Cage', cls: 'shallow' },
            'Parked': { label: 'Parked', cls: 'parked' },
            'None': { label: 'None', cls: 'no' },
        };
        const eg = endGameMap[robot.endGame] || { label: robot.endGame, cls: '' };

        html = `
            <div class="spotlight-section">
                <div class="spotlight-section-title">This Match — Individual</div>
                <div class="spotlight-featured">
                    <div class="spotlight-feat-cell">
                        <span class="spotlight-feat-val bd-robot-value ${leaveCls}">${leave}</span>
                        <span class="spotlight-feat-lbl">Auto Leave</span>
                    </div>
                    <div class="spotlight-feat-cell">
                        <span class="spotlight-feat-val bd-robot-value ${eg.cls}">${eg.label}</span>
                        <span class="spotlight-feat-lbl">Endgame</span>
                    </div>
                </div>
            </div>`;
    }

    panel.innerHTML = `
        <div class="spotlight-card spotlight-${color}">
            <div class="spotlight-header">
                <div class="spotlight-team-info">
                    <span class="spotlight-team-num">${teamNum}</span>
                    ${nick ? `<span class="spotlight-team-nick">${nick}</span>` : ''}
                    <span class="spotlight-alliance-badge spotlight-badge-${color}">${colorLabel}</span>
                </div>
                <button class="spotlight-close" onclick="closeSpotlight()" title="Close Spotlight">&times;</button>
            </div>
            ${html}
        </div>`;
}

function closeSpotlight() {
    _spotlightTeam = null;
    const panel = $('bd-spotlight');
    if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
    document.querySelectorAll('.bd-robot-card').forEach(card => {
        card.classList.remove('bd-spotlight-active', 'bd-spotlight-dimmed');
    });
}


// ═══════════════════════════════════════════════════════════
// 8. TEAM COMPARISON
// ═══════════════════════════════════════════════════════════

let compareSelection = new Set();  // team_keys selected from rankings table


// ── Open / Close ───────────────────────────────────────────
function openCompare() {
    show('compare-overlay');
    document.body.style.overflow = 'hidden';
}

function closeCompare() {
    hide('compare-overlay');
    document.body.style.overflow = '';
}

// Close on Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('compare-overlay')?.classList.contains('hidden')) {
        closeCompare();
    }
});

// ── Auto-compare from PBP match ────────────────────────────
async function compareCurrentMatch() {
    if (!pbpData || !pbpData.matches.length || !currentEvent) return;
    const m = pbpData.matches[pbpIndex];
    const redKeys = m.red.teams.map(t => t.team_key);
    const blueKeys = m.blue.teams.map(t => t.team_key);
    const allKeys = [...redKeys, ...blueKeys];

    // Try API first; if it fails (e.g. upcoming event with no matches),
    // build comparison from the local PBP data we already have
    openCompare();
    $('compare-body').innerHTML = '<p class="loading-msg">Fetching comparison data\u2026</p>';
    $('compare-title').textContent = `Match Comparison \u2014 ${m.label}`;

    try {
        const data = await API.compareTeams(currentEvent, allKeys);
        renderComparison(data, { redKeys, blueKeys, matchLabel: m.label });
    } catch {
        // Fallback: build comparison data from PBP team objects
        const fallbackTeams = allKeys.map(tk => {
            const t = [...m.red.teams, ...m.blue.teams].find(x => x.team_key === tk) || {};
            return {
                team_key: tk,
                team_number: t.team_number || parseInt(tk.replace('frc', '')),
                nickname: t.nickname || '',
                city: t.city || '',
                state_prov: t.state_prov || '',
                country: t.country || '',
                rank: t.rank || '-',
                wins: t.wins || 0,
                losses: t.losses || 0,
                ties: t.ties || 0,
                opr: t.opr || 0,
                dpr: t.dpr || 0,
                ccwm: 0,
                avg_rp: t.avg_rp || 0,
                qual_average: t.qual_average || 0,
                high_score: t.high_score || 0,
                matches_played: 0,
            };
        });
        renderComparison(
            { event_key: currentEvent, teams: fallbackTeams },
            { redKeys, blueKeys, matchLabel: m.label }
        );
    }
}

// ── Compare from rankings selection ────────────────────────

// Clicking anywhere on a rankings row toggles comparison selection
document.addEventListener('click', (e) => {
    const tr = e.target.closest('.data-table tbody tr');
    if (!tr) return;
    // Don't double-fire on the checkbox itself
    if (e.target.closest('.compare-cb')) return;
    const cb = tr.querySelector('.compare-cb');
    if (cb) {
        toggleCompareTeam(cb.dataset.team);
    }
});

function toggleCompareTeam(teamKey) {
    if (compareSelection.has(teamKey)) {
        compareSelection.delete(teamKey);
    } else {
        if (compareSelection.size >= 6) return;  // max 6
        compareSelection.add(teamKey);
    }
    updateCompareBar();
    updateCompareCheckboxes();
}

function updateCompareBar() {
    const n = compareSelection.size;
    if (n > 0) {
        show('compare-bar');
        $('compare-bar-count').textContent = `${n} team${n > 1 ? 's' : ''} selected`;
    } else {
        hide('compare-bar');
    }
}

function updateCompareCheckboxes() {
    document.querySelectorAll('.compare-cb').forEach(cb => {
        cb.checked = compareSelection.has(cb.dataset.team);
    });
}

function clearCompareSelection() {
    compareSelection.clear();
    updateCompareBar();
    updateCompareCheckboxes();
}

async function launchCompareFromSelection() {
    if (compareSelection.size < 2 || !currentEvent) return;
    const keys = [...compareSelection];
    await showComparison(keys, {});
}

// ── Core comparison renderer ───────────────────────────────
async function showComparison(teamKeys, opts = {}) {
    openCompare();
    $('compare-body').innerHTML = '<p class="loading-msg">Fetching comparison data\u2026</p>';
    $('compare-title').textContent = opts.matchLabel
        ? `Match Comparison \u2014 ${opts.matchLabel}`
        : 'Team Comparison';

    try {
        const data = await API.compareTeams(currentEvent, teamKeys);
        renderComparison(data, opts);
    } catch (err) {
        // Fallback: use cached teamsData from the rankings table if available
        if (teamsData) {
            const fallbackTeams = teamKeys.map(tk => {
                const t = teamsData.find(x => x.team_key === tk) || {};
                return {
                    team_key: tk,
                    team_number: t.team_number || parseInt(tk.replace('frc', '')),
                    nickname: t.nickname || '',
                    city: t.city || '',
                    state_prov: t.state_prov || '',
                    country: t.country || '',
                    rank: t.rank || '-',
                    wins: t.wins || 0,
                    losses: t.losses || 0,
                    ties: t.ties || 0,
                    opr: t.opr || 0,
                    dpr: t.dpr || 0,
                    ccwm: t.ccwm || 0,
                    avg_rp: 0,
                    qual_average: 0,
                    high_score: 0,
                    matches_played: 0,
                };
            });
            renderComparison({ event_key: currentEvent, teams: fallbackTeams }, opts);
        } else {
            $('compare-body').innerHTML = `<p class="empty">Error: ${err.message}</p>`;
        }
    }
}

function renderComparison(data, opts) {
    const teams = data.teams;
    const redKeys = new Set(opts.redKeys || []);
    const blueKeys = new Set(opts.blueKeys || []);
    const isMatchMode = redKeys.size > 0;

    const stats = [
        { key: 'rank',         label: 'Rank',       fmt: v => v === '-' ? '—' : `#${v}`, lower: true },
        { key: 'opr',          label: 'OPR',        fmt: v => v.toFixed(2) },
        { key: 'dpr',          label: 'DPR',        fmt: v => v.toFixed(2), lower: true },
        { key: 'ccwm',         label: 'CCWM',       fmt: v => v.toFixed(2) },
        { key: 'wins',         label: 'Wins',       fmt: v => v },
        { key: 'losses',       label: 'Losses',     fmt: v => v, lower: true },
        { key: 'qual_average', label: 'Avg Score',  fmt: v => v.toFixed(1) },
        { key: 'high_score',   label: 'High Score', fmt: v => v },
        { key: 'avg_rp',       label: 'Avg RP',     fmt: v => v.toFixed(2) },
    ];

    // Compute max values for bar widths
    const maxVals = {};
    stats.forEach(s => {
        const vals = teams.map(t => {
            const v = t[s.key];
            return typeof v === 'number' ? v : 0;
        });
        maxVals[s.key] = Math.max(...vals, 0.01);
    });

    // Header
    let html = '<div class="compare-grid" style="--cols:' + teams.length + '">';

    // Team header row
    html += '<div class="comp-label comp-corner"></div>';
    teams.forEach(t => {
        let sideCls = '';
        if (redKeys.has(t.team_key)) sideCls = 'comp-red';
        else if (blueKeys.has(t.team_key)) sideCls = 'comp-blue';
        const loc = [t.city, t.state_prov].filter(Boolean).join(', ');
        html += `
        <div class="comp-header ${sideCls}">
            <div class="comp-team-num">${t.team_number}</div>
            <div class="comp-team-name">${formatTeamName(t.nickname)}</div>
            <div class="comp-team-record">${t.wins}-${t.losses}-${t.ties}</div>
            ${loc ? `<div class="comp-team-loc">${loc}</div>` : ''}
        </div>`;
    });

    // Stat rows
    stats.forEach(s => {
        const vals = teams.map(t => {
            const v = t[s.key];
            return typeof v === 'number' ? v : 0;
        });
        const best = s.lower
            ? Math.min(...vals.filter(v => v > 0 || s.key === 'losses' || s.key === 'dpr'))
            : Math.max(...vals);

        html += `<div class="comp-label">${s.label}</div>`;
        teams.forEach((t, i) => {
            const raw = t[s.key];
            const v = typeof raw === 'number' ? raw : 0;
            const display = s.fmt(raw);
            const isBest = teams.length > 1 && v === best && (v !== 0 || s.key === 'losses' || s.key === 'dpr');
            const pct = maxVals[s.key] > 0 ? Math.round((v / maxVals[s.key]) * 100) : 0;

            let sideCls = '';
            if (redKeys.has(t.team_key)) sideCls = 'comp-red';
            else if (blueKeys.has(t.team_key)) sideCls = 'comp-blue';

            html += `
            <div class="comp-cell ${sideCls} ${isBest ? 'comp-best' : ''}">
                <div class="comp-bar-bg">
                    <div class="comp-bar" style="width:${pct}%"></div>
                </div>
                <span class="comp-val">${display}</span>
            </div>`;
        });
    });

    // Alliance totals row for match mode
    if (isMatchMode) {
        const allianceStats = ['opr', 'dpr', 'ccwm'];
        html += '<div class="comp-divider" style="grid-column: 1 / -1"></div>';
        allianceStats.forEach(key => {
            const label = key.toUpperCase();
            const redSum = teams.filter(t => redKeys.has(t.team_key)).reduce((s, t) => s + (t[key] || 0), 0);
            const blueSum = teams.filter(t => blueKeys.has(t.team_key)).reduce((s, t) => s + (t[key] || 0), 0);
            const maxSum = Math.max(redSum, blueSum, 0.01);

            html += `<div class="comp-label comp-label-total">Σ ${label}</div>`;

            // Red teams cells + blue teams cells for the sum row
            const redTeamCount = teams.filter(t => redKeys.has(t.team_key)).length;
            const blueTeamCount = teams.filter(t => blueKeys.has(t.team_key)).length;

            // Red sum spans across red columns
            const redPct = Math.round((redSum / maxSum) * 100);
            const bluePct = Math.round((blueSum / maxSum) * 100);
            const redBest = redSum >= blueSum && key !== 'dpr' || redSum <= blueSum && key === 'dpr';
            const blueBest = !redBest;

            // Output one cell per team, but show the sum only in the middle cell of each alliance
            teams.forEach((t, i) => {
                const isRed = redKeys.has(t.team_key);
                const isBlue = blueKeys.has(t.team_key);
                const redTeams = teams.filter(t2 => redKeys.has(t2.team_key));
                const blueTeams = teams.filter(t2 => blueKeys.has(t2.team_key));
                const midRedIdx = teams.indexOf(redTeams[Math.floor(redTeams.length / 2)]);
                const midBlueIdx = teams.indexOf(blueTeams[Math.floor(blueTeams.length / 2)]);

                if (i === midRedIdx) {
                    html += `<div class="comp-cell comp-red comp-total ${redBest ? 'comp-best' : ''}">
                        <div class="comp-bar-bg"><div class="comp-bar" style="width:${redPct}%"></div></div>
                        <span class="comp-val">${redSum.toFixed(2)}</span>
                    </div>`;
                } else if (i === midBlueIdx) {
                    html += `<div class="comp-cell comp-blue comp-total ${blueBest ? 'comp-best' : ''}">
                        <div class="comp-bar-bg"><div class="comp-bar" style="width:${bluePct}%"></div></div>
                        <span class="comp-val">${blueSum.toFixed(2)}</span>
                    </div>`;
                } else {
                    const cls = isRed ? 'comp-red' : isBlue ? 'comp-blue' : '';
                    html += `<div class="comp-cell ${cls} comp-total-empty"></div>`;
                }
            });
        });
    }

    html += '</div>';
    $('compare-body').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
//  Region & Event History tab
// ═══════════════════════════════════════════════════════════

async function loadHistory() {
    if (!currentEvent) return;
    hide('history-empty');
    show('history-loading');
    hide('history-container');

    try {
        // Region facts load instantly from static JSON; event history is dynamic
        const [regionResult, historyResult] = await Promise.all([
            eventRegion ? API.regionFacts(eventRegion).catch(() => null) : Promise.resolve(null),
            API.eventHistory(currentEvent).catch(() => null),
        ]);

        regionData = regionResult;
        historyData = historyResult;

        hide('history-loading');
        show('history-container');

        renderRegionFacts(regionData);
        renderEventHistory(historyData);

        renderedTabs.history = true;
    } catch (err) {
        hide('history-loading');
        show('history-empty');
        console.error('History load error:', err);
    }
}


// ── Region Facts panel ─────────────────────────────────────
function renderRegionFacts(data) {
    const title = $('history-region-title');
    const body = $('history-region-body');
    if (!data) {
        title.textContent = 'Region Facts';
        body.innerHTML = '<p class="empty">No region data available.</p>';
        return;
    }

    title.textContent = `${eventRegion}`;

    // Stats cards row
    let html = '<div class="history-stats-row">';
    html += _statCard('First Event', `${data.first_event_year || '—'}`, data.first_event_name || '');
    html += _statCard('Total Events', `${data.total_events}`, `${(data.active_years || []).length} seasons`);
    html += _statCard('Active Teams', `${data.current_season_teams || data.team_count}`, `${data.active_year || new Date().getFullYear()} season`);
    html += _statCard('Hall of Fame', `${data.hof_count}`, data.hof_count ? data.hof_teams.map(t => t.team_number).join(', ') : 'none yet');
    html += _statCard('Einstein Teams', `${data.einstein_count}`, data.einstein_count ? `top: ${data.einstein_teams.slice(0,3).map(t => t.team_number).join(', ')}` : 'none yet');
    html += '</div>';

    // HoF teams detail
    if (data.hof_teams && data.hof_teams.length) {
        html += '<div class="history-detail-section">';
        html += '<h4>Hall of Fame Teams</h4>';
        html += '<div class="history-team-chips">';
        for (const t of data.hof_teams) {
            html += `<span class="history-chip hof-chip">${t.team_number} <span class="chip-name">${_esc(t.nickname)}</span> <span class="chip-years">${t.years.join(', ')}</span></span>`;
        }
        html += '</div></div>';
    }

    // Impact finalists
    if (data.impact_finalists && data.impact_finalists.length) {
        html += '<div class="history-detail-section">';
        html += '<h4>Impact Award Finalists</h4>';
        html += '<div class="history-team-chips">';
        for (const t of data.impact_finalists) {
            html += `<span class="history-chip impact-chip">${t.team_number} <span class="chip-name">${_esc(t.nickname)}</span> <span class="chip-years">${t.years.join(', ')}</span></span>`;
        }
        html += '</div></div>';
    }

    // Einstein teams (top 10)
    if (data.einstein_teams && data.einstein_teams.length) {
        html += '<div class="history-detail-section">';
        html += '<h4>Einstein Appearances</h4>';
        html += '<table class="data-table history-table"><thead><tr><th>#</th><th>Team</th><th>Apps</th><th>Years</th></tr></thead><tbody>';
        const einsteinSlice = data.einstein_teams.slice(0, 15);
        for (const t of einsteinSlice) {
            html += `<tr><td>${t.team_number}</td><td>${_esc(t.nickname)}</td><td class="num">${t.years.length}</td><td class="years-cell">${t.years.join(', ')}</td></tr>`;
        }
        if (data.einstein_teams.length > 15) {
            html += `<tr class="more-row"><td colspan="4">+${data.einstein_teams.length - 15} more</td></tr>`;
        }
        html += '</tbody></table></div>';
    }

    // International visitors
    if (data.top_international_visitors && data.top_international_visitors.length) {
        html += '<div class="history-detail-section">';
        html += '<h4>Most International Appearances <span class="detail-note">(last 5 seasons)</span></h4>';
        html += '<div class="history-team-chips">';
        const vis = data.top_international_visitors;
        const SHOW = 5;
        vis.slice(0, SHOW).forEach(v => {
            html += `<span class="history-chip visitor-chip">${v.team_number} <span class="chip-name">${_esc(v.nickname)}</span> <span class="chip-country">${_esc(v.country)}</span> <span class="chip-count">${v.appearances}×</span></span>`;
        });
        if (vis.length > SHOW) {
            const extra = vis.length - SHOW;
            html += `<span class="history-chip-more" onclick="this.nextElementSibling.classList.toggle('hidden');this.textContent=this.textContent.startsWith('+')?'− collapse':'+${extra} more'">+${extra} more</span>`;
            html += '<span class="history-chip-extra hidden">';
            vis.slice(SHOW).forEach(v => {
                html += `<span class="history-chip visitor-chip">${v.team_number} <span class="chip-name">${_esc(v.nickname)}</span> <span class="chip-country">${_esc(v.country)}</span> <span class="chip-count">${v.appearances}×</span></span>`;
            });
            html += '</span>';
        }
        html += '</div></div>';
    }

    body.innerHTML = html;
}


// ── Event History panel ────────────────────────────────────
function renderEventHistory(data) {
    const title = $('history-event-title');
    const body = $('history-event-body');
    if (!data) {
        title.textContent = 'Event History';
        body.innerHTML = '<p class="empty">No event history available.</p>';
        return;
    }

    title.textContent = `${_esc(data.event_name)} History`;

    let html = '<div class="history-stats-row">';
    html += _statCard('First Held', `${data.first_held}`, data.event_name || '');
    html += _statCard('Editions', `${data.editions}`, `${data.first_held}–${data.years_held[data.years_held.length - 1]}`);
    html += '</div>';

    // Leaderboards
    const boards = [
        { title: 'Most Event Wins', data: data.most_wins, icon: '🏆' },
        { title: 'Most Finalist Appearances', data: data.most_finalists, icon: '🥈' },
        { title: 'Most Event Impact Awards', data: data.most_impact, icon: '⭐' },
    ];

    html += '<div class="history-leaderboards">';
    for (const b of boards) {
        if (!b.data || !b.data.length) continue;
        html += '<div class="history-leaderboard">';
        html += `<h4>${b.icon} ${b.title}</h4>`;
        html += '<ol class="leaderboard-list">';
        for (const t of b.data) {
            html += `<li><span class="lb-team">${t.team_number}</span> <span class="lb-name">${_esc(t.nickname)}</span> <span class="lb-count">${t.count}</span></li>`;
        }
        html += '</ol></div>';
    }
    html += '</div>';

    // Year-by-year timeline
    if (data.timeline && data.timeline.length) {
        html += '<div class="history-detail-section">';
        html += '<h4>Year-by-Year Results</h4>';
        html += '<table class="data-table history-table"><thead><tr><th>Year</th><th>Winners</th><th>Finalists</th><th>Event Impact</th></tr></thead><tbody>';
        for (const yr of data.timeline) {
            const winners = (yr.winners || []).map(t => `<span class="has-tooltip">${t.team_number}<span class="custom-tooltip">${_esc(t.nickname)}</span></span>`).join(', ') || '—';
            const finalists = (yr.finalists || []).map(t => `<span class="has-tooltip">${t.team_number}<span class="custom-tooltip">${_esc(t.nickname)}</span></span>`).join(', ') || '—';
            const impact = yr.impact ? `<span class="has-tooltip">${yr.impact.team_number}<span class="custom-tooltip">${_esc(yr.impact.nickname)}</span></span>` : '—';
            html += `<tr><td class="year-cell">${yr.year}</td><td>${winners}</td><td>${finalists}</td><td>${impact}</td></tr>`;
        }
        html += '</tbody></table></div>';
    }

    body.innerHTML = html;
}


// ── Helpers ────────────────────────────────────────────────
function _statCard(label, value, sub) {
    return `<div class="history-stat-card"><div class="hsc-value">${value}</div><div class="hsc-label">${label}</div>${sub ? `<div class="hsc-sub">${sub}</div>` : ''}</div>`;
}
function _esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


