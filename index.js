/*jslint node: true */
'use strict';
const constants = require('byteballcore/constants');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus');
const validationUtils = require('byteballcore/validation_utils');
const headlessWallet = require('headless-byteball');
const notifications = require('./modules/notifications');
const usernameAttestation = require('./modules/username-attestation');
const i18n = require('./modules/i18n');
const texts = require('./modules/texts');

/**
 * user pairs his device with bot
 */
eventBus.on('paired', (from_address) => {
	respond(from_address, '');
});

/**
 * ready headless wallet
 */
eventBus.once('headless_wallet_ready', handleWalletReady);

process.on('unhandledRejection', (err) => {
	console.error(err);
	throw err;
});


function handleHeadlessReady() {
	if (conf.bRunWitness) {
		require('byteball-witness');
		eventBus.emit('headless_wallet_ready');
	} else {
		headlessWallet.setupChatEventHandlers();
	}

	/**
	 * user sends message to the bot
	 */
	eventBus.on('text', (from_address, text) => {
		respond(from_address, text.trim());
	});

	/**
	 * user pays to the bot
	 */
	eventBus.on('new_my_transactions', handleNewTransactions);

	/**
	 * pay is confirmed
	 */
	eventBus.on('my_transactions_became_stable', handleTransactionsBecameStable);
}

function handleWalletReady() {
	let error = '';

	/**
	 * check if database tables are created
	 */
	let arrTableNames = [
		'users','receiving_addresses','transactions','attestation_units',
		'rejected_payments'
	];
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND NAME IN (?)", [arrTableNames], (rows) => {
		if (rows.length !== arrTableNames.length) {
			console.error(rows);
			error += texts.errorInitSql();
		}

		/**
		 * check if config is filled correct
		 */
		if (conf.bUseSmtp && (!conf.smtpHost || !conf.smtpUser || !conf.smtpPassword)) {
			error += texts.errorConfigSmtp();
		}
		if (!conf.admin_email || !conf.from_email) {
			error += texts.errorConfigEmail();
		}
		if (!conf.salt) {
			error += texts.errorConfigSalt();
		}

		if (error) {
			throw new Error(error);
		}

		headlessWallet.issueOrSelectAddressByIndex(0, 0, (address1) => {
			console.log('== investor attestation address: ' + address1);
			usernameAttestation.usernameAttestorAddress = address1;

      setInterval(usernameAttestation.retryPostingAttestations, 10*1000);
			setInterval(moveFundsToAttestorAddresses, 10*1000);
			
			handleHeadlessReady();
		});
	});
}

function moveFundsToAttestorAddresses() {
	let network = require('byteballcore/network.js');
	if (network.isCatchingUp())
		return;

	console.log('moveFundsToAttestorAddresses');
	db.query(
		`SELECT DISTINCT receiving_address
		FROM receiving_addresses 
		CROSS JOIN outputs ON receiving_address = address 
		JOIN units USING(unit)
		WHERE is_stable=1 AND is_spent=0 AND asset IS NULL
		LIMIT ?`,
		[constants.MAX_AUTHORS_PER_UNIT],
		(rows) => {
			// console.error('moveFundsToAttestorAddresses', rows);
			if (rows.length === 0) {
				return;
			}

			const arrAddresses = rows.map(row => row.receiving_address);
			// console.error(arrAddresses, usernameAttestation.usernameAttestorAddress);
			const headlessWallet = require('headless-byteball');
			headlessWallet.sendMultiPayment({
				asset: null,
				to_address: usernameAttestation.usernameAttestorAddress,
				send_all: true,
				paying_addresses: arrAddresses
			}, (err, unit) => {
				if (err) {
					console.error("failed to move funds: " + err);
					let balances = require('byteballcore/balances');
					balances.readBalance(arrAddresses[0], (balance) => {
						console.error('balance', balance);
						notifications.notifyAdmin('failed to move funds', err + ", balance: " + JSON.stringify(balance));
					});
				} else {
					console.log("moved funds, unit " + unit);
				}
			});
		}
	);
}

function handleNewTransactions(arrUnits) {
	const device = require('byteballcore/device.js');
	db.query(
		`SELECT
			amount, asset, unit,
			receiving_address, device_address, user_address, username, price,
			${db.getUnixTimestamp('last_price_date')} AS price_ts
		FROM outputs
		CROSS JOIN receiving_addresses ON receiving_addresses.receiving_address = outputs.address
		WHERE unit IN(?)
			AND NOT EXISTS (
				SELECT 1
				FROM unit_authors
				CROSS JOIN my_addresses USING(address)
				WHERE unit_authors.unit = outputs.unit
			)`,
		[arrUnits],
		(rows) => {
			rows.forEach((row) => {

				checkPayment(row, (error) => {
					if (error) {
						return db.query(
							`INSERT ${db.getIgnore()} INTO rejected_payments
							(receiving_address, price, received_amount, payment_unit, error)
							VALUES (?,?,?,?,?)`,
							[row.receiving_address, row.price, row.amount, row.unit, error],
							() => {
								device.sendMessageToDevice(row.device_address, 'text', error);
							}
						);
					}

					db.query(
						`INSERT INTO transactions
						(receiving_address, price, received_amount, payment_unit)
						VALUES (?,?,?,?)`,
						[row.receiving_address, row.price, row.amount, row.unit],
						() => {
							device.sendMessageToDevice(row.device_address, 'text',
								i18n.__('receivedYourPayment', {receivedInGBytes: row.amount/1e9})
							);
						}
					);

				}); // checkPayment

			});
		}
	);
}

function checkPayment(row, onDone) {
	if (row.asset !== null) {
		return onDone(i18n.__('wrongAsset'));
	}

	const priceInBytes = getUsernamePriceInBytes(row.username);

	if (row.amount < priceInBytes) {
		let text = i18n.__('receivedLessThanExpected', {receivedInBytes: row.amount, priceInBytes: priceInBytes});
		return onDone(
			text + '\n\n' +
			i18n.__('pleasePay', {payButton: 'attestation payment'}) +
			getByteballPayButton(row.receiving_address, priceInBytes, row.user_address)
		);
	}

	function resetUserAddress() {
		db.query("UPDATE users SET user_address=NULL WHERE device_address=?", [row.device_address]);
	}

	db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], (author_rows) => {
		if (author_rows.length !== 1){
			resetUserAddress();
			return onDone(i18n.__('receivedPaymentFromMultipleAddresses') +"\n"+ i18n.__('switchToSingleAddress'));
		}
		if (author_rows[0].address !== row.user_address){
			resetUserAddress();
			return onDone(i18n.__('receivedPaymentNotFromExpectedAddress', {address:row.user_address}) +"\n"+ i18n.__('switchToSingleAddress'));
		}
		onDone();
	});
}

function handleTransactionsBecameStable(arrUnits) {
	const device = require('byteballcore/device.js');
	db.query(
		`SELECT 
			transaction_id, payment_unit,
			device_address, user_address, 
			username
		FROM transactions
		JOIN receiving_addresses USING(receiving_address)
		WHERE payment_unit IN(?)`,
		[arrUnits],
		(rows) => {
			rows.forEach((row) => {
				const {
					transaction_id,
					device_address,
					user_address, 
					username,
				} = row;

				db.query(
					`UPDATE transactions 
					SET confirmation_date=${db.getNow()}, is_confirmed=1 
					WHERE transaction_id=?`,
					[transaction_id],
					() => {
						device.sendMessageToDevice(device_address, 'text',
							i18n.__('paymentIsConfirmed') + '\n\n' +
							i18n.__('inAttestation', {username})
						);

						db.query(
							`INSERT ${db.getIgnore()} INTO attestation_units 
							(transaction_id) 
							VALUES (?)`,
							[transaction_id],
							() => {

								const	attestationPayload = usernameAttestation.getAttestationPayload(
									user_address,
									{username}
								);

								usernameAttestation.postAndWriteAttestation(
									transaction_id,
									usernameAttestation.usernameAttestorAddress,
									attestationPayload
								);

							}
						);

					}
				);
			});
		}
	);
}

/**
 * scenario for responding to user requests
 * @param {string} from_address
 * @param {string} text
 * @param {string} response
 */
function respond(from_address, text, response = '') {
	const device = require('byteballcore/device.js');
	const mutex = require('byteballcore/mutex.js');

	readUserInfo(from_address, (userInfo) => {
		if (userInfo.lang != 'unknown') {
			i18n.setLocale(userInfo.lang);
		}

		function checkUserAddress(onDone) {
			if (validationUtils.isValidAddress(text)) {
				userInfo.user_address = text;
				response += i18n.__('goingToAttestAddress', {address: userInfo.user_address});
				return db.query(
					'UPDATE users SET user_address=? WHERE device_address=?',
					[userInfo.user_address, from_address],
					() => {
						onDone();
					}
				);
			}
			if (userInfo.user_address) return onDone();
			onDone(i18n.__('insertMyAddress'));
		}

		function checkUsername(onDone) {
			console.error('check username', text, userInfo.username);
			if (`@${userInfo.username}` === text) {
				return onDone();
			}
			if (/^@([a-z\d\-_])+$/i.test(text)) {
				const newUsername = text.substr(1);

				return db.query(
					`SELECT
						username
					FROM users
					WHERE username=?`,
					[newUsername],
					(rows) => {
						if (rows.length > 0) {
							return onDone(i18n.__('usernameTaken', {username: newUsername}));
						}

						// return db.query(
						// 	`SELECT
							
						// 	FROM `,
						// 	[userInfo.user_address],
						// 	() => {

						// 		return db.query(
						// 			`SELECT
									
						// 			FROM `,
						// 			[from_address],
						// 			() => {
										const priceInBytes = getUsernamePriceInBytes(newUsername);
										if (priceInBytes === 0) {
											return onDone(i18n.__('usernameNotSell', {username: newUsername}));
										}
										response += i18n.__('goingToAttestUsername', {username: newUsername, priceInBytes: priceInBytes/1e9});

										userInfo.username = newUsername;

										return db.query(
											'UPDATE users SET username=? WHERE device_address=? AND user_address=?',
											[userInfo.username, from_address, userInfo.user_address],
											() => {
												onDone();
											}
										);
						// 			}
						// 		);

						// 	}
						// );
					}
				);
			}
			if (/^@.+$/.test(text)) {
				return onDone(i18n.__('wrongUsernameFormat'));
			}
			if (userInfo.username) return onDone();
			onDone(i18n.__('insertMyUsername'));
		}

		checkUserAddress(userAddressResponse => {
			console.error('userAddressResponse', userAddressResponse);
			/*
			* user selected a new language
			*/
			if (text.indexOf('select language ') === 0 && conf.isMultiLingual) {
				let lang = text.replace('select language ', '').trim();
				console.error('select language', lang);
				if (lang && conf.languagesAvailable[lang]) {
					userInfo.lang = lang;
					db.query('UPDATE users SET lang=? WHERE device_address=?', [userInfo.lang, from_address]);

					i18n.setLocale(lang);
					if (userAddressResponse) {
						userAddressResponse = i18n.__('insertMyAddress');
					}

					device.sendMessageToDevice(
						from_address,
						'text',
						'➡ ' + getTxtCommandButton('Go back to language selection', 'select language') + '\n\n' +
							i18n.__('greeting')
					);
				}

			}

			if ((userInfo.lang === 'unknown' || text === 'select language') && conf.isMultiLingual) {
				// If unknown language and multi-language turned on then we propose to select one
				return device.sendMessageToDevice(from_address, 'text', getLanguagesSelection());
			} else if (text === '') {
				// else if paring then we start with greeting text
				device.sendMessageToDevice(
					from_address,
					'text',
					i18n.__('greeting')
				);
			}

			if (userAddressResponse) {
				return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + userAddressResponse);
			}

			checkUsername(usernameResponse => {
				if (usernameResponse) {
					return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + usernameResponse);
				}

				readOrAssignReceivingAddress(from_address, userInfo, (receiving_address) => {
					const priceInBytes = getUsernamePriceInBytes(userInfo.username);
					console.error('priceInBytes', priceInBytes);

					db.query(
						`SELECT
							transaction_id, is_confirmed, received_amount, attestation_date
						FROM transactions
						JOIN receiving_addresses USING(receiving_address)
						LEFT JOIN attestation_units USING(transaction_id)
						WHERE receiving_address=?
						ORDER BY transaction_id DESC
						LIMIT 1`,
						[receiving_address],
						(rows) => {
							/**
							 * if user didn't pay yet
							 */
							if (rows.length === 0) {
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') +
										i18n.__('pleasePay', {payButton: 'attestation payment'}) +
										getByteballPayButton(receiving_address, priceInBytes, userInfo.user_address)
								);
							}

							const row = rows[0];

							/**
							 * if user paid, but transaction did not become stable
							 */
							if (row.is_confirmed === 0) {
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') + i18n.__('receivedYourPayment', {receivedInGBytes: row.received_amount})
								);
							}

							/**
							 * username is in attestation
							 */
							if (!row.attestation_date) {
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') + i18n.__('inAttestation', {username: userInfo.username})
								);
							}

							/**
							 * no more available commands, username is attested
							 */
							return device.sendMessageToDevice(
								from_address,
								'text',
								(response ? response + '\n\n' : '') + i18n.__('alreadyAttested', {username: userInfo.username, attestationDate: row.attestation_date})
							);

						}
					);

				});
			});
		});
	});
}

/**
 * get user's information by device address
 * or create new user, if it's new device address
 * @param {string} device_address
 * @param {function} callback
 */
function readUserInfo(device_address, callback) {
	db.query(
		`SELECT
			username,
			user_address,
			lang
		FROM users 
		WHERE device_address = ?`,
		[device_address],
		(rows) => {
			if (rows.length) {
				callback(rows[0]);
			} else {
				db.query(`INSERT ${db.getIgnore()} INTO users (device_address) VALUES(?)`, [device_address], () => {
					callback({ device_address, user_address: null, lang: 'unknown' });
				});
			}
		}
	);
}

/**
 * read or assign receiving address
 * @param {string} device_address
 * @param {Object} userInfo
 * @return {Promise}
 */
function readOrAssignReceivingAddress(device_address, userInfo, callback) {
	const mutex = require('byteballcore/mutex.js');
	mutex.lock([device_address], (unlock) => {
		db.query(
			`SELECT receiving_address, username, ${db.getUnixTimestamp('last_price_date')} AS price_ts
			FROM receiving_addresses 
			WHERE device_address=? AND user_address=? AND username=?`,
			[device_address, userInfo.user_address, userInfo.username],
			(rows) => {
				if (rows.length > 0) {
					let row = rows[0];
					callback(row.receiving_address);
					return unlock();
				}

				headlessWallet.issueNextMainAddress((receiving_address) => {
					const priceInBytes = getUsernamePriceInBytes(userInfo.username);

					db.query(
						`INSERT INTO receiving_addresses 
						(device_address, user_address, username, receiving_address, price, last_price_date) 
						VALUES(?,?,?,?,?,${db.getNow()})`,
						[device_address, userInfo.user_address, userInfo.username, receiving_address, priceInBytes],
						() => {
							callback(receiving_address);
							unlock();
						}
					);
				});
			}
		);
	});
}

function getLanguagesSelection() {
	let returnedTxt = i18n.__('selectLanguage');
	for (const key in conf.languagesAvailable) {
		returnedTxt += '\n➡ ' + getTxtCommandButton(conf.languagesAvailable[key].name, 'select language ' + key);
	}

	return returnedTxt;
}

function getTxtCommandButton(label, command) {
	const _command = command ? command : label;
	return `[${label}](command:${_command})`;
}

function getByteballPayButton(address, price, user_address) {
	console.error('getByteballPayButton', address, price, user_address);
	return `(byteball:${address}?amount=${price}&single_address=single${user_address})`;
}

/**
 * depend on username length return price in Bytes
 * @param {string} username
 * @return {number}
 */
function getUsernamePriceInBytes(username) {
	const length = username.length;
	let price = 0;
	conf.arrUsernameLengthPriceInBytes.forEach(row => {
		if (length >= row.threshold) {
				price = row.price;
		}
	});
	return price;
}