#!/usr/bin/env node
/**
 * Gallium admin CLI. Works directly on the SQLite database (safe while the server runs:
 * the server reads profiles from the database on every request).
 *
 *   npm run cli -- <command> [args]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { createApp } from '../src/app.js';
import { EpicError } from '../src/core/errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Gallium admin CLI

Usage: npm run cli -- <command> [arguments]

Accounts
  accounts                              list accounts
  create <displayName> <password> [email]
  info <account>                        account summary (V-Bucks, level, items)
  password <account> <newPassword>
  ban <account> | unban <account>
  delete <account>
  exchange <account>                    one-time exchange code (for launchers using -AUTH_TYPE=exchangecode)

Inventory & progression
  grant <account> <TemplateId...>       e.g. grant Bandit AthenaCharacter:CID_028_Athena_Commando_F
  grant <account> all                   every cosmetic in data/cosmetics.json
  revoke <account> <TemplateId...>
  vbucks <account> <amount>             set balance; use +N / -N to add or remove
  xp <account> <amount>                 add XP (levels and battle pass tiers update)
  battlepass <account> on|off

<account> can be an account id, display name or e-mail.
Add --build <version> (e.g. --build 4.5) to grant/xp/battlepass to target a specific season's rules.`;

async function main() {
  // Split "--flag value" pairs (config options like --db / --config, plus --build) from positionals.
  const positional = [];
  const flags = [];
  let build;
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].startsWith('--')) {
      positional.push(raw[i]);
      continue;
    }
    const hasValue = !raw[i].includes('=') && i + 1 < raw.length && !raw[i + 1].startsWith('--');
    const pair = hasValue ? [raw[i], raw[++i]] : [raw[i]];
    if (pair[0] === '--build') build = pair[1];
    else if (pair[0].startsWith('--build=')) build = pair[0].slice(8);
    else flags.push(...pair);
  }
  const [command, ...args] = positional;
  if (!command || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig({ argv: flags, env: process.env, rootDir: ROOT });
  const log = createLogger({ level: 'warn', file: null });
  const app = createApp({ config, log });
  const { admin, accounts } = app.services;
  const need = (n, usage) => {
    if (args.length < n) throw new Error(`Usage: npm run cli -- ${usage}`);
  };

  try {
    switch (command) {
      case 'accounts': {
        const list = accounts.list();
        if (!list.length) console.log('No accounts yet. Create one with: npm run cli -- create <name> <password>');
        for (const a of list) console.log(`${a.id}  ${a.displayName.padEnd(20)} ${a.email.padEnd(32)} last login: ${a.lastLogin || 'never'}${a.banned ? '  [BANNED]' : ''}`);
        break;
      }
      case 'create': {
        need(2, 'create <displayName> <password> [email]');
        const a = admin.createAccount({ displayName: args[0], password: args[1], email: args[2] });
        console.log(`Created ${a.displayName} (${a.id}), login e-mail: ${a.email}`);
        break;
      }
      case 'info':
        need(1, 'info <account>');
        console.log(JSON.stringify(admin.describe(args[0]), null, 2));
        break;
      case 'password':
        need(2, 'password <account> <newPassword>');
        admin.setPassword(args[0], args[1]);
        console.log('Password updated.');
        break;
      case 'ban':
      case 'unban':
        need(1, `${command} <account>`);
        admin.setBanned(args[0], command === 'ban');
        console.log(command === 'ban' ? 'Account banned and signed out.' : 'Account unbanned.');
        break;
      case 'delete':
        need(1, 'delete <account>');
        admin.deleteAccount(args[0]);
        console.log('Account deleted.');
        break;
      case 'exchange': {
        need(1, 'exchange <account>');
        const ex = admin.exchangeCode(args[0]);
        console.log(`Exchange code (valid ${ex.expiresInSeconds}s, single use): ${ex.code}`);
        break;
      }
      case 'grant': {
        need(2, 'grant <account> <TemplateId...|all>');
        if (args[1] === 'all') console.log(`Granted ${admin.grantAllCosmetics(args[0], build)} items.`);
        else {
          const granted = admin.grantItems(args[0], args.slice(1), build);
          console.log(granted.length ? `Granted: ${granted.join(', ')}` : 'Nothing granted (already owned).');
        }
        break;
      }
      case 'revoke': {
        need(2, 'revoke <account> <TemplateId...>');
        const removed = admin.revokeItems(args[0], args.slice(1), build);
        console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing removed (not owned).');
        break;
      }
      case 'vbucks': {
        need(2, 'vbucks <account> <amount|+N|-N>');
        const relative = /^[+-]/.test(args[1]);
        const amount = Number(args[1]);
        if (!Number.isInteger(amount)) throw new Error('Amount must be a whole number');
        console.log(`V-Bucks balance: ${admin.setVbucks(args[0], amount, { add: relative })}`);
        break;
      }
      case 'xp': {
        need(2, 'xp <account> <amount>');
        const r = admin.addXp(args[0], Number(args[1]), build);
        console.log(`Level ${r.level} (${r.xp} XP into the level), battle pass tier ${r.tier}.`);
        break;
      }
      case 'battlepass':
        need(2, 'battlepass <account> on|off');
        admin.setBattlePass(args[0], args[1] === 'on', build);
        console.log(`Battle pass ${args[1] === 'on' ? 'granted' : 'removed'}.`);
        break;
      default:
        console.log(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof EpicError ? err.message : err.message}`);
    return 1;
  } finally {
    app.close();
  }
}

main().then((code) => process.exit(code));
