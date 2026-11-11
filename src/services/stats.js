import { Errors } from '../core/errors.js';

// statsv1 playlist ids used by early builds' bulk stats endpoint.
const LEGACY_PLAYLIST = { playlist_defaultsolo: 'p2', playlist_defaultduo: 'p10', playlist_defaultsquad: 'p9' };

/**
 * Persistent player statistics in statsv2 naming
 * (br_<stat>_keyboardmouse_m0_<playlist>), fed by game-server match results.
 */
export function createStatsService({ repos }) {
  function recordMatch(accountId, { playlist = 'playlist_defaultsolo', placement, kills = 0, score = 0, minutesPlayed = 0 }) {
    const pl = String(playlist).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!pl) throw Errors.validation('playlist is required');
    for (const [name, v] of [['kills', kills], ['score', score], ['minutesplayed', minutesPlayed]]) {
      if (!Number.isInteger(v) || v < 0) throw Errors.validation(`${name} must be a non-negative integer`);
    }
    const key = (stat) => `br_${stat}_keyboardmouse_m0_${pl}`;
    repos.stats.increment(accountId, key('matchesplayed'), 1);
    if (kills) repos.stats.increment(accountId, key('kills'), kills);
    if (score) repos.stats.increment(accountId, key('score'), score);
    if (minutesPlayed) repos.stats.increment(accountId, key('minutesplayed'), minutesPlayed);
    if (Number.isInteger(placement) && placement > 0) {
      for (const top of [1, 3, 5, 6, 10, 12, 25]) if (placement <= top) repos.stats.increment(accountId, key(`placetop${top}`), 1);
    }
    repos.stats.set(accountId, key('lastmodified'), Math.floor(Date.now() / 1000));
  }

  return {
    recordMatch,
    statsV2(accountId) {
      return { startTime: 0, endTime: 9223372036854775807, stats: repos.stats.all(accountId), accountId };
    },
    /** /fortnite/api/stats/accountId/:id/bulk/window/alltime (pre-statsv2 builds). */
    legacyBulk(accountId) {
      const out = [];
      for (const [name, value] of Object.entries(repos.stats.all(accountId))) {
        const m = /^br_([a-z0-9]+)_keyboardmouse_m0_(.+)$/.exec(name);
        if (!m || !LEGACY_PLAYLIST[m[2]] || m[1] === 'lastmodified') continue;
        out.push({ name: `br_${m[1]}_pc_m0_${LEGACY_PLAYLIST[m[2]]}`, value, window: 'alltime', ownerType: 1 });
      }
      return out;
    },
  };
}
