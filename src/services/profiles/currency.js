/**
 * V-Bucks helpers. common_core is the source of truth on every build; builds older than 3.5
 * read V-Bucks from profile0, which is kept as a mirror of the common_core balance.
 */
const MTX_TEMPLATES = ['currency:mtxpurchased', 'currency:mtxcomplimentary', 'currency:mtxgiveaway', 'currency:mtxpurchasebonus'];

export function isMtx(templateId) {
  return MTX_TEMPLATES.includes(String(templateId).toLowerCase());
}

export function balanceOf(profile) {
  let total = 0;
  for (const item of profile.items.values()) if (isMtx(item.templateId)) total += item.quantity || 0;
  return total;
}

/** Remove `amount` V-Bucks; caller must check the balance first. */
export function spend(profile, amount) {
  let remaining = amount;
  for (const [id, item] of profile.items) {
    if (remaining <= 0) break;
    if (!isMtx(item.templateId) || !item.quantity) continue;
    const take = Math.min(item.quantity, remaining);
    profile.setQuantity(id, item.quantity - take);
    remaining -= take;
  }
  if (remaining > 0) throw new Error('spend() called with insufficient balance');
}

export function grant(profile, amount) {
  const entry = profile.findItem('Currency:MtxPurchased');
  if (entry) profile.setQuantity(entry.id, (entry.item.quantity || 0) + amount);
  else profile.addItem('Currency:MtxPurchased', 'Currency:MtxPurchased', { platform: 'EpicPC' }, amount);
}

export function setBalance(profile, amount) {
  const current = balanceOf(profile);
  if (amount > current) grant(profile, amount - current);
  else if (amount < current) spend(profile, current - amount);
}

/** Bring profile0's mirrored balance in line with common_core. */
export function mirrorToProfile0(profile0, balance) {
  const entry = profile0.findItem('Currency:MtxPurchased');
  if (!entry) profile0.addItem('Currency:MtxPurchased', 'Currency:MtxPurchased', { platform: 'EpicPC' }, balance);
  else if (balanceOf(profile0) !== balance) {
    for (const [id, item] of profile0.items) if (isMtx(item.templateId) && id !== entry.id && item.quantity) profile0.setQuantity(id, 0);
    profile0.setQuantity(entry.id, balance);
  }
}
