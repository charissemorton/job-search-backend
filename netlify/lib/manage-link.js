// PROD-43: signed one-click "Manage or cancel" links for billing emails.
// A Stripe portal session URL expires within minutes, so emails carry a link to
// our manage-billing function instead. The token holds the Stripe customer ID and
// an expiry, signed with MANAGE_LINK_SECRET (HMAC-SHA256). manage-billing checks
// it and redirects to a fresh portal session: one click, no login.

const crypto = require('crypto');

// Hardcoded like the other Netlify function URLs (intentional)
const MANAGE_BILLING_URL = 'https://curious-rugelach-e5ffb8.netlify.app/.netlify/functions/manage-billing';
const LINK_TTL_DAYS = 14;

function b64url(input) {
    return Buffer.from(input).toString('base64url');
}

function hmac(payload) {
    const secret = process.env.MANAGE_LINK_SECRET;
    if (!secret) throw new Error('MANAGE_LINK_SECRET is not set');
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function signManageToken(customerId, ttlDays = LINK_TTL_DAYS) {
    const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
    const payload = b64url(JSON.stringify({ c: customerId, e: exp }));
    return `${payload}.${hmac(payload)}`;
}

// Returns the customer ID, or null if the token is malformed, tampered with or expired
function verifyManageToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;

    const expected = hmac(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    try {
        const { c, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!c || !e || e < Math.floor(Date.now() / 1000)) return null;
        return c;
    } catch {
        return null;
    }
}

function manageLinkFor(customerId) {
    return `${MANAGE_BILLING_URL}?t=${encodeURIComponent(signManageToken(customerId))}`;
}

module.exports = { signManageToken, verifyManageToken, manageLinkFor };
