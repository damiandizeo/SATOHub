"use strict";

var _managers = require("../managers");

/* modules */
const express = require('express');

const expressRateLimit = require('express-rate-limit');

const Redis = require('ioredis');

const crypto = require('crypto');

const fetch = require('node-fetch');
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
/* push notifications */

const sendPN = async (accountId, type, title, desc) => {
  console.log('PN', accountId, type, title, desc);
  let sendPNRes = await fetch('https://api.bysato.com/wallet_v2/messages/sendPN.php', {
    method: 'POST',
    body: JSON.stringify({
      accountId: accountId,
      type: type,
      title: title,
      desc: desc
    }),
    headers: {
      'Content-Type': 'application/json'
    }
  });
  sendPNRes = await sendPNRes.json();
  console.log('PN status', sendPNRes);
};
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

    lightningIdentityPubKey = info.identity_pubkey;
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
subscribeInvoicesCall.on('data', async invoice => {
  if (invoice.state === 'SETTLED') {
    /* send PN to user */
    let user = new _managers.User(redis, lightningClient);
    user._userId = await user.getUserIdByPaymentHash(paymentHash);

    if (user._userId) {
      await sendPN(user._userId, 'invoice_paid', 'Your invoice was paid', `You received +${invoice.value} SATs`);
    }

    let payerUser = new _managers.User(redis, lightningClient);
    payerUser._userId = 'external_node';
    await payerUser.savePaymentHashPaid(invoice.r_hash);
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
setInterval(updateDescribeGraph, 60000);
setInterval(async () => {
  const newPaymentRequest = await fetch('https://api.bysato.com/wallet_v2/onramp/pendings.php');
  const parsedNewPaymentRequest = await newPaymentRequest.json();

  if (parsedNewPaymentRequest && parsedNewPaymentRequest.length > 0) {
    for (let paymentRequest of parsedNewPaymentRequest) {
      let user = new _managers.User(redis, lightningClient);
      user._userId = paymentRequest.accountId;
      console.log(user._userId, 'paymentRequest', paymentRequest);
      let amount = +paymentRequest.payload.sats;
      let preimage = user.makePreimage();
      lightningClient.addInvoice({
        value: amount,
        r_preimage: Buffer.from(preimage, 'hex').toString('base64')
      }, async (err, invoice) => {
        if (err) return;
        lightningClient.decodePayReq({
          pay_req: invoice.payment_request
        }, async (err, decodedInvoice) => {
          await user.saveInvoiceGenerated(invoice.payment_request, preimage);
          let payerUser = new _managers.User(redis, lightningClient);
          payerUser._userId = 'sato';
          await payerUser.savePaidInvoice(invoice.payment_request);
          await payerUser.savePaymentHashPaid(decodedInvoice.payment_hash);
          await fetch('https://api.bysato.com/wallet_v2/onramp/setInvoice.php', {
            method: 'POST',
            body: JSON.stringify({
              id: paymentRequest['_id'],
              invoice: invoice.payment_request
            }),
            headers: {
              'Content-Type': 'application/json'
            }
          });
          await sendPN(paymentRequest.accountId, 'buy_btc_success', 'Purchase completed', `You received +${amount} SATs`);
        });
      });
    }
  }
}, 5000);
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
    partnerId,
    userId,
    user,
    password
  } = req.body;
  console.log(userId, '/create', JSON.stringify(req.body));

  if (partnerId == 'satowallet') {
    let newUser = new _managers.User(redis, lightningClient);
    let createRes = await newUser.create(userId, user, password);
    return res.send({
      secret: `${createRes.user}:${createRes.password}`
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
    user,
    password
  } = req.body;
  console.log('/login', JSON.stringify(req.body));

  if (user && password) {
    let authUser = new _managers.User(redis, lightningClient);

    if ((await authUser.loadByUserAndPassword(user, password)) == true) {
      return res.send({
        access_token: authUser.getAccessToken()
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
      if (lightningIdentityPubKey === decodedInvoice.destination) {
        console.log(user.getUserId(), 'invoice amount', 'internal payment');
        /* internal payment */

        if (await user.getPayerByPaymentHash(decodedInvoice.payment_hash)) {
          lock.releaseLock();
          return res.send({
            error: 'invoice already paid'
          });
        }

        await user.savePaidInvoice(invoice);
        await user.savePaymentHashPaid(decodedInvoice.payment_hash);
        await lock.releaseLock();
        let payeeUserId = await user.getUserIdByPaymentHash(decodedInvoice.payment_hash);
        await sendPN(payeeUserId, 'invoice_paid', 'Your invoice was paid', `You received +${amount} SATs`);
        let preimage = await user.getPreimageByPaymentHash(decodedInvoice.payment_hash);
        return res.send({
          payment_request: invoice,
          payment_preimage: preimage
        });
      } else {
        console.log(user.getUserId(), 'invoice amount', 'external payment');
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
router.post('/domain', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res.send({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    domain
  } = req.body;
  console.log(user.getUserId(), '/domain', JSON.stringify(req.body));
  await user.setDomain(domain);
  return res.send(true);
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
router.get('/.well-known/lnurlp/:domain', async (req, res) => {
  /* params */
  let {
    domain
  } = req.params;

  if (!domain) {
    return res.send({
      status: 'ERROR',
      reason: 'unable to find lightning address'
    });
  }

  const callback = `http://3.136.84.168:5000/.well-known/lnurlp/${domain}`;
  const metadata = [['text/identifier', callback], ['text/plain', `sats for ${domain}`]];
  /* authorization */

  let user = new _managers.User(redis, lightningClient);

  if (!(await user.loadByDomain(domain))) {
    return res.send({
      status: 'ERROR',
      reason: 'unable to find lightning address ' + domain
    });
  }

  if (req.query.amount && req.query.amount > 0) {
    let amount = req.query.amount / 1000;
    let preimage = user.makePreimage();
    lightningClient.addInvoice({
      value: amount,
      r_preimage: Buffer.from(preimage, 'hex').toString('base64')
    }, async (err, invoice) => {
      if (err) return res.send({
        status: 'ERROR',
        reason: 'unable to add invoice'
      });
      await user.saveInvoiceGenerated(invoice.payment_request, preimage);
      return res.status(200).json({
        status: 'OK',
        successAction: {
          tag: 'message',
          message: 'Thank You!'
        },
        routes: [],
        pr: invoice.payment_request,
        disposable: false
      });
    });
  } else {
    return res.status(200).json({
      status: 'OK',
      callback: callback,
      tag: 'payRequest',
      maxSendable: 250000000,
      minSendable: 1,
      metadata: JSON.stringify(metadata),
      commentsAllowed: 0
    });
  }
});
module.exports = router;