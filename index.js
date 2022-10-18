"use strict";

/* modules */
const express = require('express');

const helmet = require('helmet');

const bodyParser = require('body-parser');
/* node js */


process.on('uncaughtException', function (err) {
  console.error(err);
  console.log('Node NOT Exiting...');
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';
/* controllers */

const api = require('./controllers/api');
/* app */


let app = express();
app.enable('trust proxy');
app.use(helmet.hsts());
app.use(helmet.hidePoweredBy());
app.use(bodyParser.urlencoded({
  extended: false
}));
app.use(bodyParser.json(null));
app.use(api);
app.use('/', (req, res) => res.send('Welcome to SATOHub'));
/* server */

const bindHost = process.env.HOST || '0.0.0.0';
const bindPort = process.env.PORT || 5000;
let server = app.listen(bindPort, bindHost, function () {
  console.log('BOOTING UP', 'Listening on ' + bindHost + ':' + bindPort);
});
module.exports = server;