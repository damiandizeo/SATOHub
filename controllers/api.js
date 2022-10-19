"use strict";

var _managers = require("../managers");

/* modules */
const express = require('express');

const expressRateLimit = require('express-rate-limit');

const Redis = require('ioredis');

const crypto = require('crypto');
/* config */


const config = require('../config');
/* managers */


const lightningClient = require('../lightning');
/* global */


global.forwardFee = 0;
global.internalFee = 0;
/* variables */

let lightningIdentityPubKey = null;
let lightningDescribeGraph = {};
/* initialize express */

let router = express.Router();
let postLimiter = expressRateLimit({
  windowMs: 30 * 60 * 1000,
  max: 100
});
/* initialize Redis */

let redis = new Redis(config.redis);
redis.info((err, info) => {
  if (err || !info) {
    console.error('Redis failed to start', err);
    process.exit(5);
  }
});
/* lightning apis */

lightningClient.getInfo({}, (err, info) => {
  if (err) {
    console.error('LND failed to start', err);
    process.exit(3);
  }

  if (info) {
    if (!info.synced_to_chain && !config.forceStart) {
      console.error('LND not synced');
    }

    lightningIdentityPubKey = info.lightningIdentityPubKey;
  }
});
let call = lightningClient.channelAcceptor({});
call.on('data', response => {
  call.write({
    accept: true,
    pending_chan_id: response.pending_chan_id,
    csv_delay: response.csv_delay,
    reserve_sat: response.channel_reserve,
    in_flight_max_msat: response.max_value_in_flight,
    max_htlc_count: response.max_accepted_htlcs,
    min_htlc_in: parseInt(response.min_htlc),
    min_accept_depth: 0,
    zero_conf: true
  });
});
let subscribeInvoicesCall = lightningClient.subscribeInvoices({});
subscribeInvoicesCall.on('data', async response => {
  if (response.state === 'SETTLED') {
    let user = new _managers.User(redis, lightningClient);
    user._userid = await user.getUserIdByPaymentHash(paymentHash);
    user.savePaymentHashPaid(paymentHash, true);
    /* send PN to user id */

    console.log(userId);
  }
});

function updateDescribeGraph() {
  lightningClient.describeGraph({
    include_unannounced: true
  }, (err, response) => {
    if (!err) lightningDescribeGraph = response;
  });
}

updateDescribeGraph();
setInterval(updateDescribeGraph, 120000);
/* express routers */

const loadAuthorizedUser = async authorization => {
  let user = new _managers.User(redis, lightningClient);

  if (!(await user.loadByAuthorization(authorization))) {
    return null;
  }

  return user;
};

router.post('/create', postLimiter, async (req, res) => {
  /* params */
  const {
    partnerid,
    userid,
    login,
    password
  } = req.body;
  console.log(userid, '/create', JSON.stringify(req.body));

  if (partnerid == 'satowallet') {
    let user = new _managers.User(redis, lightningClient);
    let newUser = await user.create(userid, login, password);
    return res.send({
      secret: `${newUser.login}:${newUser.password}`
    });
  } else {
    return res.send({
      secret: null
    });
  }
});
router.post('/login', postLimiter, async (req, res) => {
  /* params */
  const {
    login,
    password
  } = req.body;
  console.log('/login', JSON.stringify(req.body));

  if (login && password) {
    let user = new _managers.User(redis, lightningClient);

    if ((await user.loadByLoginAndPassword(login, password)) == true) {
      return res.send({
        access_token: user.getAccessToken()
      });
    }
  }

  return res.send({
    access_token: null
  });
});
router.post('/addinvoice', postLimiter, async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  /* params */

  const {
    amount,
    description,
    expiry = 3600 * 24
  } = req.body;
  console.log(user.getUserId(), '/addInvoice', JSON.stringify(req.body));
  let preimage = user.makePreimage();
  lightningClient.addInvoice({
    value: amount,
    memo: description,
    expiry: expiry,
    r_preimage: Buffer.from(preimage, 'hex').toString('base64')
  }, async (err, invoice) => {
    if (err) return res.send({
      error: 'unable to add invoice'
    });
    await user.saveInvoiceGenerated(invoice.payment_request, preimage);
    return res.send({
      payment_request: invoice.payment_request
    });
  });
});
router.post('/payinvoice', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    invoice,
    amount
  } = req.body;
  console.log(user.getUserId(), '/payinvoice', JSON.stringify(req.body));
  let lock = new _managers.Lock(redis, 'sato_invoice_paying_for_' + user.getUserId());

  if (!(await lock.obtainLock())) {
    return res.send({
      error: 'something went wrong. Please try again later'
    });
  }

  let userBalance = await user.getBalance();
  console.log(user.getUserId(), 'balance', userBalance);
  lightningClient.decodePayReq({
    pay_req: invoice
  }, async (err, decodedInvoice) => {
    if (err || !decodedInvoice) {
      lock.releaseLock();
      return res.send({
        error: 'invoice not valid'
      });
    }

    amount = decodedInvoice.num_satoshis ? +decodedInvoice.num_satoshis : amount;

    if (!amount) {
      await lock.releaseLock();
      return res.send({
        error: 'amount not specified'
      });
    }

    console.log(user.getUserId(), 'invoice amount', amount);

    if (userBalance >= amount) {
      console.log(user.getUserId(), lightningIdentityPubKey, decodedInvoice.destination);

      if (lightningIdentityPubKey === decodedInvoice.destination) {
        /* internal payment */
        if (await user.getPaymentHashPaid(decodedInvoice.payment_hash)) {
          lock.releaseLock();
          return res.send({
            error: 'invoice already paid'
          });
        }

        console.log(user.getUserId(), 'invoice not paid');
        await user.savePaidInvoice(invoice);
        console.log(user.getUserId(), 'savePaidInvoice');
        await user.savePaymentHashPaid(decodedInvoice.payment_hash, true);
        console.log(user.getUserId(), 'savePaymentHashPaid');
        await lock.releaseLock();
        console.log(user.getUserId(), 'releaseLock');
        let preimage = await user.getPreimageByPaymentHash(decodedInvoice.payment_hash);
        console.log(user.getUserId(), 'preimage', preimage);
        return res.send({
          payment_request: invoice,
          payment_preimage: preimage
        });
      } else {
        /* external payment */
        var call = lightningClient.sendPayment();
        call.on('data', async payment => {
          await user.unlockFunds(invoice);

          if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
            await user.savePaidInvoice(invoice);
            lock.releaseLock();
            return res.send({
              payment_request: invoice,
              payment_preimage: payment.payment_preimage
            });
          } else {
            lock.releaseLock();
            return res.send({
              error: 'unable to pay invoice'
            });
          }
        });
        await user.lockFunds(invoice);
        call.write({
          payment_request: invoice,
          amt: amount
        });
      }
    } else {
      lock.releaseLock();
      return res.send({
        error: 'not enough balance'
      });
    }
  });
});
router.post('/sendcoins', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    address,
    amount
  } = req.body;
  console.log(user.getUserId(), '/sendcoins', JSON.stringify(req.body));
  let userBalance = await user.getBalance();
  console.log(user.getUserId(), 'balance', userBalance);

  if (userBalance >= amount) {
    lightningClient.sendCoins({
      addr: address,
      amount: amount
    }, (err, sendCoinsRes) => {
      if (err) return res.send({
        error: 'unable to send coins'
      });
      user.saveOnChainTransaction(sendCoinsRes.txid);
      return res.send({
        txid: sendCoinsRes.txid
      });
    });
  } else {
    return res.send({
      error: 'not enough balance'
    });
  }
});
router.get('/address', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  console.log(user.getUserId(), '/address');

  if (await user.generateAddress()) {
    let address = await user.getAddress();
    return res.send({
      address: address
    });
  }

  return res.send({
    error: 'unable to generate address'
  });
});
router.get('/balance', postLimiter, async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  console.log(user.getUserId(), '/balance');
  return res.send({
    balance: await user.getBalance()
  });
});
router.get('/transactions', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  console.log(user.getUserId(), '/transactions');
  /* onchain transactions */

  let onChainTransactions = await user.getOnChainTransactions();
  console.log(user.getUserId(), 'onChainTransactions', JSON.stringify(onChainTransactions));
  /* user invoices */

  let invoicesGenerated = await user.getInvoicesGenerated();
  console.log(user.getUserId(), 'invoicesGenerated', JSON.stringify(invoicesGenerated));
  /* invoices paid */

  let invoicesPaid = await user.getInvoicesPaid();
  console.log(user.getUserId(), 'invoicesPaid', JSON.stringify(invoicesPaid));
  res.send([...invoicesGenerated, ...onChainTransactions, ...invoicesPaid]);
});
router.post('/decodeinvoice', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    invoice
  } = req.body;
  console.log(user.getUserId(), '/decodeinvoice', JSON.stringify(req.body));
  lightningClient.decodePayReq({
    pay_req: invoice
  }, (err, decodedInvoice) => {
    if (err) return res.send({
      error: 'invoice not valid'
    });
    return res.send(decodedInvoice);
  });
});
module.exports = router;