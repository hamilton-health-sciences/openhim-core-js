import Q from "q";
import logger from "winston";
import atna from "atna-audit";
import SDC from "statsd-client";
import os from "os";
import utils from "../utils";
import auditing from "../auditing";
import config from "../config/config";

config.authentication = config.get("authentication");
const statsdServer = config.get("statsd");
const application = config.get("application");
const himSourceID = config.get("auditing").auditEvents.auditSourceID;

const domain = `${os.hostname()}.${application.name}.appMetrics`;
const sdc = new SDC(statsdServer);

function genAuthAudit(remoteAddress) {
	let audit = atna.nodeAuthentication(remoteAddress, himSourceID, os.hostname(), atna.OUTCOME_MINOR_FAILURE);
	audit = atna.wrapInSyslog(audit);
	return audit;
}

function authoriseClient(channel, ctx) {
	if ((ctx.authenticated != null) && (channel.allow != null)) {
		if (ctx.authenticated.roles != null) {
			for (const role of Array.from(channel.allow)) {
				if (Array.from(ctx.authenticated.roles).includes(role)) {
					return true;
				}
			}
		}
		if (Array.from(channel.allow).includes(ctx.authenticated.clientID)) {
			return true;
		}
	}

	return false;
}

function authoriseIP(channel, ctx) {
	if ((channel.whitelist != null ? channel.whitelist.length : undefined) > 0) {
		return Array.from(channel.whitelist).includes(ctx.ip);
	} else {
		return true; // whitelist auth not required
	}
}

export function authorise(ctx, done) {
	const channel = ctx.matchingChannel;

	if ((channel != null) && authoriseIP(channel, ctx) && ((channel.authType === "public") || authoriseClient(channel, ctx))) {
		// authorisation succeeded
		ctx.authorisedChannel = channel;
		logger.info(`The request, '${ctx.request.path}' is authorised to access ${ctx.authorisedChannel.name}`);
	} else {
		// authorisation failed
		ctx.response.status = 401;
		if (config.authentication.enableBasicAuthentication) {
			ctx.set("WWW-Authenticate", "Basic");
		}
		logger.info(`The request, '${ctx.request.path}', is not authorised to access any channels.`);
		auditing.sendAuditEvent(genAuthAudit(ctx.ip), () => logger.debug("Processed nodeAuthentication audit"));
	}

	return done();
}

export function* koaMiddleware(next) {
	let startTime;
	if (statsdServer.enabled) { startTime = new Date(); }
	const authorise = Q.denodeify(exports.authorise);
	yield authorise(this);
	if (this.authorisedChannel != null) {
		if (statsdServer.enabled) { sdc.timing(`${domain}.authorisationMiddleware`, startTime); }
		return yield next;
	}
}

// export private functions for unit testing
// note: you cant spy on these method because of this :(
if (process.env.NODE_ENV === "test") {
	exports.genAuthAudit = genAuthAudit;
}
