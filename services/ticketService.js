/**
 * Ticket service: index-aware reads + batch user lookups.
 *
 * Every helper preserves the existing API contract (see
 * `docs/API_CONTRACT_REGRESSION_CHECKLIST.md`). They return plain objects
 * shaped like the current route responses; routes that opt into them get
 * fewer DB round-trips without changing JSON output.
 */
const { Ticket } = require('../models');
const { fetchUsersByEmailMap, fetchUsersByIdMap } = require('../utils/userBatch');

/**
 * Collect every email that appears on a ticket (reply senders, handler list,
 * cc list, requested_to/from). Used to drive a single batched user fetch
 * instead of N+1 lookups per reply.
 *
 * @param {object} ticket - lean ticket document
 * @returns {string[]} unique lowercased emails
 */
const collectTicketEmails = (ticket) => {
    const emails = [];
    if (!ticket) return emails;
    if (ticket.requested_from_email) emails.push(ticket.requested_from_email);
    if (ticket.requested_to_email) emails.push(ticket.requested_to_email);
    if (Array.isArray(ticket.handler)) emails.push(...ticket.handler);
    if (Array.isArray(ticket.cc)) emails.push(...ticket.cc);
    if (Array.isArray(ticket.replies)) {
        for (const reply of ticket.replies) {
            if (reply && reply.userEmail) emails.push(reply.userEmail);
        }
    }
    return emails;
};

/**
 * Single ticket read scoped to a company. Returns the lean document with
 * virtuals so the response payload matches the existing route output.
 *
 * @param {string|import('mongoose').Types.ObjectId} ticketId
 * @param {string|import('mongoose').Types.ObjectId} companyId
 */
const getTicketById = async (ticketId, companyId) => {
    if (!ticketId || !companyId) return null;
    return Ticket.findOne({ _id: ticketId, company: companyId })
        .lean({ virtuals: true });
};

/**
 * Bulk-resolve user docs referenced by a ticket's replies/handlers.
 * Returns a Map<email, userDoc>. Callers can use this to enrich replies
 * without issuing one query per reply.
 *
 * @param {object} ticket
 * @returns {Promise<Map<string, import('mongoose').Document>>}
 */
const buildUserMapForTicket = async (ticket) => {
    const emails = collectTicketEmails(ticket);
    if (!emails.length) return new Map();
    return fetchUsersByEmailMap(emails);
};

/**
 * For routes that already populate `replies.userId`, this helper exists so
 * future code can resolve user metadata in a single round-trip when working
 * with lean documents (where `populate` is not available).
 *
 * @param {object[]} tickets - lean ticket docs
 * @returns {Promise<Map<string, import('mongoose').Document>>}
 */
const buildUserMapForTickets = async (tickets) => {
    if (!Array.isArray(tickets) || !tickets.length) return new Map();
    const allEmails = [];
    for (const t of tickets) allEmails.push(...collectTicketEmails(t));
    if (!allEmails.length) return new Map();
    return fetchUsersByEmailMap(allEmails);
};

/**
 * Resolve mongoose User docs by id in one round-trip. Wrapper around the
 * existing `userBatch` helper, kept here so ticket-flavored code can stay
 * close to the rest of the service surface.
 *
 * @param {Iterable<string|import('mongoose').Types.ObjectId>} ids
 */
const buildUserMapByIds = async (ids) => fetchUsersByIdMap(ids);

module.exports = {
    collectTicketEmails,
    getTicketById,
    buildUserMapForTicket,
    buildUserMapForTickets,
    buildUserMapByIds
};
