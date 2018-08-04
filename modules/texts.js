/*jslint node: true */
'use strict';
const desktopApp = require('byteballcore/desktop_app.js');

exports.errorInitSql = () => {
	return "please import db.sql file\n";
};

exports.errorConfigEmail = () => {
	return `please specify admin_email and from_email in your ${desktopApp.getAppDataDir()}/conf.json\n`;
};
