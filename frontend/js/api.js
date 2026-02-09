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
    eventInfo:   (ek) => API.get(`/events/${ek}/info`),
    eventTeams:  (ek) => API.get(`/events/${ek}/teams`),
    clearCache:  (ek) => API.get(`/events/${ek}/clear-cache`),

    // ── Matches ─────────────────────────────────────────
    playoffMatches: (ek) => API.get(`/matches/${ek}/playoffs`),
    allMatches:     (ek) => API.get(`/matches/${ek}/all`),
    matchBreakdown: (mk) => API.get(`/matches/match/${mk}/breakdown`),

    // ── Alliances ───────────────────────────────────────
    alliances: (ek) => API.get(`/alliances/${ek}`),

    // ── Teams ───────────────────────────────────────────
    teamStats: (num, year) =>
        API.get(`/teams/${num}/stats${year ? `?year=${year}` : ''}`),
    headToHead: (a, b, year) =>
        API.get(`/teams/head-to-head/${a}/${b}${year ? `?year=${year}` : ''}`),
};
