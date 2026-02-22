/* ═══════════════════════════════════════════════════════════
   api.js — thin fetch wrapper for the backend
   ═══════════════════════════════════════════════════════════ */

const API = {
    async get(path) {
        const resp = await fetch(`/api${path}`);
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },

    async post(path, body) {
        const resp = await fetch(`/api${path}`, {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!resp.ok) {
            const b = await resp.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },

    async del(path) {
        const resp = await fetch(`/api${path}`, { method: 'DELETE' });
        if (!resp.ok) {
            const b = await resp.json().catch(() => ({}));
            throw new Error(b.detail || `HTTP ${resp.status}`);
        }
        return resp.json();
    },

    // ── Events ──────────────────────────────────────────
    seasonEvents:       (yr) => API.get(`/events/season/${yr}`),
    eventInfo:          (ek) => API.get(`/events/${ek}/info`),
    eventTeams:         (ek) => API.get(`/events/${ek}/teams`),
    eventSummary:       (ek) => API.get(`/events/${ek}/summary`),
    eventSummaryRefresh:(ek) => API.get(`/events/${ek}/summary/refresh-stats`),
    eventConnections:   (ek, allTime) => API.get(`/events/${ek}/summary/connections?all_time=${allTime ? 'true' : 'false'}`),
    clearCache:         (ek) => API.get(`/events/${ek}/clear-cache`),
    refreshRankings:    (ek) => API.get(`/events/${ek}/refresh-rankings`),

    // ── Matches ─────────────────────────────────────────
    playoffMatches: (ek) => API.get(`/matches/${ek}/playoffs`),
    allMatches:     (ek) => API.get(`/matches/${ek}/all`),
    matchBreakdown: (mk) => API.get(`/matches/match/${mk}/breakdown`),
    teamPerf:       (ek, num) => API.get(`/matches/team-perf/${ek}/${num}`),

    // ── Alliances ───────────────────────────────────────
    alliances: (ek) => API.get(`/alliances/${ek}`),

    // ── Teams ───────────────────────────────────────────
    teamStats: (num, year) =>
        API.get(`/teams/${num}/stats${year ? `?year=${year}` : ''}`),
    headToHead: (a, b, year, allTime) =>
        API.get(`/teams/head-to-head/${a}/${b}${year ? `?year=${year}&` : '?'}all_time=${allTime ? 'true' : 'false'}`),

    // ── Compare ─────────────────────────────────────────
    compareTeams: (ek, teamKeys) =>
        API.get(`/events/${ek}/compare?teams=${teamKeys.join(',')}`),

    // ── Region / Event History ──────────────────────────
    regionFacts:  (name) => API.get(`/events/region/${encodeURIComponent(name)}/facts`),
    regionsList:  ()     => API.get('/events/regions/list'),
    eventHistory: (ek)   => API.get(`/events/${ek}/history`),

    // ── Saved Events ────────────────────────────────────
    savedList:    ()   => API.get('/events/saved/list'),
    saveEvent:    (ek, data) => API.post(`/events/${ek}/save`, data),
    loadSaved:    (ek) => API.get(`/events/${ek}/saved`),
    deleteSaved:  (ek) => API.del(`/events/${ek}/saved`),
};
