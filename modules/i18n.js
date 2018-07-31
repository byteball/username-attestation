
/*jslint node: true */
'use strict';
const path = require('path');
const conf = require('byteballcore/conf');
const i18nModule = require('i18n');

const languagesAvailable = conf.languagesAvailable;

let arrLanguages = [];
if (conf.isMultiLingual) {
	for (const key in languagesAvailable) {
		if (!languagesAvailable.hasOwnProperty(key)) continue;
		arrLanguages.push(languagesAvailable[key].file);
	}
}

i18nModule.configure({
	locales: arrLanguages,
	directory: path.join(__dirname, '..', 'locales')
});

let i18n = {};
i18nModule.init(i18n);

i18n.setLocale = (langKey) => {
	i18nModule.setLocale(i18n, languagesAvailable[langKey].file);
};

module.exports = i18n;