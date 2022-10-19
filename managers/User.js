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
    this._userid = false;
    this._login = false;
    this._password = false;
  }
  /* auth */


  async create(userid = null, login = null, password = null) {
    let buffer = null;

    if (!login) {
      let buffer = crypto.randomBytes(10);
      login = buffer.toString('hex');
    }

    if (!password) {
      buffer = crypto.randomBytes(10);
      password = buffer.toString('hex');
    }

    if (!userid) {
      buffer = crypto.randomBytes(24);
      userid = buffer.toString('hex');
    }

    this._login = login;
    this._password = password;
    this._userid = userid;
    await this.saveUserToDatabase();
    return {
      login,
      password
    };
  }

  async loadByLoginAndPassword(login, password) {
    let userid = await this._redis.get('sato_user_' + login + '_' + this.hash(password));

    if (userid) {
      this._userid = userid;
      this._login = login;
      this._password = password;
      await this.generateAccessToken();
      return true;
    }

    return false;
  }

  async loadByAuthorization(authorization) {
    if (!authorization) return false;
    let access_token = authorization.replace('Bearer ', '');
    let userid = await this._redis.get('sato_userid_for_' + access_token);

    if (userid) {
      this._userid = userid;
      return true;
    }

    return false;
  }

  async generateAccessToken() {
    let buffer = crypto.randomBytes(20);
    this._access_token = buffer.toString('hex');
    await this._redis.set('sato_userid_for_' + this._access_token, this._userid);
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
    await this._redis.set('sato_address_for_user_' + this._userid, address);
  }

  async saveBalance(balance) {
    await this._redis.set('sato_balance_for_user_' + this._userid, balance);
    await this._redis.expire(key, 1800);
  }

  async saveUserToDatabase() {
    await this._redis.set('sato_user_' + this._login + '_' + this.hash(this._password), this._userid);
  }

  async saveInvoiceGenerated(invoice, preimage) {
    let decodedInvoice = await this.decodeInvoice(invoice);
    await this._redis.set('sato_user_for_payment_hash_' + decodedInvoice.payment_hash, this._userid);
    await this._redis.set('sato_preimage_for_payment_hash_' + decodedInvoice.payment_hash, preimage);
    await this._redis.expire('sato_preimage_for_payment_hash_' + decodedInvoice.payment_hash, +decodedInvoice.expiry);
    return await this._redis.rpush('sato_invoices_generated_by_user_' + this._userid, invoice);
  }

  async savePaidInvoice(payment_request) {
    await this._redis.rpush('sato_invoices_paid_by_user_' + this._userid, payment_request);
  }

  async saveOnChainTransaction(txid) {
    return await this._redis.rpush('sato_onchain_transactions_spent_by_user_' + this._userid, txid);
  }

  async savePaymentHashPaid(paymentHash, isPaid) {
    return await this._redis.set('sato_payment_hash_paid_' + paymentHash, isPaid);
  }

  async lockFunds(invoice) {
    return this._redis.rpush('sato_locked_payments_for_user_' + this._userid, invoice);
  }
  /* getters */


  getUserId() {
    return this._userid;
  }

  getLogin() {
    return this._login;
  }

  getPassword() {
    return this._password;
  }

  getAccessToken() {
    return this._access_token;
  }

  async getAddress() {
    return await this._redis.get('sato_address_for_user_' + this._userid);
  }

  async getBalance() {
    let calculatedBalance = 0;
    /* balance from onchain transactions */

    let onChainTransactions = await this.getOnChainTransactions();

    for (let onChainTransaction of onChainTransactions) {
      calculatedBalance += parseFloat(onChainTransaction.amount);
    }
    /* balance from invoices paid */


    let invoices = await this.getInvoicesGenerated();

    for (let invoice of invoices) {
      if (invoice.ispaid) {
        calculatedBalance += +invoice.num_satoshis;
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
      calculatedBalance -= +paym.num_satoshis;
    }

    return calculatedBalance;
  }

  async getUserIdByPaymentHash(paymentHash) {
    return await this._redis.get('sato_user_for_payment_hash_' + paymentHash);
  }

  async getPaymentHashPaid(paymentHash) {
    return await this._redis.get('sato_payment_hash_paid_' + paymentHash);
  }

  async getPreimageByPaymentHash(paymentHash) {
    return await this._redis.get('sato_preimage_for_payment_hash_' + paymentHash);
  }
  /* deletters */


  async clearBalanceCache() {
    return this._redis.del('sato_balance_for_user_' + this._userid);
  }

  async unlockFunds(invoice) {
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userid, 0, -1);

    for (let lockedPayment of lockedPayments) {
      if (lockedPayment != invoice) {
        await this._redis.rpush('sato_locked_payments_for_user_' + this._userid, lockedPayment);
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
      await this.savePaymentHashPaid(paymentHash, true);
      await this.clearBalanceCache();
    }

    return ispaid;
  }

  async getInvoicesGenerated() {
    let invoices = [];
    let userInvoices = await this._redis.lrange('sato_invoices_generated_by_user_' + this._userid, 0, -1);

    for (let invoice of userInvoices) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      decodedInvoice.ispaid = (await this.getPaymentHashPaid(decodedInvoice.payment_hash)) || false;
      decodedInvoice.type = 'invoice_generated';
      invoices.push(decodedInvoice);
    }

    return invoices;
  }

  async getOnChainTransactions() {
    let onChainTransactions = [];
    let txsIds = [];
    let userOnChainTransactions = await this._redis.lrange('sato_onchain_transactions_spent_by_user_' + this._userid, 0, -1);

    for (let userOnChainTransaction of userOnChainTransactions) {
      userOnChainTransaction = JSON.parse(userOnChainTransaction);

      if (sentTx.txid && sentTx.type == 'bitcoin_tx') {
        txsIds.push(sentTx.txid);
      }
    }

    let address = await this.getAddress();
    return new Promise((resolve, reject) => {
      this._lightningClient.getTransactions({}, (err, onChainTransactionsRes) => {
        if (err) return resolve([]);
        onChainTransactionsRes.transactions.filter(tx => !tx.label.includes('openchannel')).map(tx => {
          delete tx['raw_tx_hex'];

          if (tx.label == 'external' && txsIds.includes(tx.txhash)) {
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

  async getInvoicesPaid() {
    let invoicesPaid = [];
    let userInvoicesPaid = await this._redis.lrange('sato_invoices_paid_by_user_' + this._userid, 0, -1);

    for (let invoice of userInvoicesPaid) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      decodedInvoice.type = 'invoice_paid';
      invoicesPaid.push(decodedInvoice);
    }

    return invoicesPaid;
  }

  async getLockedPayments() {
    let payments = [];
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userid, 0, -1);
    let result = [];

    for (let invoice of lockedPayments) {
      let decodedInvoice = await this.decodeInvoice(invoice);
      decodedInvoice.type = 'invoice_pending';
      payments.push(lockedPayment);
    }

    return payments;
  }

}

exports.User = User;