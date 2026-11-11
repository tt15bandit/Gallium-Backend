import { cosmeticAttributes } from './templates.js';
import { grant as grantMtx, isMtx } from './currency.js';

/** Which profile an item template lives in. */
export function profileForTemplate(templateId) {
  const t = String(templateId).toLowerCase();
  if (t.startsWith('homebasebanner') || t.startsWith('giftbox:') || isMtx(templateId)) return 'common_core';
  if (t.startsWith('athena') || t.startsWith('cosmeticvariant') || t.startsWith('challengebundle') || t.startsWith('quest:') || t.startsWith('cosmeticlocker')) return 'athena';
  return 'athena';
}

/**
 * Grant one item template. Cosmetics are keyed by templateId so each is owned at most once;
 * V-Bucks are added to the balance. Returns the MCP loot entry, or null if it was already owned.
 */
export function grantItem(getProfile, templateId, quantity, cosmetics) {
  const profileId = profileForTemplate(templateId);
  const profile = getProfile(profileId);
  if (isMtx(templateId)) {
    grantMtx(profile, quantity);
    return { itemType: 'Currency:MtxPurchased', itemGuid: 'Currency:MtxPurchased', itemProfile: profileId, quantity };
  }
  const existing = profile.findItem(templateId);
  if (existing) {
    if (!isStackable(templateId)) return null;
    profile.setQuantity(existing.id, (existing.item.quantity || 0) + quantity);
    return { itemType: existing.item.templateId, itemGuid: existing.id, itemProfile: profileId, quantity };
  }
  const attrs = templateId.toLowerCase().startsWith('homebasebanner') ? { item_seen: false } : cosmeticAttributes(cosmetics.allVariants(templateId));
  profile.addItem(templateId, templateId, attrs, quantity);
  return { itemType: templateId, itemGuid: templateId, itemProfile: profileId, quantity };
}

export function ownsItem(getProfile, templateId) {
  if (isMtx(templateId)) return false;
  return !!getProfile(profileForTemplate(templateId)).findItem(templateId);
}

export function revokeItem(getProfile, templateId, profileId = profileForTemplate(templateId)) {
  const profile = getProfile(profileId);
  const entry = profile.findItem(templateId);
  if (!entry) return false;
  return profile.removeItem(entry.id);
}

function isStackable(templateId) {
  const t = templateId.toLowerCase();
  return t.startsWith('accountresource:') || t.startsWith('token:');
}
