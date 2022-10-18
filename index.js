"use strict";

var _express = _interopRequireDefault(require("express"));

var _helmet = _interopRequireDefault(require("helmet"));

var _bodyParser = _interopRequireDefault(require("body-parser"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/* modules */

/* node js */
process.on('uncaughtException', function (err) {
  console.error(err);
  console.log('Node NOT Exiting...');
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';
/* app */

let app = (0, _express.default)();
app.enable('trust proxy');
app.use(_helmet.default.hsts());
app.use(_helmet.default.hidePoweredBy());
app.use(_bodyParser.default.urlencoded({
  extended: false
}));
app.use(_bodyParser.default.json(null));
app.use(require('./controllers/api'));
/* server */

const bindHost = process.env.HOST || '0.0.0.0';
const bindPort = process.env.PORT || 3000;
let server = app.listen(bindPort, bindHost, function () {
  console.log('BOOTING UP', 'Listening on ' + bindHost + ':' + bindPort);
});
module.exports = server;