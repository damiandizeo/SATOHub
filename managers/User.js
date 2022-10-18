"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.User = void 0;

var _crypto = _interopRequireDefault(require("crypto"));

var _btcDecoder = require("../btc-decoder");

var _config = _interopRequireDefault(require("../config"));

var _Lock = require("./Lock");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/* modules */

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
      let buffer = _crypto.default.randomBytes(10);

      login = buffer.toString('hex');
    }

    if (!password) {
      buffer = _crypto.default.randomBytes(10);
      password = buffer.toString('hex');
    }

    if (!userid) {
      buffer = _crypto.default.randomBytes(24);
      userid = buffer.toString('hex');
    }

    this._login = login;
    this._password = password;
    this._userid = userid;
    await this.saveUserToDatabase();
  }

  async loadByLoginAndPassword(login, password) {
    let userid = await this._redis.get('user_' + login + '_' + this.hash(password));

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
    let userid = await this._redis.get('userid_for_' + access_token);

    if (userid) {
      this._userid = userid;
      return true;
    }

    return false;
  }

  async generateAccessToken() {
    let buffer = _crypto.default.randomBytes(20);

    this._access_token = buffer.toString('hex');
    await this._redis.set('userid_for_' + this._access_token, this._userid);
  }
  /* utils */


  makePreimage() {
    let buffer = _crypto.default.randomBytes(32);

    return buffer.toString('hex');
  }

  hash(string) {
    return _crypto.default.createHash('sha256').update(string).digest().toString('hex');
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
    await this._redis.set('address_for_' + this._userid, address);
  }

  async saveBalance(balance) {
    const key = 'balance_for_' + this._userid;
    await this._redis.set(key, balance);
    await this._redis.expire(key, 1800);
  }

  async saveUserToDatabase() {
    await this._redis.set('user_' + this._login + '_' + this.hash(this._password), this._userid);
  }

  async savePaidInvoice(payment_request) {
    await this._redis.rpush('invoices_paid_for_' + this._userid, payment_request);
  }

  async saveUTXOSpent(txid) {
    return await this._redis.rpush('onchain_transactions_for_' + this._userid, txid);
  }

  async saveUserInvoice(invoice) {
    let decodedInvoice = await that._lightningClient.decodePayReq({
      pay_req: invoice.payment_request
    });
    await this._redis.set('paymenthash_' + decodedInvoice.paymenthash, this._userid);
    return await this._redis.rpush('invoices_generated_for_' + this._userid, invoice.payment_request);
  }

  async savePaymentHashPaid(paymenthash, isPaid) {
    return await this._redis.set('invoice_ispaid_' + paymenthash, isPaid);
  }

  async savePreimage(preimage, expiry) {
    const paymentHash = _crypto.default.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');

    const key = 'preimage_for_' + paymentHash;
    await this._redis.set(key, preimage);
    await this._redis.expire(key, expiry);
  }

  async lockFunds(payment_request) {
    return this._redis.rpush('locked_payments_for_' + this._userid, payment_request);
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
    return await this._redis.get('address_for_' + this._userid);
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
    return await this._redis.get('paymenthash_' + paymentHash);
  }

  async getPaymentHashPaid(paymentHash) {
    return await this._redis.get('invoice_ispaid_' + paymentHash);
  }

  async getPreimageByPaymentHash(paymentHash) {
    return await this._redis.get('preimage_for_' + paymentHash);
  }
  /* deletters */


  async clearBalanceCache() {
    const key = 'balance_for_' + this._userid;
    return this._redis.del(key);
  }

  async unlockFunds(payment_request) {
    let lockedPayments = await this._redis.lrange('locked_payments_for_' + this._userid, 0, -1);

    for (let lockedPayment of lockedPayments) {
      if (lockedPayment != payment_request) {
        await this._redis.rpush('locked_payments_for_' + this._userid, lockedPayment);
      }
    }
  }

  async lookupInvoice(paymenthash) {
    return await that._lightningClient.lookupInvoice({
      rhash_str: paymenthash
    });
  }

  async syncInvoicePaid(paymenthash) {
    const invoice = await this.lookupInvoice(paymenthash);
    const ispaid = invoice.settled;

    if (ispaid) {
      await this.savePaymentHashPaid(paymenthash, true);
      await this.clearBalanceCache();
    }

    return ispaid;
  }

  async getUserInvoices() {
    let invoices = [];
    let userInvoices = await this._redis.lrange('invoices_generated_for_' + this._userid, 0, -1);

    for (let userInvoice of userInvoices) {
      userInvoice = JSON.parse(userInvoice);
      let decodedInvoice = await that._lightningClient.decodePayReq({
        pay_req: invoice.payment_request
      });
      decodedInvoice.ispaid = (await this.getPaymentHashPaid(invoice.paymenthash)) || false;
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
    let userOnChainTransactions = await this._redis.lrange('onchain_transactions_for_' + this._userid, 0, -1);

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
    let userInvoicesPaid = await this._redis.lrange('invoices_paid_for_' + this._userid, 0, -1);

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
    let lockedPayments = await this._redis.lrange('locked_payments_for_' + this._userid, 0, -1);
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