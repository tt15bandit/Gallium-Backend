import { parseBuild } from './buildInfo.js';
import season1to3 from './adapters/season1to3.js';
import chapter1 from './adapters/chapter1.js';
import chapter2to4 from './adapters/chapter2to4.js';
import chapter5plus from './adapters/chapter5plus.js';

/**
 * Adapters are checked in order; the first whose matches(build) is true wins.
 * To support another range of builds, add a file under ./adapters and list it here.
 */
export const ADAPTERS = [season1to3, chapter1, chapter2to4, chapter5plus];

export function createVersionService({ config, log, adapters = ADAPTERS }) {
  const fallback = parseBuild(config.versions.fallbackBuild);
  if (!fallback) throw new Error(`versions.fallbackBuild "${config.versions.fallbackBuild}" is not a valid build string`);
  const forced = config.versions.forceBuild ? parseBuild(config.versions.forceBuild) : null;
  if (config.versions.forceBuild && !forced) throw new Error(`versions.forceBuild "${config.versions.forceBuild}" is not a valid build string`);
  const cache = new Map();

  function adapterFor(build) {
    const adapter = adapters.find((a) => a.matches(build));
    if (!adapter) throw new Error(`No version adapter matches build ${build.raw}`);
    return adapter;
  }

  function describe(build, detected, userAgent) {
    const adapter = adapterFor(build);
    const info = { ...build, detected, userAgent, adapter };
    // Resolve feature flags that are functions of the build once, up front.
    info.features = Object.fromEntries(Object.entries(adapter.features).map(([k, v]) => [k, typeof v === 'function' ? v(build) : v]));
    info.rule = (name) => {
      const v = adapter.progression[name];
      return typeof v === 'function' && name !== 'xpForLevel' && name !== 'starsForLevel' ? v(build) : v;
    };
    return Object.freeze(info);
  }

  function resolve(userAgent = '') {
    const key = forced ? '*forced*' : userAgent;
    let info = cache.get(key);
    if (info) return info;
    const parsed = forced || parseBuild(userAgent);
    info = describe(parsed || fallback, !!parsed, userAgent);
    if (cache.size > 500) cache.clear();
    cache.set(key, info);
    return info;
  }

  /** Resolve from a bare build string such as "++Fortnite+Release-4.5-CL-4166199" or "4.5". */
  function fromBuildString(text) {
    const build = parseBuild(/Release-/.test(text) ? text : `Release-${text}-CL-0`);
    return build ? describe(build, true, '') : null;
  }

  log?.debug?.(`Version adapters: ${adapters.map((a) => a.id).join(', ')}`);
  return { resolve, fromBuildString, adapters, fallback: describe(fallback, false, '') };
}
