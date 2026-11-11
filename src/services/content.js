import { startOfUtcDay } from '../core/util.js';

/**
 * Calendar timeline and the fortnite-game content page. Both are generated per request from
 * the build's version adapter (season number, event flags, lobby backgrounds), with optional
 * user overrides merged in from data/content/fortnite-game.json.
 */
export function createContentService({ dataFiles }) {
  function times() {
    const now = new Date();
    const day = startOfUtcDay(now);
    const dailyEnd = new Date(day.getTime() + 86400000).toISOString();
    const daysToThursday = (4 - day.getUTCDay() + 7) % 7 || 7;
    const weeklyEnd = new Date(day.getTime() + daysToThursday * 86400000).toISOString();
    // A rolling season end keeps the battle pass "days left" counter positive.
    const seasonEnd = new Date(day.getTime() + 60 * 86400000).toISOString();
    return { now: now.toISOString(), dailyEnd, weeklyEnd, seasonEnd };
  }

  function timeline(build) {
    const t = times();
    const adapter = build.adapter;
    const activeEvents = adapter.timelineEvents(build).map((eventType) => ({ eventType, activeUntil: t.seasonEnd, activeSince: '2017-07-25T00:00:00.000Z' }));
    return {
      channels: {
        'client-matchmaking': { states: [], cacheExpire: '9999-01-01T00:00:00.000Z' },
        'client-events': {
          states: [{ validFrom: '2017-07-25T00:00:00.000Z', activeEvents, state: adapter.timelineState(build, t) }],
          cacheExpire: t.dailyEnd,
        },
      },
      eventsTimeOffsetHrs: 0,
      cacheIntervalMins: 10,
      currentTime: t.now,
    };
  }

  function pages(build) {
    const t = times();
    const meta = (title) => ({ _title: title, _noIndex: false, _activeDate: '2017-07-25T00:00:00.000Z', lastModified: t.now, _locale: 'en-US' });
    let page = {
      _title: 'Fortnite Game',
      _activeDate: '2017-07-25T00:00:00.000Z',
      lastModified: t.now,
      _locale: 'en-US',
      battleroyalenews: {
        news: {
          _type: 'Battle Royale News',
          motds: [
            { entryType: 'Text', image: '', tileImage: '', hidden: false, videoMute: false, tabTitleOverride: 'Gallium', _type: 'CommonUI Simple Message MOTD', title: 'Gallium', body: `Running on a local Gallium backend (season ${build.season}).`, videoLoop: false, videoStreamingEnabled: false, sortingPriority: 0, id: 'gallium-motd', spotlight: false },
          ],
          messages: [{ hidden: false, _type: 'CommonUI Simple Message Base', adspace: '', title: 'Gallium', body: `Running on a local Gallium backend (season ${build.season}).`, spotlight: false }],
        },
        ...meta('battleroyalenews'),
      },
      emergencynotice: { news: { platform_messages: [], _type: 'Battle Royale News', messages: [] }, ...meta('emergencynotice') },
      emergencynoticev2: { 'jcr:isCheckedOut': true, _title: 'emergencynoticev2', _noIndex: false, emergencynotices: { _type: 'Emergency Notices', emergencynotices: [] }, _activeDate: '2017-07-25T00:00:00.000Z', lastModified: t.now, _locale: 'en-US' },
      playlistinformation: { frontend_matchmaking_header_style: 'None', _title: 'playlistinformation', frontend_matchmaking_header_text: '', playlist_info: { _type: 'Playlist Information', playlists: [] }, _noIndex: false, _activeDate: '2017-07-25T00:00:00.000Z', lastModified: t.now, _locale: 'en-US' },
      tournamentinformation: { tournament_info: { tournaments: [], _type: 'Tournaments Info' }, ...meta('tournamentinformation') },
      shopSections: {
        sectionList: {
          _type: 'ShopSectionList',
          sections: [
            { bSortOffersByOwnership: false, bShowIneligibleOffersIfGiftable: false, bEnableToastNotification: true, background: { stage: 'default', _type: 'DynamicBackground', key: 'vault' }, _type: 'ShopSection', landingPriority: 70, bHidden: false, sectionId: 'Featured', bShowTimer: true, sectionDisplayName: 'Featured', bShowIneligibleOffers: true },
            { bSortOffersByOwnership: false, bShowIneligibleOffersIfGiftable: false, bEnableToastNotification: true, background: { stage: 'default', _type: 'DynamicBackground', key: 'vault' }, _type: 'ShopSection', landingPriority: 60, bHidden: false, sectionId: 'Daily', bShowTimer: true, sectionDisplayName: 'Daily', bShowIneligibleOffers: true },
          ],
        },
        ...meta('shop-sections'),
      },
    };
    page = build.adapter.contentPages(build, page);
    const overrides = dataFiles.read('content/fortnite-game.json');
    if (overrides && typeof overrides === 'object') page = { ...page, ...overrides };
    return page;
  }

  return { timeline, pages, times };
}
