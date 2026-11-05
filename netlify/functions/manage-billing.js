// PROD-43: one-click "Manage or cancel" link from billing emails.
// GET ?t=<signed token> → checks the token, creates a fresh Stripe Customer Portal
// session for that customer and redirects to it. No login.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { verifyManageToken } = require('../lib/manage-link');

function page(title, message) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f7fb;color:#1a1f36;margin:0;padding:48px 16px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
<h1 style="font-size:20px;margin:0 0 12px;">${title}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">${message}</p>
<a href="https://matchmentum.com" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:15px;">Go to MatchMentum</a>
</div></body></html>`;
}

function html(statusCode, title, message) {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: page(title, message)
    };
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let customerId = null;
    try {
        customerId = verifyManageToken(event.queryStringParameters?.t);
    } catch (err) {
        console.error('manage-billing: token check failed:', err.message);
    }

    if (!customerId) {
        return html(400, 'This link has expired',
            'For your security, billing links in our emails work for 14 days. Sign in to MatchMentum and open Account Settings to manage or cancel your subscription.');
    }

    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: 'https://matchmentum.com'
        });
        return {
            statusCode: 303,
            headers: { Location: session.url, 'Cache-Control': 'no-store' },
            body: ''
        };
    } catch (err) {
        console.error('manage-billing: portal session failed:', err.message);
        return html(500, 'Something went wrong',
            'We couldn\'t open the billing page. Please sign in to MatchMentum and open Account Settings, or email support@matchmentum.com.');
    }
};
