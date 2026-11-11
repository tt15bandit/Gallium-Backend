import { Errors } from '../core/errors.js';
import { hexId, isoNow, sha256Hex } from '../core/util.js';
import { balanceOf, grant as grantMtx, mirrorToProfile0 } from './profiles/currency.js';

/**
 * Free V-Bucks store ("STORE" tab) for builds whose real-money purchases run through the
 * in-game EpicPurchaseFlow browser (seen in the 1.8 game files):
 *
 *  1. CurrencyStorefront lists V-Bucks packs as RealMoney offers; appStoreId[1] is the
 *     EpicPurchasingService offer id the client looks up via /catalog/api/shared/bulk/offers.
 *  2. Buying opens [EpicPurchaseFlow] Prod (pointed at /gallium/purchase by the hotfix) in the
 *     game's CEF browser with ?namespace=fn&offers=<epicOfferId>.
 *  3. Gallium's checkout page grants the V-Bucks, then reports a "Purchased" receipt through the
 *     UPurchaseFlowJSBridge (window.ue.*.receipt) and closes; VerifyRealMoneyPurchase later finds
 *     the receipt already fulfilled.
 * Nothing is charged; the listed prices are only what the UI shows.
 */
// The Season 1 V-Bucks packs (1.8 also ships DA_MtxPack4200 art, but that pack was never sold).
const PACKS = [
  { key: 'small', vbucks: 1000, bonus: 0, cents: 999, devName: 'Small Currency Pack', iconSize: 'Small' },
  { key: 'medium', vbucks: 2800, bonus: 300, cents: 2499, devName: 'Medium Currency Pack', iconSize: 'Small' },
  { key: 'large', vbucks: 7500, bonus: 1500, cents: 5999, devName: 'Large Currency Pack', iconSize: 'Large' },
  { key: 'jumbo', vbucks: 13500, bonus: 3500, cents: 9999, devName: 'Jumbo Currency Pack', iconSize: 'Large' },
];
const APP_STORE_SLOTS = 12; // EAppStore order: index 1 = EpicPurchasingService
const IDENTITY_TTL_MS = 15 * 60 * 1000;

const fmt = (n) => n.toLocaleString('en-US');
const epicIdOf = (pack) => sha256Hex(`gallium-epic-offer:${pack.key}`).slice(0, 32);
const catalogIdOf = (pack) => sha256Hex(`gallium-catalog-offer:${pack.key}`).slice(0, 32).toUpperCase();

export function createVbucksStore({ repos, profiles, accounts, versions, config, log }) {
  const sLog = log.child('vbucks-store');
  const recentByIp = new Map(); // ip -> Map<accountId, timestamp> (who used the store from where)

  const packs = PACKS.map((p) => ({ ...p, epicOfferId: epicIdOf(p), catalogOfferId: catalogIdOf(p), title: `${fmt(p.vbucks)} V-Bucks` }));
  const byAnyId = (id) => packs.find((p) => [p.epicOfferId, p.catalogOfferId, p.key].includes(String(id || '').trim()));

  function catalogEntries() {
    return packs.map((p, i) => {
      const appStoreId = Array.from({ length: APP_STORE_SLOTS }, () => '');
      appStoreId[1] = p.epicOfferId;
      return {
        offerId: p.catalogOfferId,
        devName: p.devName,
        offerType: 'StaticPrice',
        prices: [{ currencyType: 'RealMoney', currencySubType: '', regularPrice: p.cents, finalPrice: p.cents, saleExpiration: '9999-12-31T23:59:59.999Z', basePrice: p.cents }],
        categories: [],
        dailyLimit: -1,
        weeklyLimit: -1,
        monthlyLimit: -1,
        refundable: false,
        appStoreId,
        requirements: [],
        metaInfo: [
          { key: 'MtxQuantity', value: String(p.vbucks) },
          { key: 'MtxBonus', value: String(p.bonus) },
          { key: 'IconSize', value: p.iconSize },
        ],
        catalogGroup: '',
        catalogGroupPriority: 0,
        sortPriority: -i,
        title: p.title,
        shortDescription: '',
        description: `Get ${fmt(p.vbucks)} V-Bucks to spend in Battle Royale.`,
        displayAssetPath: `/Game/Catalog/DisplayAssets/DA_MtxPack${p.vbucks}.DA_MtxPack${p.vbucks}`,
        itemGrants: [],
      };
    });
  }

  /** catalog-public-service offer documents keyed by id (only Gallium's packs are known). */
  function bulkOffers(ids) {
    const out = {};
    const now = '2017-07-25T00:00:00.000Z';
    for (const id of ids) {
      const p = packs.find((x) => x.epicOfferId === id);
      if (!p) continue;
      out[id] = {
        id: p.epicOfferId,
        title: p.title,
        description: `${fmt(p.vbucks)} V-Bucks`,
        longDescription: `Get ${fmt(p.vbucks)} V-Bucks to spend in Battle Royale.`,
        keyImages: [],
        categories: [{ path: 'currency' }],
        namespace: 'fn',
        status: 'ACTIVE',
        creationDate: now,
        lastModifiedDate: now,
        internalName: p.devName,
        recurrence: 'ONCE',
        items: [{ id: sha256Hex(`gallium-item:${p.key}`).slice(0, 32), title: p.title, description: p.title, namespace: 'fn', status: 'ACTIVE', entitlementName: `MtxPack${p.vbucks}`, entitlementType: 'EXECUTABLE', itemType: 'DURABLE' }],
        currencyCode: 'USD',
        currentPrice: p.cents,
        price: p.cents,
        basePrice: p.cents,
        basePriceCurrencyCode: 'USD',
        recurringPrice: 0,
        freeDays: 0,
        maxBillingCycles: 0,
        seller: { id: 'o-gallium', name: 'Gallium' },
        viewableDate: now,
        effectiveDate: now,
        vatIncluded: true,
        isCodeRedemptionOnly: false,
        isFeatured: false,
        taxSkuId: 'FN_Currency',
        merchantGroup: 'FN_MKT',
        priceTier: `USD_${(p.cents / 100).toFixed(2).replace('.', '_')}`,
        urlSlug: `fortnite--${p.key}-currency-pack`,
        roleNamesToGrant: [],
        tags: [],
        purchaseLimit: -1,
        ignoreOrder: false,
        fulfillToGroup: false,
        fraudItemType: 'Currency',
        shareRevenue: false,
        offerType: 'OTHERS',
        unsearchable: false,
        releaseInfo: [],
        currencyDecimals: 2,
      };
    }
    return out;
  }

  /** Remember which account used the store from which address (the checkout page has no token). */
  const clean = (ip) => String(ip || '').replace(/^::ffff:/, '');

  function noteVisitor(rawIp, accountId) {
    if (!accountId) return;
    const ip = clean(rawIp);
    if (!recentByIp.has(ip)) recentByIp.set(ip, new Map());
    recentByIp.get(ip).set(accountId, Date.now());
  }

  function candidates(rawIp) {
    const now = Date.now();
    const seen = recentByIp.get(clean(rawIp)) || new Map();
    return [...seen]
      .filter(([, t]) => now - t < IDENTITY_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => accounts.get(id))
      .filter(Boolean)
      .map((a) => ({ id: a.id, displayName: a.displayName }));
  }

  function buildFor(account) {
    return (account.lastBuild && versions.fromBuildString(account.lastBuild)) || versions.fallback;
  }

  /** Grant a pack. Returns the receipt; idempotent per transactionId. */
  function complete({ accountId, offerId }) {
    if (!config.store.fakeVbucksPurchases) throw Errors.missingPermission('gallium:store', 'PURCHASE');
    const pack = byAnyId(offerId);
    if (!pack) throw Errors.offerNotFound(offerId);
    const account = accounts.require(accountId);
    const build = buildFor(account);
    const transactionId = `GALLIUM-${hexId().toUpperCase()}`;
    const balance = profiles.withProfiles(account.id, build, (get) => {
      const core = get('common_core');
      grantMtx(core, pack.vbucks);
      if (build.adapter.currencyProfile === 'profile0') mirrorToProfile0(get('profile0'), balanceOf(core));
      const iap = structuredClone(core.stat('in_app_purchases') || {});
      iap.receipts = [...(iap.receipts || []), `EPIC:${transactionId}`];
      iap.fulfillmentCounts = { ...(iap.fulfillmentCounts || {}), [pack.epicOfferId]: (iap.fulfillmentCounts?.[pack.epicOfferId] || 0) + 1 };
      core.setStat('in_app_purchases', iap);
      return balanceOf(core);
    });
    sLog.info(`${account.displayName} got ${pack.vbucks} V-Bucks from the store (receipt ${transactionId}, balance ${balance})`);
    return {
      transactionId,
      balance,
      pack: { title: pack.title, vbucks: pack.vbucks },
      receipt: {
        offers: [{ offerNamespace: 'fn', offerId: pack.epicOfferId, quantity: 1, items: [{ itemId: sha256Hex(`gallium-item:${pack.key}`).slice(0, 32), entitlementId: transactionId, validationInfo: transactionId }] }],
        transactionState: 'Purchased',
        transactionId,
      },
    };
  }

  /** Receipts the client reports back (VerifyRealMoneyPurchase): true when already fulfilled. */
  function isFulfilled(core, payload) {
    const text = JSON.stringify(payload || {});
    const known = core.stat('in_app_purchases')?.receipts || [];
    return known.some((r) => text.includes(r.replace(/^EPIC:/, '')));
  }

  return {
    packs: () => packs.map(({ key, vbucks, bonus, cents, title, epicOfferId, catalogOfferId }) => ({ key, vbucks, bonus, cents, title, epicOfferId, catalogOfferId })),
    pack: byAnyId,
    catalogEntries,
    bulkOffers,
    noteVisitor,
    candidates,
    complete,
    isFulfilled,
    stamp: isoNow,
  };
}
