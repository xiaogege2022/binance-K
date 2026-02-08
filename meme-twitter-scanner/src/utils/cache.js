/**
 * Simple in-memory cache with TTL support
 */
class Cache {
  constructor(ttlMinutes = 30) {
    this.store = new Map();
    this.ttl = ttlMinutes * 60 * 1000;
  }

  set(key, value) {
    this.store.set(key, {
      value,
      expires: Date.now() + this.ttl,
    });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expires) {
        this.store.delete(key);
      }
    }
  }
}

module.exports = Cache;
