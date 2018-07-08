/*jslint node: true */
'use strict';
const conf = require('byteballcore/conf');
const objectHash = require('byteballcore/object_hash.js');
const db = require('byteballcore/db');
const notifications = require('./notifications');
const i18n = require('./i18n');

function retryPostingAttestations() {
	db.query(
		`SELECT 
			transaction_id, 
			user_address, username
		FROM attestation_units
		JOIN transactions USING(transaction_id)
		JOIN receiving_addresses USING(receiving_address)
		WHERE attestation_unit IS NULL`,
		(rows) => {
			rows.forEach((row) => {

				const	attestationPayload = getAttestationPayload(
					row.user_address,
					{username: row.username}
				);
				postAndWriteAttestation(row.transaction_id, exports.usernameAttestorAddress, attestationPayload);
			});
		}
	);
}

function postAndWriteAttestation(transaction_id, attestor_address, attestation_payload, callback) {
	if (!callback) callback = function () {};
	const mutex = require('byteballcore/mutex.js');
	mutex.lock(['tx-'+transaction_id], (unlock) => {
		db.query(
      `SELECT
        device_address, attestation_date, username
			FROM attestation_units
			JOIN transactions USING(transaction_id)
			JOIN receiving_addresses USING(receiving_address)
			WHERE transaction_id=?`,
			[transaction_id],
			(rows) => {
				let row = rows[0];
				if (row.attestation_date) { // already posted
					callback(null, null);
					return unlock();
				}

				postAttestation(attestor_address, attestation_payload, (err, unit) => {
					if (err) {
						callback(err);
						return unlock();
					}

					db.query(
						`UPDATE attestation_units 
						SET attestation_unit=?, attestation_date=${db.getNow()}
						WHERE transaction_id=?`,
						[unit, transaction_id],
						() => {
							let device = require('byteballcore/device.js');
							
							device.sendMessageToDevice(
                row.device_address,
                'text',
                i18n.__('usernameAttested', {username: row.username, unit})
              );
							callback(null, unit);
							unlock();
						}
					);
				});
			}
		);
	});
}

function postAttestation(attestor_address, payload, onDone) {
	function onError(err) {
		console.error("attestation failed: " + err);
		let balances = require('byteballcore/balances');
		balances.readBalance(attestor_address, (balance) => {
			console.error('balance', balance);
			notifications.notifyAdmin('attestation failed', err + ", balance: " + JSON.stringify(balance));
		});
		onDone(err);
	}

	let network = require('byteballcore/network.js');
	let composer = require('byteballcore/composer.js');
	let headlessWallet = require('headless-byteball');
	let objMessage = {
		app: "attestation",
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(payload),
		payload: payload
	};

	let params = {
		paying_addresses: [attestor_address],
		outputs: [{address: attestor_address, amount: 0}],
		messages: [objMessage],
		signer: headlessWallet.signer,
		callbacks: composer.getSavingCallbacks({
			ifNotEnoughFunds: onError,
			ifError: onError,
			ifOk: (objJoint) => {
				// console.error('ifOk');
				// console.error(objJoint);
				network.broadcastJoint(objJoint);
				onDone(null, objJoint.unit.unit);
			}
		})
	};
	if (conf.bPostTimestamp && attestor_address === exports.usernameAttestorAddress) {
		let timestamp = Date.now();
		let dataFeed = {timestamp};
		let objTimestampMessage = {
			app: "data_feed",
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(dataFeed),
			payload: dataFeed
		};
		params.messages.push(objTimestampMessage);
	}
	composer.composeJoint(params);
}

function getUserId(profile){
	return objectHash.getBase64Hash([profile, conf.salt]);
}

function getAttestationPayload(user_address, data) {
	let profile = {
		username: data.username,
	};
  profile.user_id = getUserId(profile);
  let attestation = {
    address: user_address,
    profile: profile
  };
  return attestation;
}

exports.usernameAttestorAddress = null;
exports.getAttestationPayload = getAttestationPayload;
exports.postAndWriteAttestation = postAndWriteAttestation;
exports.retryPostingAttestations = retryPostingAttestations;