import { Database } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { Router } from './core/http/router.js';
import { createVersionService } from './versions/index.js';
import { createDataFiles } from './services/dataFiles.js';
import { createCosmeticsService } from './services/cosmetics.js';
import { createAccountService } from './services/accounts.js';
import { createAuthService } from './services/auth.js';
import { createXmppService } from './xmpp/server.js';
import { createFriendsService } from './services/friends.js';
import { createPartyService } from './services/party.js';
import { createProfileService } from './services/profiles/index.js';
import { createProgressionService } from './services/progression.js';
import { createQuestService } from './services/quests.js';
import { createCatalogService } from './services/catalog.js';
import { createGameServerRegistry } from './services/gameServers.js';
import { createMatchmakingService } from './services/matchmaking.js';
import { createCloudStorageService } from './services/cloudStorage.js';
import { createContentService } from './services/content.js';
import { createStatsService } from './services/stats.js';
import { createLockerService } from './services/locker.js';
import { createMcpService } from './services/mcp/index.js';
import { createAdminService } from './services/admin.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerFortniteRoutes } from './routes/fortnite.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerLockerRoutes } from './routes/locker.js';
import { registerGalliumRoutes } from './routes/gallium.js';

/**
 * Wires every service together. Used by the server entry point, the CLI and the tests, so all
 * three run exactly the same code. `withHttp: false` skips the router (CLI use).
 */
export function createApp({ config, log, partyDisconnectGraceMs }) {
  const db = new Database(config.database.path);
  const repos = createRepositories(db);
  const versions = createVersionService({ config, log });
  const dataFiles = createDataFiles({ config, log });
  const cosmetics = createCosmeticsService({ config, log });
  const accounts = createAccountService({ repos, config, log });
  const auth = createAuthService({ repos, config, log });
  const xmpp = createXmppService({ config, log, auth });
  const friends = createFriendsService({ repos, accounts, xmpp, log });
  xmpp.setFriendResolver((id) => friends.friendIds(id));
  const party = createPartyService({ accounts, xmpp, log, disconnectGraceMs: partyDisconnectGraceMs });
  party.setDomain(config.xmpp.domain);
  const profiles = createProfileService({ db, repos, config, cosmetics, log });
  const progression = createProgressionService({ dataFiles, cosmetics, log });
  const quests = createQuestService({ dataFiles, progression, cosmetics, log });
  const catalog = createCatalogService({ dataFiles, cosmetics, progression, log });
  const gameServers = createGameServerRegistry({ config, log });
  const matchmaking = createMatchmakingService({ config, log, gameServers, repos });
  const cloudStorage = createCloudStorageService({ repos, config });
  const content = createContentService({ dataFiles });
  const stats = createStatsService({ repos });
  const locker = createLockerService({ repos, profiles, log });

  const services = { config, log, db, repos, versions, dataFiles, cosmetics, accounts, auth, xmpp, friends, party, profiles, progression, quests, catalog, gameServers, matchmaking, cloudStorage, content, stats, locker };
  services.mcp = createMcpService({ db, profiles, services, log });
  services.admin = createAdminService({ accounts, profiles, auth, versions, cosmetics, progression, stats, quests });

  const router = new Router();
  registerAccountRoutes(router);
  registerMcpRoutes(router);
  registerFortniteRoutes(router);
  registerSocialRoutes(router);
  registerMiscRoutes(router);
  registerLockerRoutes(router);
  registerGalliumRoutes(router);
  for (const adapter of versions.adapters) adapter.registerRoutes?.(router, services);

  return {
    services,
    router,
    close() {
      matchmaking.shutdown();
      party.shutdown();
      db.close();
    },
  };
}
