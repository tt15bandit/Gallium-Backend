import { Errors } from '../../../core/errors.js';
import { guid, isoNow } from '../../../core/util.js';
import { balanceOf, mirrorToProfile0, spend, grant as grantMtx } from '../../profiles/currency.js';
import { grantItem, ownsItem, revokeItem } from '../../profiles/grants.js';
import { command, optionalString, requireArray, requireInt, requireString } from './helpers.js';

function priceOf(entry) {
  const price = entry.prices?.[0];
  if (!price) throw Errors.invalidParameter(`Offer ${entry.offerId} has no price`);
  if (price.currencyType !== 'MtxCurrency') throw Errors.invalidParameter(`Only MtxCurrency offers can be purchased (offer uses ${price.currencyType})`);
  return price.finalPrice;
}

/** Keep the profile0 mirror in sync on builds that read V-Bucks from profile0. */
function syncMirror(cmd, core) {
  if (cmd.adapter.currencyProfile === 'profile0') mirrorToProfile0(cmd.getProfile('profile0'), balanceOf(core));
}

function chargeOrThrow(cmd, amount) {
  const core = cmd.getProfile('common_core');
  const balance = balanceOf(core);
  if (balance < amount) throw Errors.insufficientCurrency(amount, balance);
  if (amount > 0) spend(core, amount);
  syncMirror(cmd, core);
  return core;
}

export const purchaseCommands = {
  PurchaseCatalogEntry: command(
    (cmd) => {
      const b = cmd.body;
      const offerId = requireString(b, 'offerId', { max: 256 });
      const quantity = requireInt(b, 'purchaseQuantity', { min: 1, max: 100, fallback: 1 });
      const offer = cmd.services.catalog.findOffer(offerId, cmd.build);
      if (!offer) throw Errors.offerNotFound(offerId);
      const unit = priceOf(offer.entry);
      const total = unit * quantity;
      if (b.expectedTotalPrice !== undefined && Number(b.expectedTotalPrice) !== total) throw Errors.priceMismatch(b.expectedTotalPrice, total);

      let lootResult;
      if (offer.battlePass) {
        // Battle pass / tier offers configured in data/battlepass/season<N>.json.
        const athena = cmd.getProfile('athena');
        cmd.services.progression.checkBattlePassOffer(athena, offer.battlePass, quantity, cmd.build);
        chargeOrThrow(cmd, total);
        lootResult = cmd.services.progression.applyBattlePassOffer(cmd.getProfile, offer.battlePass, quantity, cmd.build);
      } else {
        if (quantity !== 1) throw Errors.validation('Cosmetic offers can only be purchased once');
        const grants = offer.entry.itemGrants || [];
        if (!grants.length) throw Errors.invalidParameter(`Offer ${offerId} grants nothing`);
        if (grants.every((g) => ownsItem(cmd.getProfile, g.templateId))) throw Errors.alreadyOwned();
        chargeOrThrow(cmd, total);
        lootResult = grants.map((g) => grantItem(cmd.getProfile, g.templateId, g.quantity || 1, cmd.services.cosmetics)).filter(Boolean);
      }

      const core = cmd.getProfile('common_core');
      const history = structuredClone(core.stat('mtx_purchase_history') || { refundsUsed: 0, refundCredits: 3, purchases: [] });
      history.purchases = history.purchases || [];
      history.purchases.push({
        purchaseId: guid(),
        offerId,
        purchaseDate: isoNow(),
        freeRefundEligible: false,
        fulfillments: [],
        lootResult,
        totalMtxPaid: total,
        metadata: {},
        gameContext: optionalString(b, 'gameContext'),
      });
      core.setStat('mtx_purchase_history', history);
      cmd.notify({ type: 'CatalogPurchase', primary: true, lootResult: { items: lootResult } });
    },
    { profiles: ['common_core', 'profile0'] },
  ),

  RefundMtxPurchase: command(
    (cmd) => {
      const purchaseId = requireString(cmd.body, 'purchaseId', { max: 128 });
      const core = cmd.getProfile('common_core');
      const history = structuredClone(core.stat('mtx_purchase_history') || { refundsUsed: 0, refundCredits: 3, purchases: [] });
      const purchase = (history.purchases || []).find((p) => p.purchaseId === purchaseId);
      if (!purchase || purchase.refundDate) throw Errors.purchaseNotFound(purchaseId);
      if ((history.refundCredits ?? 0) <= 0) throw Errors.invalidParameter('No refund tickets remaining');
      for (const loot of purchase.lootResult || []) {
        if (loot.itemType.toLowerCase().startsWith('currency:')) continue;
        revokeItem(cmd.getProfile, loot.itemGuid, loot.itemProfile);
      }
      grantMtx(core, purchase.totalMtxPaid || 0);
      syncMirror(cmd, core);
      purchase.refundDate = isoNow();
      history.refundsUsed = (history.refundsUsed || 0) + 1;
      history.refundCredits = (history.refundCredits ?? 3) - 1;
      core.setStat('mtx_purchase_history', history);
    },
    { profiles: ['common_core'] },
  ),

  GiftCatalogEntry: command(
    (cmd) => {
      const b = cmd.body;
      const { services } = cmd;
      const offerId = requireString(b, 'offerId', { max: 256 });
      const receivers = [...new Set(requireArray(b, 'receiverAccountIds', { max: 16, of: 'string' }))];
      if (!receivers.length) throw Errors.validation('receiverAccountIds must not be empty');
      const offer = services.catalog.findOffer(offerId, cmd.build);
      if (!offer || offer.battlePass) throw Errors.offerNotFound(offerId);
      if (offer.entry.giftInfo && offer.entry.giftInfo.bIsEnabled === false) throw Errors.invalidParameter(`Offer ${offerId} cannot be gifted`);
      const total = priceOf(offer.entry) * receivers.length;
      if (b.expectedTotalPrice !== undefined && Number(b.expectedTotalPrice) !== total) throw Errors.priceMismatch(b.expectedTotalPrice, total);
      const wrap = optionalString(b, 'giftWrapTemplateId') || 'GiftBox:gb_default';
      const message = optionalString(b, 'personalMessage').slice(0, 100);

      // Validate every receiver before charging anything.
      const receiverProfiles = receivers.map((rid) => {
        if (rid === cmd.accountId) throw Errors.validation('You cannot gift yourself');
        if (!services.accounts.get(rid)) throw Errors.accountNotFound(rid);
        if (!services.friends.areFriends(cmd.accountId, rid)) throw Errors.giftsDisabled(rid);
        const loaded = new Map();
        const get = (pid) => {
          if (!loaded.has(pid)) loaded.set(pid, services.profiles.load(rid, pid, cmd.build));
          return loaded.get(pid);
        };
        if (get('common_core').stat('allowed_to_receive_gifts', true) === false) throw Errors.giftsDisabled(rid);
        if (offer.entry.itemGrants.every((g) => ownsItem(get, g.templateId))) throw Errors.alreadyOwned();
        return { rid, get, loaded };
      });

      chargeOrThrow(cmd, total);
      const now = isoNow();
      for (const { rid, get, loaded } of receiverProfiles) {
        const lootList = offer.entry.itemGrants.map((g) => grantItem(get, g.templateId, g.quantity || 1, services.cosmetics)).filter(Boolean);
        get('common_core').addItem(guid(), wrap, { fromAccountId: cmd.accountId, lootList, params: { userMessage: message }, level: 1, giftedOn: now }, 1);
        for (const p of loaded.values()) services.profiles.save(p);
        cmd.afterCommit(() => services.xmpp.sendJson(rid, { type: 'com.epicgames.gift.received', payload: {}, timestamp: now }));
      }

      const core = cmd.getProfile('common_core');
      const gifts = structuredClone(core.stat('gift_history') || {});
      gifts.num_sent = (gifts.num_sent || 0) + receivers.length;
      gifts.sentTo = { ...(gifts.sentTo || {}) };
      for (const rid of receivers) gifts.sentTo[rid] = now;
      core.setStat('gift_history', gifts);
    },
    { profiles: ['common_core'] },
  ),

  RemoveGiftBox: command(
    (cmd) => {
      const ids = Array.isArray(cmd.body.giftBoxItemIds) ? cmd.body.giftBoxItemIds : [requireString(cmd.body, 'giftBoxItemId', { max: 128 })];
      for (const id of ids) {
        const entry = cmd.profile.findItem(id);
        if (!entry || !entry.item.templateId.toLowerCase().startsWith('giftbox:')) throw Errors.itemNotFound(id);
        cmd.profile.removeItem(entry.id);
      }
    },
    { profiles: ['common_core', 'athena'] },
  ),
};
