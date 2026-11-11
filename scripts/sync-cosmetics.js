#!/usr/bin/env node
/**
 * Downloads the Battle Royale cosmetic list once and stores the parts Gallium needs
 * (id, type, introduction season, rarity, variant channels/tags) in data/cosmetics.json.
 * The backend itself never goes online; re-run this after a new season if you want newer items.
 *
 * Source: the public fortnite-api.com dataset (no account or API key required).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'cosmetics.json');
const API = 'https://fortnite-api.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Gallium-Backend-Sync/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error(`${url} returned an unexpected shape`);
  return body.data;
}

async function main() {
  console.log('Downloading cosmetics list...');
  const cosmetics = await getJson(`${API}/v2/cosmetics/br`);
  const items = [];
  for (const c of cosmetics) {
    const type = c?.type?.backendValue;
    if (typeof c?.id !== 'string' || typeof type !== 'string') continue;
    const season = Number.isInteger(c.introduction?.backendValue) ? c.introduction.backendValue : null;
    const variants = (Array.isArray(c.variants) ? c.variants : [])
      .map((v) => ({ channel: v?.channel, options: (Array.isArray(v?.options) ? v.options : []).map((o) => o?.tag).filter((t) => typeof t === 'string') }))
      .filter((v) => typeof v.channel === 'string' && v.options.length);
    items.push({ id: c.id, type, season, rarity: typeof c.rarity?.value === 'string' ? c.rarity.value : null, variants });
  }

  let banners = [];
  let bannerColors = [];
  try {
    banners = (await getJson(`${API}/v1/banners`)).map((b) => b?.id).filter((id) => typeof id === 'string');
    bannerColors = (await getJson(`${API}/v1/banners/colors`)).map((b) => b?.id).filter((id) => typeof id === 'string');
  } catch (err) {
    console.warn(`Banners skipped: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: `${API}/v2/cosmetics/br`, items, banners, bannerColors }));
  const withSeason = items.filter((i) => i.season !== null).length;
  console.log(`Saved ${items.length} cosmetics (${withSeason} with a known season), ${banners.length} banners and ${bannerColors.length} banner colors to ${path.relative(ROOT, OUT)}.`);
  console.log('Restart Gallium to load the new list.');
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  process.exit(1);
});
