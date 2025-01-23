import { dzajcarz } from '@/app';

class HybridDB {
  private cache;

  constructor() {
    this.cache = dzajcarz.getCacheClient()!;
  }

  protected async getFromCache(key: string) {
    return this.cache.get(key);
  }

  protected async setToCache(key: string, value: string) {
    return this.cache.set(key, value);
  }
}

class DzajDB extends HybridDB {
  constructor() {
    super();
  }
}

export const database = new DzajDB();
