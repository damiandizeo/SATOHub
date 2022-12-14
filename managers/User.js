"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.User = void 0;

var _Lock = require("./Lock");

/* modules */
const crypto = require('crypto');

const {
  decodeRawHex
} = require('../btc-decoder');

const config = require('../config');
/* managers */


class User {
  constructor(redis, lightningClient) {
    this._redis = redis;
    this._lightningClient = lightningClient;
    this._userId = false;
    this._user = false;
    this._password = false;
  }
  /* auth */


  async create(userId = null, user = null, password = null) {
    let buffer = null;

    if (!user) {
      let buffer = crypto.randomBytes(10);
      user = buffer.toString('hex');
    }

    if (!password) {
      buffer = crypto.randomBytes(10);
      password = buffer.toString('hex');
    }

    if (!userId) {
      buffer = crypto.randomBytes(24);
      userId = buffer.toString('hex');
    }

    this._user = user;
    this._password = password;
    this._userId = userId;
    await this.saveUserToDatabase();
    return {
      user,
      password
    };
  }

  async loadByUserAndPassword(user, password) {
    let userId = await this._redis.get('sato_user_' + user + '_' + this.hash(password));

    if (userId) {
      this._userId = userId;
      this._user = user;
      this._password = password;
      await this.generateAccessToken();
      return true;
    }

    return false;
  }

  async loadByAuthorization(authorization) {
    if (!authorization) return false;
    let access_token = authorization.replace('Bearer ', '');
    let userId = await this._redis.get('sato_userId_for_' + access_token);

    if (userId) {
      this._userId = userId;
      return true;
    }

    return false;
  }

  async loadByDomain(domain) {
    let userId = await this._redis.get('sato_user_for_domain_' + domain);

    if (userId) {
      this._userId = userId;
      return true;
    }

    return false;
  }

  async generateAccessToken() {
    let buffer = crypto.randomBytes(20);
    this._access_token = buffer.toString('hex');
    await this._redis.set('sato_userId_for_' + this._access_token, this._userId);
  }
  /* utils */


  makePreimage() {
    let buffer = crypto.randomBytes(32);
    return buffer.toString('hex');
  }

  hash(string) {
    return crypto.createHash('sha256').update(string).digest().toString('hex');
  }

  static shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }

    return a;
  }

  static async sleep(s) {
    return new Promise(r => setTimeout(r, s * 1000));
  }
  /* lightning utils */


  async decodeInvoice(invoice) {
    return new Promise((resolve, reject) => {
      this._lightningClient.decodePayReq({
        pay_req: invoice
      }, (err, decodedInvoice) => {
        if (err) return resolve({});
        delete decodedInvoice['descriptionhash'];
        delete decodedInvoice['route_hints'];
        delete decodedInvoice['features'];
        delete decodedInvoice['payment_addr'];
        decodedInvoice['timestamp'] = +decodedInvoice['timestamp'] * 1000;
        return resolve(decodedInvoice);
      });
    });
  }
  /* setters */


  async generateAddress() {
    if (await this.getAddress()) return true;
    return new Promise((resolve, reject) => {
      this._lightningClient.newAddress({
        type: 0
      }, async (err, newAddressRes) => {
        if (err) return resolve(false);
        if (await this.getAddress()) return resolve(true);

        if (newAddressRes.address) {
          await this.saveAddress(newAddressRes.address);
          return resolve(true);
        }

        return resolve(false);
      });
    });
  }

  async saveAddress(address) {
    await this._redis.set('sato_address_for_user_' + this._userId, address);
  }

  async saveBalance(balance) {
    await this._redis.set('sato_balance_for_user_' + this._userId, balance);
    await this._redis.expire(key, 1800);
  }

  async saveUserToDatabase() {
    await this._redis.set('sato_user_' + this._user + '_' + this.hash(this._password), this._userId);
  }

  async saveOnChainTransaction(txid) {
    return await this._redis.rpush('sato_onchain_transactions_spent_by_user_' + this._userId, txid);
  }

  async saveInvoiceGenerated(invoice, preimage) {
    let decodedInvoice = await this.decodeInvoice(invoice);
    await this._redis.set('sato_user_for_payment_hash_' + decodedInvoice.payment_hash, this._userId);
    await this._redis.set('sato_preimage_for_payment_hash_' + decodedInvoice.payment_hash, preimage);
    await this._redis.expire('sato_preimage_for_payment_hash_' + decodedInvoice.payment_hash, +decodedInvoice.expiry);
    await this._redis.rpush('sato_invoices_generated_by_user_' + this._userId, invoice);
    return true;
  }

  async savePaidInvoice(paymentRequest) {
    return await this._redis.rpush('sato_invoices_paid_by_user_' + this._userId, paymentRequest);
  }

  async savePaymentHashPaid(paymentHash) {
    return await this._redis.set('sato_user_for_payment_hash_paid_' + paymentHash, this._userId);
  }

  async lockFunds(invoice) {
    return this._redis.rpush('sato_locked_payments_for_user_' + this._userId, invoice);
  }

  async setDomain(domain) {
    await this._redis.setnx('sato_user_for_domain_' + domain, this._userId);
    await this._redis.setnx('sato_domain_for_user_' + this._userId, domain);
    return true;
  }

  async addProduct(productId) {
    await this._redis.setnx('sato_user_for_domain_' + productId, this._userId);
    return true;
  }
  /* getters */


  getUserId() {
    return this._userId;
  }

  getLogin() {
    return this._user;
  }

  getPassword() {
    return this._password;
  }

  getAccessToken() {
    return this._access_token;
  }

  async getAddress() {
    return await this._redis.get('sato_address_for_user_' + this._userId);
  }

  async getBalance() {
    let calculatedBalance = 0;
    /* balance from onchain transactions */

    let onChainTransactions = await this.getOnChainTransactions();

    for (let onChainTransaction of onChainTransactions) {
      calculatedBalance += +onChainTransaction.amount;
    }
    /* balance from invoices paid */


    let invoices = await this.getInvoicesGenerated();

    for (let invoiceGenerated of invoices) {
      if (invoiceGenerated.ispaid) {
        calculatedBalance += +invoiceGenerated.num_satoshis;
      }
    }
    /* balance from invoices paid */


    let invoicesPaid = await this.getInvoicesPaid();

    for (let invoicePaid of invoicesPaid) {
      calculatedBalance -= +invoicePaid.num_satoshis;
    }
    /* balance from locked payments */


    let lockedPayments = await this.getLockedPayments();

    for (let lockedPayment of lockedPayments) {
      calculatedBalance -= +lockedPayment.num_satoshis;
    }

    return calculatedBalance;
  }

  async getUserIdByPaymentHash(paymentHash) {
    return await this._redis.get('sato_user_for_payment_hash_' + paymentHash);
  }

  async getPayerByPaymentHash(paymentHash) {
    return await this._redis.get('sato_user_for_payment_hash_paid_' + paymentHash);
  }

  async getPreimageByPaymentHash(paymentHash) {
    return await this._redis.get('sato_preimage_for_payment_hash_' + paymentHash);
  }
  /* deletters */


  async clearBalanceCache() {
    return this._redis.del('sato_balance_for_user_' + this._userId);
  }

  async unlockFunds(invoice) {
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userId, 0, -1);

    for (let lockedPayment of lockedPayments) {
      if (lockedPayment != invoice) {
        await this._redis.rpush('sato_locked_payments_for_user_' + this._userId, lockedPayment);
      }
    }
  }

  async lookupInvoice(paymentHash) {
    return new Promise((resolve, reject) => {
      this._lightningClient.lookupInvoice({
        rhash_str: paymentHash
      }, (err, lookupInvoice) => {
        if (err) return resolve({});
        return resolve(lookupInvoice);
      });
    });
  }

  async syncInvoicePaid(paymentHash) {
    const invoice = await this.lookupInvoice(paymentHash);
    const ispaid = invoice.settled;

    if (ispaid) {
      await this.savePaymentHashPaid(paymentHash);
      await this.clearBalanceCache();
    }

    return ispaid;
  }

  async getOnChainTransactions() {
    let onChainTransactions = [];
    let address = await this.getAddress();
    let txsIds = await this._redis.lrange('sato_onchain_transactions_spent_by_user_' + this._userId, 0, -1);
    return new Promise((resolve, reject) => {
      this._lightningClient.getTransactions({}, (err, onChainTransactionsRes) => {
        if (err) return resolve([]);
        onChainTransactionsRes.transactions.filter(tx => !tx.label.includes('openchannel')).map(tx => {
          delete tx['raw_tx_hex'];

          if (tx.label == 'external' && txsIds.includes(tx.tx_hash)) {
            tx.address = address;
          } else {
            tx.output_details.some((vout, i) => {
              if (vout.address == address) {
                tx.address = address;
                return true;
              }
            });
          }

          tx.type = 'bitcoin_tx';
          onChainTransactions.push(tx);
        });
        return resolve(onChainTransactions.filter(tx => {
          return tx.address == address;
        }));
      });
    });
  }

  async getInvoicesGenerated() {
    let invoices = [];
    let userInvoices = await this._redis.lrange('sato_invoices_generated_by_user_' + this._userId, 0, -1);

    for (let invoice of userInvoices) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      let payerUserId = await this.getPayerByPaymentHash(decodedInvoice.payment_hash);
      decodedInvoice.type = 'invoice_generated';

      if (payerUserId) {
        decodedInvoice.ispaid = true;

        if (payerUserId == 'sato') {
          decodedInvoice.domain = 'sato';
        } else {
          let payerDomain = await this._redis.get('sato_domain_for_user_' + payerUserId);
          if (payerDomain) decodedInvoice.domain = payerDomain;
        }

        invoices.push(decodedInvoice);
      }
    }

    return invoices;
  }

  async getInvoicesPaid() {
    let invoicesPaid = [];
    let userInvoicesPaid = await this._redis.lrange('sato_invoices_paid_by_user_' + this._userId, 0, -1);

    for (let invoice of userInvoicesPaid) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      decodedInvoice.type = 'invoice_paid';
      let payerUserId = await this.getUserIdByPaymentHash(decodedInvoice.payment_hash);

      if (payerUserId) {
        let payerDomain = await this._redis.get('sato_domain_for_user_' + payerUserId);
        if (payerDomain) decodedInvoice.domain = payerDomain;
      }

      invoicesPaid.push(decodedInvoice);
    }

    return invoicesPaid;
  }

  async getLockedPayments() {
    let payments = [];
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userId, 0, -1);
    let result = [];

    for (let invoice of lockedPayments) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      decodedInvoice.type = 'invoice_pending';
      payments.push(decodedInvoice);
    }

    return payments;
  }

}

exports.User = User;