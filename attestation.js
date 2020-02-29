/*jslint node: true */
'use strict';
const constants = require('ocore/constants');
const conf = require('ocore/conf');
const db = require('ocore/db');
const eventBus = require('ocore/event_bus');
const validationUtils = require('ocore/validation_utils');
const headlessWallet = require('headless-obyte');
const notifications = require('./modules/notifications');
const usernameAttestation = require('./modules/username-attestation');
const i18n = require('./modules/i18n');
const texts = require('./modules/texts');

const BOUNCE_FEE = 10000;

let accumulationAddress;

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
		require('obyte-witness');
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
		if (!conf.admin_email || !conf.from_email) {
			error += texts.errorConfigEmail();
		}

		if (error) {
			throw new Error(error);
		}

		headlessWallet.issueOrSelectAddressByIndex(0, 0, (address1) => {
			console.log('== username attestation address: ' + address1);
			usernameAttestation.usernameAttestorAddress = address1;

			headlessWallet.issueOrSelectAddressByIndex(0, 1, (address2) => {
				console.log('== accumulation address: ' + address2);
				accumulationAddress = address2;

				setInterval(usernameAttestation.retryPostingAttestations, 10*1000);
				setInterval(moveFundsToAccumulationAddress, 3600*1000);
				setInterval(moveFundsToCFAddress, 7*24*3600*1000);
				setInterval(checkUsernamesReservationTimeout, 60*1000);

				handleHeadlessReady();
			});
		});
	});
}

function moveFundsToAccumulationAddress() {
	let network = require('ocore/network.js');
	if (network.isCatchingUp())
		return;

	console.log('moveFundsToAccumulationAddress');
	db.query(
		`SELECT DISTINCT receiving_address
		FROM receiving_addresses 
		CROSS JOIN outputs ON receiving_address = address 
		JOIN units USING(unit)
		WHERE is_stable=1 AND is_spent=0 AND asset IS NULL
		LIMIT ?`,
		[constants.MAX_AUTHORS_PER_UNIT],
		(rows) => {
			// console.error('moveFundsToAccumulationAddress', rows);
			if (rows.length === 0) {
				return;
			}

			const arrAddresses = rows.map(row => row.receiving_address);
			headlessWallet.sendMultiPayment({
				asset: null,
				to_address: accumulationAddress,
				send_all: true,
				paying_addresses: arrAddresses
			}, (err, unit) => {
				if (err) {
					console.error("failed to move funds: " + err);
					let balances = require('ocore/balances');
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

function moveFundsToCFAddress() {
	let network = require('ocore/network.js');
	if (network.isCatchingUp())
		return;

	console.log('moveFundsToCFAddress');
	headlessWallet.sendMultiPayment({
		asset: null,
		to_address: conf.cf_address,
		send_all: true,
		change_address: accumulationAddress,
		paying_addresses: [accumulationAddress]
	}, (err, unit) => {
		if (err)
			console.error("failed to move funds to CF: " + err);
		else
			console.log("moved funds to CF, unit " + unit);
	});
}

function handleNewTransactions(arrUnits) {
	const device = require('ocore/device.js');
	const mutex = require('ocore/mutex.js');

	db.query(
		`SELECT
			amount, asset, unit,
			receiving_address, device_address, receiving_addresses.user_address, receiving_addresses.username, price, lang,
			${db.getUnixTimestamp('last_price_date')} AS price_ts
		FROM outputs
		CROSS JOIN receiving_addresses ON receiving_addresses.receiving_address = outputs.address
		CROSS JOIN users USING(device_address)
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

				mutex.lock(`username-${row.username}`, (unlock) => {

					checkPayment(row, (error) => {
						if (error) {
							return db.query(
								`INSERT ${db.getIgnore()} INTO rejected_payments
								(receiving_address, price, received_amount, payment_unit, error)
								VALUES (?,?,?,?,?)`,
								[row.receiving_address, row.price, row.amount, row.unit, error],
								() => {
									unlock();
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
								unlock();
								i18n.setLocale(row.lang);
								device.sendMessageToDevice(row.device_address, 'text',
									i18n.__('receivedYourPayment', {receivedInGB: row.amount/1e9, username: row.username})
								);
							}
						);
	
					}); // checkPayment

				});

			});
		}
	);
}

function checkPayment(row, onDone) {
	if (row.asset !== null) {
		i18n.setLocale(row.lang);
		return onDone(i18n.__('wrongAsset'));
	}

	checkPaymentIsLate(row, (text) => {
		if (text) {
			bouncePayment(row);
			return onDone(text);
		}

		checkUsernamesLimitsPerDeviceAndUserAddresses(
			row.device_address, row.user_address,
			(text) => {
				if (text) {
					return onDone(text);
				}
	
				const priceInBytes = getUsernamePriceInBytes(row.username);
	
				if (row.amount < priceInBytes) {
					i18n.setLocale(row.lang);
					let text = i18n.__('receivedLessThanExpected', {receivedInGB: row.amount/1e9, priceInGB: priceInBytes/1e9});
					return onDone(
						text + '\n\n' +
						i18n.__('pleasePay', {btnLabel: 'attestation payment'}) +
						getObytePayButton(row.receiving_address, priceInBytes, row.user_address)
					);
				}
			
				function resetUserAddress() {
					db.query("UPDATE users SET user_address=NULL WHERE device_address=?", [row.device_address]);
				}
			
				db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], (author_rows) => {
					if (author_rows.length !== 1){
						resetUserAddress();
						i18n.setLocale(row.lang);
						return onDone(i18n.__('receivedPaymentFromMultipleAddresses') +" "+ i18n.__('switchToSingleAddress'));
					}
					if (author_rows[0].address !== row.user_address){
						resetUserAddress();
						i18n.setLocale(row.lang);
						return onDone(i18n.__('receivedPaymentNotFromExpectedAddress', {address:row.user_address}) +" "+ i18n.__('switchToSingleAddress'));
					}
					onDone();
				});
			}
		); // checkUsernamesLimitsPerDeviceAndUserAddresses
	
	});

}

function checkPaymentIsLate(row, onDone) {
	const delay = Math.round(Date.now()/1000 - row.price_ts);
	const bLate = (delay > conf.priceTimeout);
	const borderTimeout = Math.round(Date.now()/1000 - conf.priceTimeout);
	
	if (bLate) {
		return db.query(
			`SELECT
				COUNT(receiving_address) AS count
			FROM receiving_addresses
			LEFT JOIN transactions USING(receiving_address)
			WHERE username=?
				AND (
					is_confirmed IS NOT NULL
					OR (
						is_confirmed IS NULL
						AND ${db.getUnixTimestamp('last_price_date')} > '${borderTimeout}'
						AND device_address<>?
						AND user_address<>?
					)
				)
			GROUP BY receiving_address`,
			[row.username, row.device_address, row.user_address],
			(rows) => {
				if (rows.length) {
					if (rows[0].count) {
						i18n.setLocale(row.lang);
						return onDone(
							i18n.__('paymentIsLate') + '\n' +
							i18n.__('usernameTaken', { username: row.username })
						);
					}
				}

				onDone();
			}
		);
	}

	onDone();
}

function bouncePayment(row){
	const device = require('ocore/device.js');
	if (row.amount < BOUNCE_FEE + 1000)
		return console.log("amount "+row.amount+" is too small to bounce");
	headlessWallet.sendMultiPayment({
		asset: null,
		to_address: row.user_address,
		amount: row.amount - BOUNCE_FEE,
		change_address: accumulationAddress,
		paying_addresses: [row.receiving_address],
		spend_unconfirmed: 'all'
	}, (err, unit) => {
		if (err)
			console.error("failed to bounce to "+row.user_address+": " + err);
		else{
			console.log("bounced payment to "+row.user_address+", unit " + unit);
			i18n.setLocale(row.lang);
			device.sendMessageToDevice(row.device_address, 'text', i18n.__('bouncedPayment', {bounce_fee: BOUNCE_FEE}));
		}
	});
}

function handleTransactionsBecameStable(arrUnits) {
	const device = require('ocore/device.js');
	db.query(
		`SELECT 
			transaction_id, payment_unit,
			device_address, receiving_addresses.user_address, 
			receiving_addresses.username, lang
		FROM transactions
		JOIN receiving_addresses USING(receiving_address)
		JOIN users USING(device_address)
		WHERE payment_unit IN(?)`,
		[arrUnits],
		(rows) => {
			rows.forEach((row) => {
				const {
					transaction_id,
					device_address,
					user_address, 
					username,
					lang
				} = row;

				db.query(
					`UPDATE transactions 
					SET confirmation_date=${db.getNow()}, is_confirmed=1 
					WHERE transaction_id=?`,
					[transaction_id],
					() => {
						i18n.setLocale(lang);
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
								
								db.query("UPDATE users SET user_address=NULL, username=NULL WHERE device_address=?", [device_address]);
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
	const device = require('ocore/device.js');
	const mutex = require('ocore/mutex.js');

	readUserInfo(from_address, (userInfo) => {
		if (userInfo.lang != 'unknown') {
			i18n.setLocale(userInfo.lang);
		}

		/*
		* user selected a new language
		*/
		if (text.indexOf('select language ') === 0 && conf.isMultiLingual) {
			let lang = text.replace('select language ', '').trim();
			// console.error('select language', lang);
			if (lang && conf.languagesAvailable[lang]) {
				userInfo.lang = lang;
				db.query('UPDATE users SET lang=? WHERE device_address=?', [userInfo.lang, from_address]);

				i18n.setLocale(lang);

				device.sendMessageToDevice(
					from_address,
					'text',
					'➡ ' + getTxtCommandButton('Go back to language selection', 'select language') + '\n\n' +
						i18n.__('greeting', {priceLines: getPriceLines()})
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
				i18n.__('greeting', {priceLines: getPriceLines()})
			);
		}

		function checkUserAddress(onDone) {
			if (validationUtils.isValidAddress(text)) {
				userInfo.user_address = text;
				text = '';
				response += i18n.__('goingToAttestAddress', {address: userInfo.user_address});
				return db.query(
					'UPDATE users SET user_address=?, username=NULL WHERE device_address=?',
					[userInfo.user_address, from_address],
					() => {
						userInfo.username = null;
						onDone();
					}
				);
			}
			if (userInfo.user_address)
				return onDone();
			onDone(i18n.__('insertMyAddress'));
		}

		function checkUsername(onDone) {
			let potential_username = text.toLowerCase().replace(/^@/, '');
			if (userInfo.username === potential_username) {
				return onDone();
			}
			if (/^[a-z\d\-_]{1,32}$/i.test(text)) {
				const newUsername = potential_username;
				const borderTimeout = Math.round(Date.now()/1000 - conf.priceTimeout);

				return mutex.lock([`username-${newUsername}`], (unlock) => {

					function onDoneLockedCheckUsername(text) {
						unlock();
						return onDone(text);
					}

					checkUsernameWasNotTaken(
						from_address, userInfo.user_address,
						newUsername,
						(text) => {
							if (text) {
								return onDoneLockedCheckUsername(text);
							}

							checkUserUsernamesAreNotInPaymentConfirmation(
								from_address, userInfo.user_address,
								(text) => {
									if (text) {
										return onDoneLockedCheckUsername(text);
									}
	
									checkUsernamesLimitsPerDeviceAndUserAddresses(
										from_address, userInfo.user_address,
										(text) => {
											if (text) {
												return onDoneLockedCheckUsername(text);
											}
			
											const priceInBytes = getUsernamePriceInBytes(newUsername);
											if (priceInBytes === 0) {
												return onDoneLockedCheckUsername(i18n.__('usernameNotOnSale', {username: newUsername}));
											}
											response += i18n.__('goingToAttestUsername', {username: newUsername, priceInGB: priceInBytes/1e9});

											userInfo.username = newUsername;

											return db.query(
												'UPDATE users SET username=? WHERE device_address=? AND user_address=?',
												[newUsername, from_address, userInfo.user_address],
												() => {

													db.query(
														`UPDATE receiving_addresses
														SET last_price_date=${db.getNow()}, is_notified=0
														WHERE device_address=?
															AND user_address=?
															AND username=?`,
														[from_address, userInfo.user_address, newUsername],
														() => {
															onDoneLockedCheckUsername();
														}
													);

												}
											);
										}
									); // checkUsernamesLimitsPerDeviceAndUserAddresses

								}
							); // checkUserUsernamesAreNotInPaymentConfirmation

						}
					); // checkUsernameWasNotTaken

				}); // mutex.lock
			}
			if (userInfo.username)
				return onDone();
			onDone(i18n.__(text ? 'wrongUsernameFormat' : 'insertMyUsername'));
		} // function checkUsername

		checkUserAddress(userAddressResponse => {
			if (userAddressResponse) {
				return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + userAddressResponse);
			}

			checkUsername(usernameResponse => {
				if (usernameResponse) {
					return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + usernameResponse);
				}

				readOrAssignReceivingAddress(from_address, userInfo, (receiving_address) => {
					const priceInBytes = getUsernamePriceInBytes(userInfo.username);
					// console.error('priceInBytes', priceInBytes);

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
										i18n.__('pleasePay', {btnLabel: 'attestation payment'}) +
										getObytePayButton(receiving_address, priceInBytes, userInfo.user_address)
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
									(response ? response + '\n\n' : '') + i18n.__('receivedYourPayment', {receivedInGB: row.received_amount/1e9, username: userInfo.username})
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
								(response ? response + '\n\n' : '') + i18n.__('usernameAlreadyAttested', {username: userInfo.username, attestationDate: row.attestation_date})
							);

						}
					);

				}); // readOrAssignReceivingAddress
			}); // checkUsername
		}); // checkUserAddress
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
	const mutex = require('ocore/mutex.js');
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

/**
 * check username is already available
 * @param {string} device_address
 * @param {string} user_address
 * @param {string} username
 * @return {function}
 */
function checkUsernameWasNotTaken(device_address, user_address, username, onDone) {
	const borderTimeout = Math.round(Date.now()/1000 - conf.priceTimeout);

	db.query(
		`SELECT
			COUNT(receiving_address) AS count
		FROM receiving_addresses
		LEFT JOIN transactions USING(receiving_address)
		WHERE username=?
			AND (
				is_confirmed IS NOT NULL
				OR (
					is_confirmed IS NULL
					AND ${db.getUnixTimestamp('last_price_date')} > '${borderTimeout}'
					AND (
						device_address<>?
						OR user_address<>?
					)
				)
			)
		GROUP BY receiving_address
		`,
		[username, device_address, user_address],
		(rows) => {
			if (rows.length) {
				const row = rows[0];
				if (row.count) {
					return onDone(i18n.__('usernameTaken', { username }));
				}
			}

			onDone();
		}
	);
}

/**
 * check user username are not in payment confirmation
 * @param {string} device_address
 * @param {string} user_address
 * @param {string} username
 * @return {function}
 */
function checkUserUsernamesAreNotInPaymentConfirmation(device_address, user_address, onDone) {
	db.query(
		`SELECT
			username
		FROM transactions
		JOIN receiving_addresses USING(receiving_address)
		WHERE (device_address=? OR user_address=?)
			AND is_confirmed=0`,
		[device_address, user_address],
		(rows) => {
			if (rows.length) {
				return onDone(i18n.__('paymentIsAwaitingConfirmation', {username: rows[0].username}));
			}

			onDone();
		}
	);
}

/**
 * check usernames limits per device and user addresses
 * @param {string} device_address
 * @param {string} user_address
 * @return {function}
 */
function checkUsernamesLimitsPerDeviceAndUserAddresses(device_address, user_address, onDone) {
	db.query(
		`SELECT
			COUNT(DISTINCT receiving_address) AS count
		FROM transactions
		JOIN receiving_addresses USING(receiving_address)
		WHERE device_address=?`,
		[device_address],
		(rows) => {
			if (rows.length) {
				const row = rows[0];
				if (row.count >= conf.maxUsernamesPerDevice) {
					return onDone(i18n.__('usernamesPerDeviceLimit', {limit: conf.maxUsernamesPerDevice}));
				}
			}

			return db.query(
				`SELECT
					COUNT(receiving_address) AS count
				FROM transactions
				JOIN receiving_addresses USING(receiving_address)
				WHERE user_address=?`,
				[user_address],
				(rows) => {
					if (rows.length) {
						const row = rows[0];
						if (row.count >= 1) {
							return onDone(i18n.__('addressAlreadyAttested'));
						}
					}

					onDone();
				}
			);
		}
	);
}

function checkUsernamesReservationTimeout() {
	const device = require('ocore/device.js');
	const borderTimeout = Math.round(Date.now()/1000 - (conf.priceTimeout - conf.reminderTimeout));

	db.query(
		`SELECT
			receiving_address,
			device_address,
			username
		FROM receiving_addresses
		LEFT JOIN transactions USING(receiving_address)
		WHERE is_confirmed IS NULL
			AND is_notified=0
			AND ${db.getUnixTimestamp('last_price_date')} <= '${borderTimeout}'
			AND NOT EXISTS (SELECT 1 FROM receiving_addresses AS other_ra JOIN transactions USING(receiving_address) WHERE other_ra.user_address=receiving_addresses.user_address)`,
		[],
		(rows) => {
			rows.forEach(row => {

				device.sendMessageToDevice(
					row.device_address,
					'text',
					i18n.__('reservationWillExpire', {username: row.username}),
					{
						ifOk: () => {
							db.query(
								`UPDATE receiving_addresses
								SET is_notified=1
								WHERE receiving_address=?`,
								[row.receiving_address],
								(res) => {}
							);
						},
						ifError: () => { },
					}
				);

			});
		}
	);
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

function getObytePayButton(address, price, user_address) {
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
	conf.arrPricesInBytesByUsernameLength.forEach(row => {
		if (length >= row.threshold)
			price = row.price;
	});
	return price;
}

function getPriceLines(){
	return conf.arrPricesInBytesByUsernameLength.map(row => i18n.__('priceLine', {minLength: row.threshold, price: row.price/1e9})).join(",\n")+'.';
}
