"use strict";

let config = {
  redis: {
    port: 6379,
    host: '127.0.0.1',
    family: 4,
    db: 0
  },
  lnd: {
    url: '127.0.0.1:10009'
  },
  network: 'testnet'
};
module.exports = config;