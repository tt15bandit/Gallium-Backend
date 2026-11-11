import { Errors } from '../../core/errors.js';
import { isoNow } from '../../core/util.js';
import { coreCommands } from './commands/index.js';

/**
 * MCP ("profile") command dispatcher:
 *   POST /fortnite/api/game/v2/profile/:accountId/:route/:command?profileId=&rvn=
 *
 * Each command handler is a synchronous function(cmd) that mutates profiles through the
 * Profile API. Everything a command touches is saved in one SQLite transaction, then the
 * response is built with either a full profile or the incremental change list.
 * Handler metadata (optional properties on the function):
 *   routes   allowed routes (default ['client'])
 *   profiles allowed profileIds; the token 'currency' means the build's currency profile
 */
export function createMcpService({ db, profiles, services, log }) {
  const mcpLog = log.child('mcp');

  function resolveCommand(adapter, name) {
    return adapter.mcpCommands[name] || coreCommands[name] || null;
  }

  function execute({ accountId, route, command, profileId, rvn, body, build, query = {} }) {
    const adapter = build.adapter;
    if (!adapter.profileIds.includes(profileId)) throw Errors.profileNotFound(profileId);
    const handler = resolveCommand(adapter, command);
    if (!handler) throw Errors.operationNotFound(command);
    const routes = handler.routes || ['client'];
    if (!routes.includes(route)) throw Errors.operationForbidden(command, route);
    if (handler.profiles) {
      const allowed = handler.profiles.map((p) => (p === 'currency' ? adapter.currencyProfile : p));
      if (!allowed.includes(profileId)) throw Errors.invalidParameter(`Operation ${command} is not valid for profile ${profileId}`);
    }

    const afterCommit = [];
    const notifications = [];
    const loaded = new Map();
    let main;
    let baseRevision;
    let forceFull = false;

    const runCommand = () => {
      const getProfile = (pid) => {
        if (!loaded.has(pid)) loaded.set(pid, profiles.load(accountId, pid, build));
        return loaded.get(pid);
      };
      main = getProfile(profileId);
      baseRevision = main.baseRvn;
      handler({
        accountId,
        profileId,
        profile: main,
        body: body || {},
        query,
        build,
        adapter,
        route,
        services,
        log: mcpLog,
        getProfile,
        notify: (n) => notifications.push(n),
        afterCommit: (fn) => afterCommit.push(fn),
        forceFullProfile: () => {
          forceFull = true;
        },
      });
      for (const p of loaded.values()) profiles.save(p);
    };

    try {
      db.transaction(runCommand);
    } catch (err) {
      // Rolled back: cached profiles this command touched (including other accounts' for gifts)
      // may hold uncommitted changes, so drop the cache and let the next load re-read SQLite.
      profiles.clearCache();
      throw err;
    }

    for (const fn of afterCommit) {
      try {
        fn();
      } catch (err) {
        mcpLog.error(`afterCommit hook for ${command} failed:`, err);
      }
    }

    const clientRvn = rvn === undefined || rvn === null || rvn === '' ? -1 : Number(rvn);
    const full = command === 'QueryProfile' || command === 'QueryPublicProfile' || forceFull || clientRvn !== baseRevision;
    const opts = { omissionGroup: query.dataOmissionGroup || null };
    const response = {
      profileRevision: main.rvn,
      profileId,
      profileChangesBaseRevision: baseRevision,
      profileChanges: full ? [{ changeType: 'fullProfileUpdate', profile: profiles.serialize(main, build, opts) }] : main.changes,
      profileCommandRevision: main.rvn,
      serverTime: isoNow(),
      responseVersion: 1,
    };
    const multiUpdate = [];
    for (const p of loaded.values()) {
      if (p === main || !p.hasChanges) continue;
      multiUpdate.push({
        profileRevision: p.rvn,
        profileId: p.profileId,
        profileChangesBaseRevision: p.baseRvn,
        profileChanges: p.changes,
        profileCommandRevision: p.rvn,
      });
    }
    if (multiUpdate.length) response.multiUpdate = multiUpdate;
    if (notifications.length) response.notifications = notifications;
    return response;
  }

  return { execute, hasCommand: (adapter, name) => !!resolveCommand(adapter, name) };
}
