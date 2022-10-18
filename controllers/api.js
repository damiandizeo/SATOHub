"use strict";

var _express = _interopRequireDefault(require("express"));

var _expressRateLimit = _interopRequireDefault(require("express-rate-limit"));

var _ioredis = _interopRequireDefault(require("ioredis"));

var _crypto = _interopRequireDefault(require("crypto"));

var _config = _interopRequireDefault(require("../config"));

var _managers = require("../managers");

var _lightning = _interopRequireDefault(require("../lightning"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/* modules */

/* config */

/* managers */

/* global */
global.forwardFee = 0;
global.internalFee = 0;
/* variables */

let lightningIdentityPubKey = null;
let lightningDescribeGraph = {};
/* initialize express */

let router = _express.default.Router();
/* initialize Redis */


let redis = new _ioredis.default(_config.default.redis);
redis.info((err, info) => {
  if (err || !info) {
    console.error('Redis failed to start', err);
    process.exit(5);
  }
});
/* lightning apis */

_lightning.default.getInfo({}, (err, info) => {
  if (err) {
    console.error('LND failed to start', err);
    process.exit(3);
  }

  if (info) {
    if (!info.synced_to_chain && !_config.default.forceStart) {
      console.error('LND not synced');
    }

    lightningIdentityPubKey = info.lightningIdentityPubKey;
  }
});

let call = _lightning.default.channelAcceptor({});

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

let subscribeInvoicesCall = _lightning.default.subscribeInvoices({});

subscribeInvoicesCall.on('data', async response => {
  if (response.state === 'SETTLED') {
    let paymentHash = response.r_hash.toString('hex');
    await redis.set('ispaid_' + paymentHash, true);
    let userId = await user.getUserIdByPaymentHash(paymentHash);
    /* send PN to user id */

    console.log(userId);
  }
});

function updateDescribeGraph() {
  _lightning.default.describeGraph({
    include_unannounced: true
  }, (err, response) => {
    if (!err) lightningDescribeGraph = response;
  });
}

updateDescribeGraph();
setInterval(updateDescribeGraph, 120000);
/* express routers */

(0, _expressRateLimit.default)({
  windowMs: 30 * 60 * 1000,
  max: 100
});

const loadAuthorizedUser = async authorization => {
  let user = new _managers.User(redis, lightning);

  if (!(await user.loadByAuthorization(authorization))) {
    return null;
  }

  return user;
};

router.post('/create', postLimiter, async (req, res) => {
  /* params */
  const {
    partnerid,
    accounttype,
    userid,
    login,
    password
  } = req.body;

  if (partnerid == 'satowallet') {
    let user = new _managers.User(redis, lightning);
    let {
      loginRes,
      passwordRes
    } = await user.create(userid, login, password);
    return res.send({
      secret: `${login}:${password}`
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

  if (login && password) {
    let user = new _managers.User(redis, lightning);

    if ((await user.loadByLoginAndPassword(login, password)) == true) {
      res.send({
        access_token: u.getAccessToken()
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
  if (!user) return res({
    error: 'unable to authorize user'
  });
  /* params */

  const {
    amount,
    description,
    expiry = 3600 * 24
  } = req.body;
  let preimage = user.makePreimage();
  let invoice = await _lightning.default.addInvoice({
    value: amount,
    description: description,
    expiry: expiry,
    r_preimage: Buffer.from(preimage, 'hex').toString('base64')
  });

  if (invoice && invoice.payment_request) {
    await user.saveUserInvoice(invoice.payment_request);
    await user.savePreimage(preimage, expiry);
    return res.send({
      payment_request: invoice.payment_request
    });
  }

  return res.send({
    error: 'unable to add invoice'
  });
});
router.post('/payinvoice', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    invoice,
    amount
  } = req.body;
  let lock = new _managers.Lock(redis, 'invoice_paying_for_' + user.getUserId());

  if (!(await lock.obtainLock())) {
    return res.send({
      error: 'something went wrong. Please try again later'
    });
  }

  let userBalance = await user.getBalance();
  let decodedInvoice = await _lightning.default.decodePayReq({
    pay_req: invoice
  });

  if (!decodedInvoice) {
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

  if (userBalance >= amount) {
    if (lightningIdentityPubKey === decodedInvoice.destination) {
      /* internal payment */
      if (await user.getPaymentHashPaid(decodeInvoice.payment_hash)) {
        lock.releaseLock();
        return res.send({
          error: 'invoice already paid'
        });
      }

      await user.savePaidInvoice(invoice);
      await user.savePaymentHashPaid(decodeInvoice.payment_hash, true);
      await lock.releaseLock();
      let preimage = await user.getPreimageByPaymentHash(decodeInvoice.payment_hash);
      return res.send({
        payment_request: invoice,
        payment_preimage: preimage
      });
    } else {
      /* external payment */
      var call = _lightning.default.sendPayment();

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
router.post('/sendcoins', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    address,
    amount
  } = req.body;
  let userBalance = await user.getBalance();

  if (userBalance >= amount) {
    let sendCoinsRes = await _lightning.default.sendCoins({
      addr: req.body.address,
      amount: freeAmount
    });

    if (sendCoinsRes && sendCoinsRes.txid) {
      user.saveUTXOSpent(sendCoinsRes.txid);
      return res.send({
        txid: sendCoinsRes.txid
      });
    } else {
      return res.send({
        error: 'unable to send coins'
      });
    }
  } else {
    return res.send({
      error: 'not enough balance'
    });
  }
});
router.get('/address', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res({
    error: 'unable to authorize user'
  });

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
  if (!user) return res({
    error: 'unable to authorize user'
  });
  let userBalance = await user.getBalance();
  return res.send({
    balance: userBalance
  });
});
router.get('/transactions', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res({
    error: 'unable to authorize user'
  });
  /* user invoices */

  let invoices = await (void 0).getUserInvoices();
  /* onchain transactions */

  let onChainTransactions = await (void 0).getOnChainTransactions();
  /* invoices paid */

  let invoicesPaid = await (void 0).getInvoicesPaid();
  res.send([...invoices, ...onChainTransactions, ...invoicesPaid]);
});
router.get('/decodeinvoice', async (req, res) => {
  /* authorization */
  let user = await loadAuthorizedUser(req.headers.authorization);
  if (!user) return res({
    error: 'unable to authorize user'
  });
  /* params */

  let {
    invoice
  } = req.body;
  let decodeInvoice = await _lightning.default.decodePayReq({
    pay_req: invoice
  });
  return res.send(decodeInvoice !== null && decodeInvoice !== void 0 && decodeInvoice.payment_hash ? decodeInvoice : null);
});
module.exports = router;