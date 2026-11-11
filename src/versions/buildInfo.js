/**
 * Parses Fortnite build strings as they appear in User-Agent headers, e.g.
 *   Fortnite/++Fortnite+Release-10.40-CL-9380822 Windows/10.0.19041.1.256.64bit
 *   Fortnite/++Fortnite+Release-Cert-CL-3741772 Windows/...
 *   game=Fortnite, engine=UE4, build=++Fortnite+Release-3.1-CL-3915963, netver=3915963
 */
const BUILD_RE = /Release-(Cert|\d+(?:\.\d+){0,2})-CL-(\d+)/i;

// "Cert" builds carry no version number. Season 2 began with 1.11, whose CL was 3807424.
const FIRST_SEASON2_CL = 3807424;

export function parseBuild(text) {
  const m = BUILD_RE.exec(text || '');
  if (!m) return null;
  const cl = Number(m[2]);
  let major;
  let minor;
  let patch = 0;
  if (m[1].toLowerCase() === 'cert') {
    major = 1;
    minor = cl >= FIRST_SEASON2_CL ? 11 : 8;
  } else {
    const parts = m[1].split('.').map(Number);
    [major, minor = 0, patch = 0] = parts;
  }
  const season = seasonFor(major, minor);
  return {
    raw: `++Fortnite+Release-${m[1]}-CL-${cl}`,
    branch: m[1],
    major,
    minor,
    patch,
    cl,
    season,
    chapter: chapterFor(season),
  };
}

/**
 * true when the build is at least major.minor. Fortnite minors are whole numbers, not
 * decimals: 3.5 < 3.6 and 1.9 < 1.10, while 5.10 / 10.40 use two digits within their major.
 */
export function atLeast(build, major, minor = 0) {
  return build.major > major || (build.major === major && build.minor >= minor);
}

function seasonFor(major, minor) {
  if (major <= 1) return minor >= 11 ? 2 : 1;
  return major; // from 2.x on, each major version is one season (season 11 = Chapter 2 Season 1, ...)
}

/** Chapter boundaries by season number. */
export function chapterFor(season) {
  if (season <= 10) return 1;
  if (season <= 18) return 2;
  if (season <= 22) return 3;
  if (season <= 27) return 4;
  if (season <= 32) return 5;
  return 6;
}

/** Season number within its chapter (Chapter 2 Season 1 = season 11 -> 1). */
export function seasonInChapter(season) {
  const starts = [1, 11, 19, 23, 28, 33];
  const chapter = chapterFor(season);
  return season - starts[chapter - 1] + 1;
}
