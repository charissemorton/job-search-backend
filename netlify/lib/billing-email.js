// PROD-43: billing emails for paid subscribers (renewal reminder, zero-usage
// reminder, receipt, cancellation scheduled, subscription ended).
// Sends through Resend's HTTPS API (no extra package). Env vars:
//   RESEND_API_KEY  key used only by job-search-backend
//   EMAIL_FROM      e.g. "MatchMentum <billing@matchmentum.com>"
//   EMAIL_REPLY_TO  e.g. support@matchmentum.com

const PLAN_NAMES = { lite: 'Lite', pro: 'Pro' };
const DISPLAY_TZ = 'America/Chicago';

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function planName(tier) {
    return PLAN_NAMES[tier] || 'MatchMentum';
}

function formatAmount(cents, currency = 'usd') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
        .format((cents || 0) / 100);
}

// Accepts a Date, ISO string or Unix seconds
function formatDate(value) {
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: DISPLAY_TZ });
}

// ---------- layout ----------

function button(href, label, primary = true) {
    const style = primary
        ? 'background:#2563eb;color:#ffffff;'
        : 'background:#ffffff;color:#2563eb;border:1px solid #2563eb;';
    return `<a href="${esc(href)}" style="display:inline-block;${style}text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${esc(label)}</a>`;
}

function layout(bodyHtml) {
    return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1f36;font-size:15px;line-height:1.55;">
<tr><td>
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#1a1f36;">MatchMentum</p>
${bodyHtml}
<p style="margin:32px 0 0;font-size:13px;color:#6b7280;">Questions? Reply to this email or write to support@matchmentum.com.</p>
</td></tr></table>
</td></tr></table></body></html>`;
}

function usageRows(usage, limits) {
    const fmt = (used, limit) => (limit === null || limit === undefined) ? `${used}` : `${used} of ${limit}`;
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;font-size:15px;">
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Job analyses</td><td>${esc(fmt(usage.analyses, limits.analyses))}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Resumes</td><td>${esc(fmt(usage.resumes, limits.resumes))}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Cover letters</td><td>${esc(fmt(usage.covers, limits.covers))}</td></tr>
</table>`;
}

// ---------- templates ----------
// Each returns { subject, html, text }

function renewalReminder({ tier, amount, currency, chargeDate, usage, limits, manageUrl }) {
    const plan = planName(tier);
    const price = formatAmount(amount, currency);
    const date = formatDate(chargeDate);
    const subject = `Your MatchMentum ${plan} plan renews on ${date}`;
    const html = layout(`
<p style="margin:0 0 16px;">Your <strong>${esc(plan)}</strong> plan renews on <strong>${esc(date)}</strong>, and you'll be charged <strong>${esc(price)}</strong>.</p>
<p style="margin:0 0 4px;">Here's what you've used this billing period:</p>
${usageRows(usage, limits)}
<p style="margin:0 0 20px;">If you'd like to change plans or cancel, you can do it in one click. Cancel before ${esc(date)} and you won't be charged again.</p>
${button(manageUrl, 'Manage or cancel')}`);
    const text = `Your ${plan} plan renews on ${date}, and you'll be charged ${price}.

Used this billing period:
- Job analyses: ${usage.analyses}${limits.analyses == null ? '' : ` of ${limits.analyses}`}
- Resumes: ${usage.resumes}${limits.resumes == null ? '' : ` of ${limits.resumes}`}
- Cover letters: ${usage.covers}${limits.covers == null ? '' : ` of ${limits.covers}`}

Manage or cancel (one click): ${manageUrl}
Cancel before ${date} and you won't be charged again.

Questions? Reply to this email or write to support@matchmentum.com.`;
    return { subject, html, text };
}

function zeroUsageReminder({ tier, amount, currency, chargeDate, manageUrl }) {
    const plan = planName(tier);
    const price = formatAmount(amount, currency);
    const date = formatDate(chargeDate);
    const subject = `You haven't used MatchMentum this month. Your ${plan} plan renews on ${date}`;
    const html = layout(`
<p style="margin:0 0 16px;">You haven't used MatchMentum this billing period: no job analyses, resumes or cover letters.</p>
<p style="margin:0 0 20px;">Your <strong>${esc(plan)}</strong> plan renews on <strong>${esc(date)}</strong> for <strong>${esc(price)}</strong>. If you don't need it right now, you can cancel in one click and you won't be charged again.</p>
<p style="margin:0 0 12px;">${button(manageUrl, 'Cancel my subscription')}</p>
<p style="margin:0 0 0;font-size:14px;color:#6b7280;">Still job searching? No action needed. Your plan renews automatically and everything stays as it is.</p>`);
    const text = `You haven't used MatchMentum this billing period: no job analyses, resumes or cover letters.

Your ${plan} plan renews on ${date} for ${price}. If you don't need it right now, cancel in one click and you won't be charged again:
${manageUrl}

Still job searching? No action needed. Your plan renews automatically.

Questions? Reply to this email or write to support@matchmentum.com.`;
    return { subject, html, text };
}

function receipt({ tier, amount, currency, paidDate, invoiceUrl, manageUrl }) {
    const plan = planName(tier);
    const price = formatAmount(amount, currency);
    const date = formatDate(paidDate);
    const subject = `Receipt for your MatchMentum ${plan} plan`;
    const html = layout(`
<p style="margin:0 0 16px;">Thanks! We received your payment.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:15px;">
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Plan</td><td>${esc(plan)} (monthly)</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Amount</td><td>${esc(price)}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Date</td><td>${esc(date)}</td></tr>
</table>
${invoiceUrl ? `<p style="margin:0 0 20px;"><a href="${esc(invoiceUrl)}" style="color:#2563eb;">View or download your invoice</a></p>` : ''}
${button(manageUrl, 'Manage or cancel', false)}`);
    const text = `Thanks! We received your payment.

Plan: ${plan} (monthly)
Amount: ${price}
Date: ${date}
${invoiceUrl ? `\nInvoice: ${invoiceUrl}\n` : ''}
Manage or cancel: ${manageUrl}

Questions? Reply to this email or write to support@matchmentum.com.`;
    return { subject, html, text };
}

function cancellationScheduled({ tier, accessEndDate, manageUrl }) {
    const plan = planName(tier);
    const date = formatDate(accessEndDate);
    const subject = `Your MatchMentum ${plan} plan has been canceled`;
    const html = layout(`
<p style="margin:0 0 16px;">Your <strong>${esc(plan)}</strong> plan has been canceled. <strong>You won't be charged again.</strong></p>
<p style="margin:0 0 20px;">You keep full access until <strong>${esc(date)}</strong>. After that, your account becomes read-only: you can still sign in and see your saved documents.</p>
<p style="margin:0 0 12px;font-size:14px;color:#6b7280;">Changed your mind? You can keep your plan any time before ${esc(date)}.</p>
${button(manageUrl, 'Keep my plan', false)}`);
    const text = `Your ${plan} plan has been canceled. You won't be charged again.

You keep full access until ${date}. After that, your account becomes read-only: you can still sign in and see your saved documents.

Changed your mind? Keep your plan any time before ${date}: ${manageUrl}

Questions? Reply to this email or write to support@matchmentum.com.`;
    return { subject, html, text };
}

function subscriptionEnded({ tier, endedDate }) {
    const plan = planName(tier);
    const date = formatDate(endedDate);
    const subject = `Your MatchMentum ${plan} plan has ended`;
    const html = layout(`
<p style="margin:0 0 16px;">Your <strong>${esc(plan)}</strong> plan ended on <strong>${esc(date)}</strong>. <strong>Nothing more will be charged.</strong></p>
<p style="margin:0 0 20px;">Your account is now read-only: you can still sign in and see your saved documents. If you'd like to pick up where you left off, you can choose a plan again from Account Settings.</p>
${button('https://matchmentum.com', 'Go to MatchMentum', false)}`);
    const text = `Your ${plan} plan ended on ${date}. Nothing more will be charged.

Your account is now read-only: you can still sign in and see your saved documents. To pick up where you left off, choose a plan again from Account Settings at https://matchmentum.com.

Questions? Reply to this email or write to support@matchmentum.com.`;
    return { subject, html, text };
}

// ---------- sending ----------

async function sendEmail({ to, subject, html, text, idempotencyKey }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey })
        },
        body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: [to],
            reply_to: process.env.EMAIL_REPLY_TO,
            subject,
            html,
            text
        })
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend ${res.status}: ${detail}`);
    }
    return res.json();
}

/**
 * Send one billing email at most once per Stripe event.
 * Claims a row in email_events first (primary key = "<event id>:<email type>");
 * a duplicate key means it was already sent, so skip. Never throws: email problems
 * are logged and must not block the tier/usage updates.
 */
async function sendBillingEmailOnce(supabase, { eventId, emailType, userId, to, template }) {
    const key = `${eventId}:${emailType}`;
    try {
        if (!to) {
            console.warn(`[email] ${emailType}: no recipient address, skipping (${key})`);
            return false;
        }

        const { error: claimError } = await supabase
            .from('email_events')
            .insert({ id: key, stripe_event_id: eventId, email_type: emailType, user_id: userId || null });

        if (claimError) {
            if (claimError.code === '23505') {
                console.log(`[email] ${emailType} already sent for ${eventId}, skipping`);
                return false;
            }
            // Table problem: still send; Resend's idempotency key covers retries for 24h
            console.error(`[email] could not record ${key}:`, claimError.message);
        }

        await sendEmail({ to, ...template, idempotencyKey: key });
        console.log(`[email] sent ${emailType} for ${eventId}`);
        return true;
    } catch (err) {
        console.error(`[email] ${emailType} failed for ${eventId}:`, err.message);
        await supabase
            .from('email_events')
            .update({ status: 'failed', error: String(err.message).slice(0, 500) })
            .eq('id', key)
            .then(() => {}, () => {});
        return false;
    }
}

module.exports = {
    templates: { renewalReminder, zeroUsageReminder, receipt, cancellationScheduled, subscriptionEnded },
    sendEmail,
    sendBillingEmailOnce,
    planName,
    formatAmount,
    formatDate
};
