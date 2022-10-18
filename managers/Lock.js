"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Lock = void 0;

class Lock {
  constructor(redis, lock_key) {
    this._redis = redis;
    this._lock_key = lock_key;
  }

  async obtainLock() {
    const timestamp = +new Date();
    let setResult = await this._redis.setnx(this._lock_key, timestamp);
    if (!setResult) return false;
    await this._redis.expire(this._lock_key, 5 * 60); // 5 mins

    return true;
  }

  async releaseLock() {
    await this._redis.del(this._lock_key);
  }

}

exports.Lock = Lock;