CREATE TABLE IF NOT EXISTS users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	user_address CHAR(32) NULL,
	username VARCHAR(32) NULL,
	lang CHAR(20) NOT NULL DEFAULT 'unknown',
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
-- query separator
CREATE TABLE IF NOT EXISTS receiving_addresses (
	receiving_address CHAR(32) NOT NULL PRIMARY KEY,
	device_address CHAR(33) NOT NULL,
	user_address CHAR(32) NOT NULL,
	username VARCHAR(32) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	price INT NULL,
	last_price_date TIMESTAMP NULL,
	UNIQUE (device_address, user_address, username),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (receiving_address) REFERENCES my_addresses(address)
);
-- query separator
CREATE INDEX IF NOT EXISTS byUserAddress ON receiving_addresses(user_address);
-- query separator
CREATE INDEX IF NOT EXISTS byUsername ON receiving_addresses(username);
-- query separator
CREATE TABLE IF NOT EXISTS transactions (
	transaction_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	receiving_address CHAR(32) NOT NULL,
	price INT NOT NULL,
	received_amount INT NOT NULL,
	payment_unit CHAR(44) NOT NULL UNIQUE,
	payment_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	is_confirmed INT NOT NULL DEFAULT 0,
	confirmation_date TIMESTAMP NULL,
	FOREIGN KEY (receiving_address) REFERENCES receiving_addresses(receiving_address),
	FOREIGN KEY (payment_unit) REFERENCES units(unit) ON DELETE CASCADE
);
-- query separator
CREATE TABLE IF NOT EXISTS attestation_units (
	transaction_id INTEGER NOT NULL,
	attestation_unit CHAR(44) NULL UNIQUE,
	attestation_date TIMESTAMP NULL,
	PRIMARY KEY (transaction_id),
	FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
	FOREIGN KEY (attestation_unit) REFERENCES units(unit)
);
-- query separator
CREATE TABLE IF NOT EXISTS rejected_payments (
	rejected_payment_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	receiving_address CHAR(32) NOT NULL,
	price INT NOT NULL,
	received_amount INT NOT NULL,
	payment_unit CHAR(44) NOT NULL UNIQUE,
	payment_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	error TEXT NOT NULL,
	FOREIGN KEY (receiving_address) REFERENCES receiving_addresses(receiving_address),
	FOREIGN KEY (payment_unit) REFERENCES units(unit) ON DELETE CASCADE
);
