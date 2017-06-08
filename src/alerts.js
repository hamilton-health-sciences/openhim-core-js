
config.alerts = config.get("alerts");

import logger from "winston";
import moment from "moment";
import Q from "q";

import contact from "./contact";
import { config } from "./config";
import { Event } from "./model/events";
import { ContactGroup } from "./model/contactGroups";
import { Alert } from "./model/alerts";
import { User } from "./model/users";
import utils from "./utils";
import _ from "lodash";
import Channels from "./model/channels";

const { Channel } = Channels;


const trxURL = trx => `${config.alerts.consoleURL}/#/transactions/${trx.transactionID}`;

const statusTemplate = (transactions, channel, alert) =>
	({
		plain() {
			return `\
OpenHIM Transactions Alert

The following transaction(s) have completed with status ${alert.status} on the OpenHIM instance running on ${config.alerts.himInstance}:
Channel - ${channel.name}
${(transactions.map(trx => trxURL(trx))).join("\n")}
\
`;
		},
		html() {
			let text = `\
<html>
    <head></head>
    <body>
      <h1>OpenHIM Transactions Alert</h1>
      <div>
        <p>The following transaction(s) have completed with status <b>${alert.status}</b> on the OpenHIM instance running on <b>${config.alerts.himInstance}</b>:</p>
        <table>
          <tr><td>Channel - <b>${channel.name}</b></td></td>\n\
`;
			text += (transactions.map(trx => `        <tr><td><a href='${trxURL(trx)}'>${trxURL(trx)}</a></td></tr>`)).join("\n");
			text += "\n";
			text += `\
        </table>
      </div>
    </body>
</html>\
`;

			return text;
		},
		sms() {
			let text = "Alert - ";
			if (transactions.length > 1) {
				text += `${transactions.length} transactions have`;
			} else if (transactions.length === 1) {
				text += "1 transaction has";
			} else {
				text += "no transactions have";
			}
			text += ` completed with status ${alert.status} on the OpenHIM running on ${config.alerts.himInstance} (${channel.name})`;
			return text;
		},
	})
	;


const maxRetriesTemplate = (transactions, channel) =>
	({
		plain() {
			return `\
OpenHIM Transactions Alert - ${config.alerts.himInstance}

The following transaction(s) have been retried ${channel.autoRetryMaxAttempts} times, but are still failing:

Channel - ${channel.name}
${(transactions.map(trx => trxURL(trx))).join("\n")}

Please note that they will not be retried any further by the OpenHIM automatically.\
`;
		},
		html() {
			let text = `\
<html>
    <head></head>
    <body>
      <h1>OpenHIM Transactions Alert - ${config.alerts.himInstance}</h1>
      <div>
        <p>The following transaction(s) have been retried <b>${channel.autoRetryMaxAttempts}</b> times, but are still failing:</p>
        <table>
          <tr><td>Channel - <b>${channel.name}</b></td></td>\n\
`;
			text += (transactions.map(trx => `        <tr><td><a href='${trxURL(trx)}'>${trxURL(trx)}</a></td></tr>`)).join("\n");
			text += "\n";
			text += `\
        </table>
        <p>Please note that they will not be retried any further by the OpenHIM automatically.</p>
      </div>
    </body>
</html>\
`;

			return text;
		},
		sms() {
			let text = "Alert - ";
			if (transactions.length > 1) {
				text += `${transactions.length} transactions have`;
			} else if (transactions.length === 1) {
				text += "1 transaction has";
			}
			text += ` been retried ${channel.autoRetryMaxAttempts} times but are still failing on the OpenHIM on ${config.alerts.himInstance} (${channel.name})`;
			return text;
		},
	})
	;


const getAllChannels = callback => Channel.find({}, callback);

const findGroup = (groupID, callback) => ContactGroup.findOne({ _id: groupID }, callback);

const findTransactions = (channel, dateFrom, status, callback) =>
	Event
		.find({
			created: {
				$gte: dateFrom,
			},
			channelID: channel._id,
			event: "end",
			status,
			type: "channel",
		}, { transactionID: "transactionID" })
		.hint({ created: 1 })
		.exec(callback);

const countTotalTransactionsForChannel = (channel, dateFrom, callback) =>
	Event.count({
		created: {
			$gte: dateFrom,
		},
		channelID: channel._id,
		type: "channel",
		event: "end",
	}, callback);

function findOneAlert(channel, alert, dateFrom, user, alertStatus, callback) {
	const criteria = {
		timestamp: { $gte: dateFrom },
		channelID: channel._id,
		condition: alert.condition,
		status: alert.condition === "auto-retry-max-attempted" ? "500" : alert.status,
		alertStatus,
	};
	if (user) { criteria.user = user; }
	return Alert
		.findOne(criteria)
		.exec(callback);
}

function findTransactionsMatchingStatus(channel, alert, dateFrom, callback) {
	let statusMatch;
	const pat = /\dxx/.exec(alert.status);
	if (pat) {
		statusMatch = { $gte: alert.status[0] * 100, $lt: (alert.status[0] * 100) + 100 };
	} else {
		statusMatch = alert.status;
	}

	let dateToCheck = dateFrom;
	// check last hour when using failureRate
	if (alert.failureRate != null) { dateToCheck = moment().subtract(1, "hours").toDate(); }

	return findTransactions(channel, dateToCheck, statusMatch, (err, results) => {
		if (!err && (results != null) && (alert.failureRate != null)) {
			// Get count of total transactions and work out failure ratio
			const _countStart = new Date();
			return countTotalTransactionsForChannel(channel, dateToCheck, (err, count) => {
				logger.debug(`.countTotalTransactionsForChannel: ${new Date() - _countStart} ms`);

				if (err) { return callback(err, null); }

				const failureRatio = (results.length / count) * 100.0;
				if (failureRatio >= alert.failureRate) {
					return findOneAlert(channel, alert, dateToCheck, null, "Completed", (err, userAlert) => {
						if (err) { return callback(err, null); }
						// Has an alert already been sent this last hour?
						if (userAlert != null) {
							return callback(err, []);
						}

						return callback(err, utils.uniqArray(results));
					});
				}

				return callback(err, []);
			});
		}
		return callback(err, results);
	});
}

const findTransactionsMaxRetried = (channel, alert, dateFrom, callback) =>
	Event
		.find({
			created: {
				$gte: dateFrom,
			},
			channelID: channel._id,
			event: "end",
			type: "channel",
			status: 500,
			autoRetryAttempt: channel.autoRetryMaxAttempts,
		}, { transactionID: "transactionID" })
		.hint({ created: 1 })
		.exec((err, transactions) => {
			if (err) { return callback(err); }
			return callback(null, _.uniqWith(transactions, (a, b) => a.transactionID.equals(b.transactionID)));
		});

function findTransactionsMatchingCondition(channel, alert, dateFrom, callback) {
	if (!alert.condition || (alert.condition === "status")) {
		return findTransactionsMatchingStatus(channel, alert, dateFrom, callback);
	} else if (alert.condition === "auto-retry-max-attempted") {
		return findTransactionsMaxRetried(channel, alert, dateFrom, callback);
	}
	return callback(new Error(`Unsupported condition '${alert.condition}'`));
}

function calcDateFromForUser(user) {
	if (user.maxAlerts === "1 per hour") {
		return moment().subtract(1, "hours").toDate();
	} else if (user.maxAlerts === "1 per day") {
		return moment().startOf("day").toDate();
	}
	return null;
}

function userAlreadyReceivedAlert(channel, alert, user, callback) {
	if (!user.maxAlerts || (user.maxAlerts === "no max")) {
		// user gets all alerts
		return callback(null, false);
	}
	const dateFrom = calcDateFromForUser(user);
	if (!dateFrom) { return callback(`Unsupported option 'maxAlerts=${user.maxAlerts}'`); }

	return findOneAlert(channel, alert, dateFrom, user.user, "Completed", (err, userAlert) => callback(err != null ? err : null, !!userAlert));
}

// Setup the list of transactions for alerting.
//
// Fetch earlier transactions if a user is setup with maxAlerts.
// If the user has no maxAlerts limit, then the transactions object is returned as is.
function getTransactionsForAlert(channel, alert, user, transactions, callback) {
	if (!user.maxAlerts || (user.maxAlerts === "no max")) {
		return callback(null, transactions);
	}
	const dateFrom = calcDateFromForUser(user);
	if (!dateFrom) { return callback(`Unsupported option 'maxAlerts=${user.maxAlerts}'`); }

	return findTransactionsMatchingCondition(channel, alert, dateFrom, callback);
}

const sendAlert = (channel, alert, user, transactions, contactHandler, done) =>
	User.findOne({ email: user.user }, (err, dbUser) => {
		if (err) { return done(err); }
		if (!dbUser) { return done(`Cannot send alert: Unknown user '${user.user}'`); }

		return userAlreadyReceivedAlert(channel, alert, user, (err, received) => {
			if (err) { return done(err, true); }
			if (received) { return done(null, true); }

			logger.info(`Sending alert for user '${user.user}' using method '${user.method}'`);

			return getTransactionsForAlert(channel, alert, user, transactions, (err, transactionsForAlert) => {
				let template = statusTemplate(transactionsForAlert, channel, alert);
				if (alert.condition === "auto-retry-max-attempted") {
					template = maxRetriesTemplate(transactionsForAlert, channel, alert);
				}

				if (user.method === "email") {
					const plainMsg = template.plain();
					const htmlMsg = template.html();
					return contactHandler("email", user.user, "OpenHIM Alert", plainMsg, htmlMsg, done);
				} else if (user.method === "sms") {
					if (!dbUser.msisdn) { return done(`Cannot send alert: MSISDN not specified for user '${user.user}'`); }

					const smsMsg = template.sms();
					return contactHandler("sms", dbUser.msisdn, "OpenHIM Alert", smsMsg, null, done);
				}
				return done(`Unknown method '${user.method}' specified for user '${user.user}'`);
			});
		});
	})
	;

// Actions to take after sending an alert
function afterSendAlert(err, channel, alert, user, transactions, skipSave, done) {
	if (err) { logger.error(err); }

	if (!skipSave) {
		alert = new Alert({
			user: user.user,
			method: user.method,
			channelID: channel._id,
			condition: alert.condition,
			status: alert.condition === "auto-retry-max-attempted" ? "500" : alert.status,
			alertStatus: err ? "Failed" : "Completed",
		});

		return alert.save((err) => {
			if (err) { logger.error(err); }
			return done();
		});
	}
	return done();
}

function sendAlerts(channel, alert, transactions, contactHandler, done) {
	// Each group check creates one promise that needs to be resolved.
	// For each group, the promise is only resolved when an alert is sent and stored
	// for each user in that group. This resolution is managed by a promise set for that group.
	//
	// For individual users in the alert object (not part of a group),
	// a promise is resolved per user when the alert is both sent and stored.
	const promises = [];

	const _alertStart = new Date();
	if (alert.groups) {
		for (const group of Array.from(alert.groups)) {
			const groupDefer = Q.defer();
			findGroup(group, (err, result) => {
				if (err) {
					logger.error(err);
					return groupDefer.resolve();
				}
				const groupUserPromises = [];

				for (const user of Array.from(result.users)) {
					(function (user) {
						const groupUserDefer = Q.defer();
						sendAlert(channel, alert, user, transactions, contactHandler, (err, skipSave) => afterSendAlert(err, channel, alert, user, transactions, skipSave, () => groupUserDefer.resolve()));
						return groupUserPromises.push(groupUserDefer.promise);
					}(user));
				}

				return (Q.all(groupUserPromises)).then(() => groupDefer.resolve());
			});
			promises.push(groupDefer.promise);
		}
	}

	if (alert.users) {
		for (const user of Array.from(alert.users)) {
			(function (user) {
				const userDefer = Q.defer();
				sendAlert(channel, alert, user, transactions, contactHandler, (err, skipSave) => afterSendAlert(err, channel, alert, user, transactions, skipSave, () => userDefer.resolve()));
				return promises.push(userDefer.promise);
			}(user));
		}
	}

	return (Q.all(promises)).then(() => {
		logger.debug(`.sendAlerts: ${new Date() - _alertStart} ms`);
		return done();
	});
}


function alertingTask(job, contactHandler, done) {
	if (!job.attrs.data) { job.attrs.data = {}; }

	const lastAlertDate = job.attrs.data.lastAlertDate != null ? job.attrs.data.lastAlertDate : new Date();

	const _taskStart = new Date();
	return getAllChannels((err, results) => {
		const promises = [];

		for (const channel of Array.from(results)) {
			if (Channels.isChannelEnabled(channel)) {
				for (const alert of Array.from(channel.alerts)) {
					(function (channel, alert) {
						const deferred = Q.defer();

						const _findStart = new Date();
						findTransactionsMatchingCondition(channel, alert, lastAlertDate, (err, results) => {
							logger.debug(`.findTransactionsMatchingStatus: ${new Date() - _findStart} ms`);

							if (err) {
								logger.error(err);
								return deferred.resolve();
							} else if ((results != null) && (results.length > 0)) {
								return sendAlerts(channel, alert, results, contactHandler, () => deferred.resolve());
							}
							return deferred.resolve();
						});

						return promises.push(deferred.promise);
					}(channel, alert));
				}
			}
		}

		return (Q.all(promises)).then(() => {
			job.attrs.data.lastAlertDate = new Date();
			logger.debug(`Alerting task total time: ${new Date() - _taskStart} ms`);
			return done();
		});
	});
}


export function setupAgenda(agenda) {
	agenda.define("generate transaction alerts", (job, done) => alertingTask(job, contact.contactUser, done));
	return agenda.every(`${config.alerts.pollPeriodMinutes} minutes`, "generate transaction alerts");
}

if (process.env.NODE_ENV === "test") {
	exports.findTransactionsMatchingStatus = findTransactionsMatchingStatus;
	exports.findTransactionsMaxRetried = findTransactionsMaxRetried;
	exports.alertingTask = alertingTask;
}
