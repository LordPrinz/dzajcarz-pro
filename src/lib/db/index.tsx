import { dzajcarz } from '@/app';

class DB {
  private db;
  private cache;

  constructor() {
    this.cache = dzajcarz.getCacheClient()!;
    this.db = dzajcarz.getDBClient()!;
  }

  protected async getFromCache(key: string) {
    return this.cache.get(key);
  }

  protected async setToCache(key: string, value: string) {
    return this.cache.set(key, value);
  }

  protected async query(query: string) {
    return this.db`${query}`;
  }
}

class DzajDB extends DB {
  constructor() {
    super();
    this.buildDB();
  }

  private async buildDB() {
    console.log('xd');
  }
}

export const database = new DzajDB();
