"use strict";

var _config = _interopRequireDefault(require("./config"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/* modules */
const fs = require('fs');

const grpc = require('@grpc/grpc-js');

const protoLoader = require('@grpc/proto-loader');
/* utls */


/* certificate */
let lndCert = fs.readFileSync('tls.cert');
let sslCreds = grpc.credentials.createSsl(lndCert);
/* macaroon */

let macaroon = fs.readFileSync('admin.macaroon').toString('hex');
/* credentials */

let macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, callback) => {
  let metadata = new grpc.Metadata();
  metadata.add('macaroon', macaroon);
  callback(null, metadata);
});
/* lnrpc initialization */

const loaderOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
};
const packageDefinition = protoLoader.loadSync('rpc.proto', loaderOptions);
let lnrpc = grpc.loadPackageDefinition(packageDefinition).lnrpc;
module.exports = new lnrpc.Lightning(_config.default.lnd.url, grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds), {
  'grpc.max_receive_message_length': 1024 * 1024 * 1024
});