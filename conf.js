/*jslint node: true */
"use strict";
exports.port = null;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;

exports.storage = 'sqlite';

// TOR is recommended.  If you don't run TOR, please comment the next two lines
exports.socksHost = '127.0.0.1';
exports.socksPort = 9050;

exports.hub = 'byteball.org/bb';
exports.deviceName = 'Username attestation bot';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.bIgnoreUnpairRequests = true;
exports.bSingleAddress = false;
exports.bStaticChangeAddress = true;
exports.KEYS_FILENAME = 'keys.json';

//email
exports.admin_email = '';
exports.from_email = '';

// witnessing
exports.bRunWitness = false;
exports.THRESHOLD_DISTANCE = 20;
exports.MIN_AVAILABLE_WITNESSINGS = 100;

// Username price
exports.priceTimeout = 3600;
exports.arrPricesInBytesByUsernameLength = [
	{threshold: 5, price: 10e9},
	{threshold: 6, price: 3e9},
	{threshold: 7, price: 1e9},
];

exports.reminderTimeout = 120;

exports.maxUsernamesPerDevice = 5;

exports.cf_address = 'H4HYSYYKPIEPDVMFLDZDDUFDL5EDN3O5';

// Multilingual
exports.isMultiLingual = true;

exports.languagesAvailable = {
	en: {name: "English", file: "en"},
};
