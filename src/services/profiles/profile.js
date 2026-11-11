import { deepClone } from '../../core/util.js';

/**
 * An MCP profile loaded into memory. Every mutation is recorded as an MCP change entry
 * (itemAdded / itemRemoved / itemAttrChanged / itemQuantityChanged / statModified) so the
 * command layer can send incremental updates, and so the repository knows what to persist.
 */
export class Profile {
  constructor(data, { isNew = false } = {}) {
    this.accountId = data.accountId;
    this.profileId = data.profileId;
    this.rvn = data.rvn;
    this.wipeNumber = data.wipeNumber ?? 1;
    this.created = data.created;
    this.updated = data.updated;
    this.stats = data.stats || {};
    this.items = new Map(Object.entries(data.items || {}));
    this.isNew = isNew;
    // Lower-cased item id / templateId -> item id, so lookups stay O(1) on 15k+ item lockers.
    this.index = new Map();
    for (const [id, item] of this.items) this._indexItem(id, item);
    this.resetTracking();
  }

  /** Start a new command: the current state becomes the base revision. */
  resetTracking() {
    this.baseRvn = this.rvn;
    this.changes = [];
    this.dirtyItems = new Set();
    this.removedItems = new Set();
    this.statsDirty = false;
  }

  _indexItem(id, item) {
    this.index.set(id.toLowerCase(), id);
    const t = item.templateId.toLowerCase();
    if (!this.index.has(t)) this.index.set(t, id);
  }

  _unindexItem(id, item) {
    if (this.index.get(id.toLowerCase()) === id) this.index.delete(id.toLowerCase());
    const t = item.templateId.toLowerCase();
    if (this.index.get(t) === id) {
      this.index.delete(t);
      for (const [otherId, other] of this.items) {
        if (other.templateId.toLowerCase() === t) {
          this.index.set(t, otherId);
          break;
        }
      }
    }
  }

  get hasChanges() {
    return this.changes.length > 0;
  }

  /** Item by exact id, falling back to a case-insensitive id or templateId match. */
  findItem(idOrTemplate) {
    if (!idOrTemplate) return null;
    if (this.items.has(idOrTemplate)) return { id: idOrTemplate, item: this.items.get(idOrTemplate) };
    const id = this.index.get(String(idOrTemplate).toLowerCase());
    return id && this.items.has(id) ? { id, item: this.items.get(id) } : null;
  }

  itemsOfType(...types) {
    const wanted = types.map((t) => `${t.toLowerCase()}:`);
    const out = [];
    for (const [id, item] of this.items) {
      const tl = item.templateId.toLowerCase();
      if (wanted.some((w) => tl.startsWith(w))) out.push({ id, item });
    }
    return out;
  }

  addItem(itemId, templateId, attributes = {}, quantity = 1) {
    const item = { templateId, attributes: deepClone(attributes), quantity };
    const previous = this.items.get(itemId);
    if (previous) this._unindexItem(itemId, previous);
    this.items.set(itemId, item);
    this._indexItem(itemId, item);
    this.removedItems.delete(itemId);
    this.dirtyItems.add(itemId);
    this.changes.push({ changeType: 'itemAdded', itemId, item: deepClone(item) });
    return item;
  }

  removeItem(itemId) {
    const item = this.items.get(itemId);
    if (!item) return false;
    this.items.delete(itemId);
    this._unindexItem(itemId, item);
    this.dirtyItems.delete(itemId);
    this.removedItems.add(itemId);
    this.changes.push({ changeType: 'itemRemoved', itemId });
    return true;
  }

  setItemAttr(itemId, name, value) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`setItemAttr: no item ${itemId}`);
    item.attributes[name] = deepClone(value);
    this.dirtyItems.add(itemId);
    this.changes.push({ changeType: 'itemAttrChanged', itemId, attributeName: name, attributeValue: deepClone(value) });
  }

  setQuantity(itemId, quantity) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`setQuantity: no item ${itemId}`);
    item.quantity = quantity;
    this.dirtyItems.add(itemId);
    this.changes.push({ changeType: 'itemQuantityChanged', itemId, quantity });
  }

  stat(name, fallback = undefined) {
    return name in this.stats ? this.stats[name] : fallback;
  }

  setStat(name, value) {
    this.stats[name] = deepClone(value);
    this.statsDirty = true;
    this.changes.push({ changeType: 'statModified', name, value: deepClone(value) });
  }

  /** Client-facing JSON. `skipItem(id, item)` lets the caller hide items (season filters, omission groups). */
  toJSON({ skipItem = null } = {}) {
    const items = {};
    for (const [id, item] of this.items) {
      if (skipItem && skipItem(id, item)) continue;
      items[id] = item;
    }
    return {
      _id: `${this.accountId}${this.profileId}`,
      created: this.created,
      updated: this.updated,
      rvn: this.rvn,
      wipeNumber: this.wipeNumber,
      accountId: this.accountId,
      profileId: this.profileId,
      version: 'gallium_1',
      items,
      stats: { attributes: this.stats },
      commandRevision: this.rvn,
    };
  }
}
