import { sha256Hex, startOfUtcDay } from '../core/util.js';

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

  /**
   * News messages: data/content/news.json (per season: data/content/news-season<N>.json),
   * [{ "title", "body", "image"? }]. Images default to Gallium's own /gallium/assets/news.png.
   * `assetBase` is the http://host:port the client used, so friends get reachable image URLs.
   */
  function newsMessages(build, assetBase) {
    const custom = dataFiles.first(`content/news-season${build.season}.json`, 'content/news.json');
    const list = Array.isArray(custom) && custom.length ? custom : [{ title: 'Gallium', body: `Running on a local Gallium backend (season ${build.season}).` }];
    return list
      .filter((m) => m && typeof m.title === 'string')
      .slice(0, 10)
      .map((m, i) => ({ title: m.title, body: typeof m.body === 'string' ? m.body : '', image: typeof m.image === 'string' && m.image ? m.image : `${assetBase}/gallium/assets/news.png?v=${i}`, id: `gallium-${i}` }));
  }

  // Lastmodified changes only when the news itself changes, so "new news" isn't flagged every request.
  function pages(build, { assetBase = 'http://127.0.0.1:1523' } = {}) {
    const t = times();
    const news = newsMessages(build, assetBase);
    const newsDate = new Date(Date.UTC(2017, 6, 25) + (parseInt(sha256Hex(JSON.stringify(news)).slice(0, 8), 16) % 525600) * 60000).toISOString();
    const meta = (title) => ({ _title: title, _noIndex: false, _activeDate: '2017-07-25T00:00:00.000Z', lastModified: t.now, _locale: 'en-US' });
    let page = {
      _title: 'Fortnite Game',
      _activeDate: '2017-07-25T00:00:00.000Z',
      lastModified: t.now,
      _locale: 'en-US',
      battleroyalenews: {
        news: {
          _type: 'Battle Royale News',
          motds: news.map((m, i) => ({ entryType: 'Text', image: m.image, tileImage: m.image, hidden: false, videoMute: false, tabTitleOverride: m.title, _type: 'CommonUI Simple Message MOTD', title: m.title, body: m.body, videoLoop: false, videoStreamingEnabled: false, sortingPriority: 0, id: m.id, spotlight: false })),
          // 1.8 (UFortAthenaNewsWidget) reads these, including messageType and image.
          messages: news.map((m) => ({ image: m.image, hidden: false, messageType: 'normal', _type: 'CommonUI Simple Message Base', adspace: '', title: m.title, body: m.body, spotlight: false })),
        },
        header: '',
        style: 'None',
        ...meta('battleroyalenews'),
        lastModified: newsDate,
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
