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
  /* setters */


  async generateAddress() {
    if (await this.getAddress()) return true;
    let newAddress = await this._lightningClient.newAddress({
      type: 0
    });
    if (await this.getAddress()) return true;

    if (newAddress.address) {
      await this.saveAddress(newAddress.address);
      return true;
    }

    return false;
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

  async saveUserInvoice(invoice) {
    let decodedInvoice = await that._lightningClient.decodePayReq({
      pay_req: invoice.payment_request
    });
    await this._redis.set('sato_payment_hash_for_user_' + decodedInvoice.payment_hash, this._userid);
    return await this._redis.rpush('sato_invoices_generated_by_user_' + this._userid, invoice.payment_request);
  }

  async savePaidInvoice(payment_request) {
    await this._redis.rpush('sato_invoices_paid_by_user_' + this._userid, payment_request);
  }

  async saveUTXOSpent(txid) {
    return await this._redis.rpush('sato_onchain_transactions_spent_by_user_' + this._userid, txid);
  }

  async savePaymentHashPaid(paymentHash, isPaid) {
    return await this._redis.set('sato_payment_hash_paid_' + paymentHash, isPaid);
  }

  async savePreimage(preimage, expiry) {
    const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    await this._redis.set('sato_preimage_for_payment_hash_' + paymentHash, preimage);
    await this._redis.expire('sato_preimage_for_payment_hash_' + paymentHash, expiry);
  }

  async lockFunds(payment_request) {
    return this._redis.rpush('sato_locked_payments_for_user_' + this._userid, payment_request);
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
    /* balance from invoices paid */

    let invoices = await this.getUserInvoices();

    for (let invoice of invoices) {
      if (invoice.ispaid) {
        calculatedBalance += +invoice.num_satoshis;
      }
    }
    /* balance from onchain transactions */


    let onChainTransactions = await this.getOnChainTransactions();

    for (let onChainTransaction of onChainTransactions) {
      calculatedBalance += parseFloat(onChainTransaction.amount);
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
    return await this._redis.get('sato_payment_hash_for_user_' + paymentHash);
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

  async unlockFunds(payment_request) {
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userid, 0, -1);

    for (let lockedPayment of lockedPayments) {
      if (lockedPayment != payment_request) {
        await this._redis.rpush('sato_locked_payments_for_user_' + this._userid, lockedPayment);
      }
    }
  }

  async lookupInvoice(paymentHash) {
    return await that._lightningClient.lookupInvoice({
      rhash_str: paymentHash
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

  async getUserInvoices() {
    let invoices = [];
    let userInvoices = await this._redis.lrange('sato_invoices_generated_by_user_' + this._userid, 0, -1);

    for (let userInvoice of userInvoices) {
      userInvoice = JSON.parse(userInvoice);
      let decodedInvoice = await that._lightningClient.decodePayReq({
        pay_req: invoice.payment_request
      });
      decodedInvoice.ispaid = (await this.getPaymentHashPaid(decodedInvoice.payment_hash)) || false;
      decodedInvoice.type = 'user_invoice';
      delete decodeInvoice['descriptionhash'];
      delete decodeInvoice['route_hints'];
      delete decodeInvoice['features'];
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

      if (sentTx.txid && sentTx.type == 'bitcoind_tx') {
        txsIds.push(sentTx.txid);
      }
    }

    let address = await this.getAddress();
    let onChainTransactionsRes = await this._lightningClient.getTransactions({});
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
    return onChainTransactions;
  }

  async getInvoicesPaid() {
    let invoicesPaid = [];
    let userInvoicesPaid = await this._redis.lrange('sato_invoices_paid_by_user_' + this._userid, 0, -1);

    for (let userInvoicePaid of userInvoicesPaid) {
      let decodedInvoice = await that._lightningClient.decodePayReq({
        pay_req: userInvoicePaid
      });
      decodedInvoice.type = 'invoice_paid';
      delete decodeInvoice['descriptionhash'];
      delete decodeInvoice['route_hints'];
      delete decodeInvoice['features'];
      invoicesPaid.push(decodedInvoice);
    }

    return invoicesPaid;
  }

  async getLockedPayments() {
    let payments = [];
    let lockedPayments = await this._redis.lrange('sato_locked_payments_for_user_' + this._userid, 0, -1);
    let result = [];

    for (let lockedPayment of lockedPayments) {
      lockedPayment = JSON.parse(lockedPayment);
      let decodedInvoice = await that._lightningClient.decodePayReq({
        pay_req: lockedPayment.payment_request
      });
      decodedInvoice.type = 'invoice_pending';
      delete decodeInvoice['descriptionhash'];
      delete decodeInvoice['route_hints'];
      delete decodeInvoice['features'];
      payments.push(lockedPayment);
    }

    return payments;
  }

}

exports.User = User;