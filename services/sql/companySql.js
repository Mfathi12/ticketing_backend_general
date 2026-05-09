const { getSequelizeModels } = require('../../db/postgres');
const { subscriptionFromRow, wrapCompanyForSubscription } = require('./companySubscriptionWrap');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

/**
 * Company with members[] like Mongoose (user = id string) + subscription save via wrapCompanyForSubscription.
 */
const loadCompanyWithMembers = async (companyId) => {
    const m = requireModels();
    const id = String(companyId);
    const c = await m.Company.findByPk(id);
    if (!c) return null;
    const plain = c.get({ plain: true });
    const memberRows = await m.CompanyMember.findAll({ where: { companyId: id } });
    const doc = wrapCompanyForSubscription(plain, m.Company);
    doc.members = memberRows.map((r) => ({
        user: r.userId,
        role: r.role,
        isOwner: r.isOwner
    }));
    return doc;
};

const findCompanyByPaymobOrderId = async (orderId) => {
    const m = requireModels();
    const oid = String(orderId || '').trim();
    if (!oid) return null;
    const c = await m.Company.findOne({ where: { paymobOrderId: oid } });
    if (!c) return null;
    return wrapCompanyForSubscription(c.get({ plain: true }), m.Company);
};

const findWrappedCompanyById = async (companyId, { attributes } = {}) => {
    const m = requireModels();
    const c = await m.Company.findByPk(String(companyId), {
        attributes: attributes || undefined
    });
    if (!c) return null;
    return wrapCompanyForSubscription(c.get({ plain: true }), m.Company);
};

module.exports = {
    loadCompanyWithMembers,
    findCompanyByPaymobOrderId,
    findWrappedCompanyById,
    subscriptionFromRow
};
