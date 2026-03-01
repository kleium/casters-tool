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

    // ── Events ──────────────────────────────────────────
    seasonEvents:       (yr, includeOffseason) => API.get(`/events/season/${yr}${includeOffseason ? '?include_offseason=true' : ''}`),
    eventInfo:          (ek) => API.get(`/events/${ek}/info`),
    eventTeams:         (ek) => API.get(`/events/${ek}/teams`),
    eventSummary:       (ek) => API.get(`/events/${ek}/summary`),
    eventSummaryRefresh:(ek) => API.get(`/events/${ek}/summary/refresh-stats`),
    eventSummaryAwards: (ek) => API.get(`/events/${ek}/summary/awards`),
    eventConnections:   (ek, allTime, teams) => {
        let url = `/events/${ek}/summary/connections?all_time=${allTime ? 'true' : 'false'}`;
        if (teams && teams.length) url += `&teams=${teams.join(',')}`;
        return API.get(url);
    },
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
        API.get(`/teams/${num}/stats${year ? `?year=${year}` : ''}`),    teamAwardsSummary: (teamNums) =>
        API.get(`/teams/awards-summary?teams=${teamNums.join(',')}`),    headToHead: (a, b, year, allTime) =>
        API.get(`/teams/head-to-head/${a}/${b}${year ? `?year=${year}&` : '?'}all_time=${allTime ? 'true' : 'false'}`),

    // ── Compare ─────────────────────────────────────────
    compareTeams: (ek, teamKeys) =>
        API.get(`/events/${ek}/compare?teams=${teamKeys.join(',')}`),

    // ── Region / Event History ──────────────────────────
    regionFacts:  (name) => API.get(`/events/region/${encodeURIComponent(name)}/facts`),
    regionsList:  ()     => API.get('/events/regions/list'),
    eventHistory: (ek)   => API.get(`/events/${ek}/history`),
};
