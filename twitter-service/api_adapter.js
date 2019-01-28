'use strict';
// This is a proof of concept. The code below is ugly, inefficient and has no tests.

const backgroundSync = require('./_background_synchronization');
const Endpoint = require('../core/endpoint');
const EventEmitter = require('events');
const fs = require('fs');
const PogRPCClient = require('../PogRPC/client');
const pogrpcEndpoint = require('../PogRPC/host_endpoint');
const tmp = require('tmp-promise');
const Twitter = require('twitter-lite');
const {derCertToPem} = require('../core/_asn1_utils');
const {getAddressFromCert} = require('../core/pki');
const {TweetMessage} = require('./service_messages');

require('dotenv').config();

tmp.setGracefulCleanup();

/**
 * Client-side of the Twitter API adapter endpoint.
 */
class APIAdapterEndpoint {
    constructor(certPath, keyPath) {
        this._certPath = certPath;
        this._keyPath = keyPath;
    }

    async deliverMessage(messageSerialized, targetEndpointCert, relayEndpoint, parcelDeliveryAuthCert = null) {
        const {scheme, address} = relayEndpoint.match(/^(?<scheme>[\w+]+):(?<address>.+)$/).groups;
        if (scheme !== 'rneh' && !scheme.startsWith('rneh+')) {
            console.error(`Host endpoints can only deliver parcels to a relaying gateway's PDN host endpoint, so we can't deliver messages to ${relayEndpoint}.`);
            return;
        }
        if (scheme.startsWith('rneh+') && scheme !== 'rneh+grpc') {
            // The address includes the binding hint, but PogRPC is the only supported binding
            // in this PoC.
            console.error(`This PoC can only deliver parcels via PogRPC, so we can't deliver messages to ${relayEndpoint}.`);
            return;

            // Note: When the binding hint is missing from the address, we should use
            // Application-Layer Protocol Negotiation (ALPN) to determine the binding.
            // This PoC doesn't use ALPN for expediency and it only supports PogRPC.
        }

        const pdnClient = new PogRPCClient(
            address,
            null,
            false, // TLS must be enforced in production
        );

        const targetEndpointCertPem = derCertToPem(targetEndpointCert);
        const targetEndpointAddress = getAddressFromCert(targetEndpointCertPem);
        if (targetEndpointAddress.startsWith('rneo:') && !parcelDeliveryAuthCert) {
            throw new Error('Private endpoints are unreachable without Parcel Delivery Authorization Certificates');
        }

        let currentEndpointCertPath = this._certPath;
        if (parcelDeliveryAuthCert) {
            currentEndpointCertPath = await bufferToTmpFile(parcelDeliveryAuthCert);
        }

        const currentEndpoint = new Endpoint(currentEndpointCertPath, this._keyPath, pdnClient);

        const targetEndpointCertPath = await bufferToTmpFile(targetEndpointCertPem);
        // Note: It's the endpoint's responsibility to retry if the parcel couldn't be delivered.
        await currentEndpoint.deliverMessage(messageSerialized, targetEndpointCertPath);
    }
}

function processTweet(message) {
    const invalidTweetError = TweetMessage.verify(message);
    if (invalidTweetError) {
        // TODO: Reply with an error contained in a parcel
        throw invalidTweetError;
    }

    // NB: In the final implementation, we should actually queue the message and acknowledge its receipt -- instead of doing things synchronously like an RPC!
    // return callback(null, {});

    const tweetMsg = TweetMessage.decode(message);

    const twitterClient = new Twitter({
        subdomain: "api",
        consumer_key: process.env.TWITTER_CONSUMER_KEY,
        consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
        access_token_key: tweetMsg.credentials.accessTokenKey,
        access_token_secret: tweetMsg.credentials.accessTokenSecret,
    });
    return twitterClient
        .post('statuses/update', {status: tweetMsg.status})
        .then(() => console.log('Successfully posted tweet'))
        .catch((error) => {
            // TODO: Send error message to origin endpoint.
            console.log('Could not post tweet', error);
        });
}

function runServer(netloc, serverCert, serverKey, endpointCertPath, endpointKeyPath) {
    const subscriptionNotifier = new EventEmitter();

    const apiAdapter = new APIAdapterEndpoint(endpointCertPath, endpointKeyPath);

    backgroundSync(apiAdapter, subscriptionNotifier);

    pogrpcEndpoint.runHost(netloc, serverCert, serverKey, endpointKeyPath, async (message, originEndpointCert, relayingGatewayAddress) => {
        await processTweet(message);

        const tweetMsg = TweetMessage.decode(message);
        subscriptionNotifier.emit(
            'subscription',
            tweetMsg.credentials,
            originEndpointCert,

            // TODO: Replace with the Parcel Delivery Authorization Certificate issued by the target endpoint
            // for the Twitter API endpoint.
            fs.readFileSync(endpointCertPath),

            relayingGatewayAddress,
        );
    });
}

async function bufferToTmpFile(buffer) {
    const file = await tmp.file();
    fs.writeFileSync(file.fd, buffer);
    return file.path;
}

module.exports = {
    runServer,
};
