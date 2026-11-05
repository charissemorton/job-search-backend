const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { templates, sendBillingEmailOnce } = require('../lib/billing-email');
const { manageLinkFor } = require('../lib/manage-link');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Map Stripe price IDs to tier names
 */
const PRICE_TO_TIER = {
    'price_1T17hABxr12iPruCnKgFTTKZ': 'lite',
    'price_1T17iRBxr12iPruCT7Bjz2gX': 'pro',
    'price_1Sy2xPBxr12iPruCw0Fj4TYk': 'pro'  // Legacy price ID
};

/**
 * Tier limits configuration (mirrors frontend TIER_LIMITS)
 * NULL = unlimited
 */
const TIER_LIMITS = {
    free: { analyses: null, resumes: 3, covers: 0 },
    lite: { analyses: null, resumes: 10, covers: 10 },
    pro: { analyses: null, resumes: null, covers: null }
};

/**
 * PROD-54: read a subscription's billing period from either Stripe field layout.
 * API versions from 2025-03-31 moved current_period_start/end from the
 * subscription to its items. Returns ISO strings, or nulls if neither is present.
 */
function getPeriodDates(sub) {
    const item = sub?.items?.data?.[0];
    const start = sub?.current_period_start ?? item?.current_period_start;
    const end = sub?.current_period_end ?? item?.current_period_end;
    return {
        periodStart: start ? new Date(start * 1000).toISOString() : null,
        periodEnd: end ? new Date(end * 1000).toISOString() : null
    };
}

// PROD-43: tiers that get billing emails (never free or beta)
const PAID_TIERS = ['lite', 'pro'];

// PROD-54/PROD-43: subscription ID from either invoice field layout
function getInvoiceSubscriptionId(invoice) {
    return invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
}

// PROD-43: price ID of the invoice's first line, from either field layout
function getInvoicePriceId(invoice) {
    const line = invoice.lines?.data?.[0];
    return line?.price?.id ?? line?.pricing?.price_details?.price ?? null;
}

// PROD-43: subscriber's email: MatchMentum account first, Stripe customer as fallback
async function getRecipientEmail(userId, customerId) {
    if (userId) {
        const { data, error } = await supabase.auth.admin.getUserById(userId);
        if (!error && data?.user?.email) return data.user.email;
        if (error) console.error(`[email] auth lookup failed for ${userId}:`, error.message);
    }
    if (customerId) {
        try {
            const customer = await stripe.customers.retrieve(customerId);
            if (customer && !customer.deleted && customer.email) return customer.email;
        } catch (err) {
            console.error(`[email] Stripe customer lookup failed for ${customerId}:`, err.message);
        }
    }
    return null;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sig = event.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    console.log(`Received event: ${stripeEvent.type}`);

    try {
        switch (stripeEvent.type) {
            case 'checkout.session.completed':
                await handleCheckoutComplete(stripeEvent.data.object);
                break;

            case 'invoice.paid':
                await handleInvoicePaid(stripeEvent.data.object, stripeEvent);
                break;

            case 'invoice.upcoming':
                await handleInvoiceUpcoming(stripeEvent.data.object, stripeEvent);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(stripeEvent.data.object, stripeEvent);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(stripeEvent.data.object, stripeEvent);
                break;

            default:
                console.log(`Unhandled event type: ${stripeEvent.type}`);
        }
    } catch (err) {
        console.error(`Error handling ${stripeEvent.type}:`, err);
        // Return 200 so Stripe doesn't retry (we logged the error)
        return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

/**
 * Handle checkout.session.completed
 * Creates or updates the subscription record after successful payment
 */
async function handleCheckoutComplete(session) {
    const userId = session.metadata?.userId;
    const tier = session.metadata?.tier;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    if (!userId) {
        console.error('No userId in session metadata');
        return;
    }

    console.log(`Checkout complete: user=${userId}, tier=${tier}, subscription=${subscriptionId}`);

    // Get subscription details from Stripe for period dates
    let periodStart = null;
    let periodEnd = null;

    if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        ({ periodStart, periodEnd } = getPeriodDates(sub));
    }

    const resolvedTier = tier || 'pro'; // Fallback for legacy checkouts
    const limits = TIER_LIMITS[resolvedTier] || TIER_LIMITS.pro;

    // Upsert subscription record
    const { error } = await supabase
        .from('subscriptions')
        .upsert({
            user_id: userId,
            tier: resolvedTier,
            status: 'active',
            trial_expires_at: null,
            stripe_subscription_id: subscriptionId,
            stripe_customer_id: customerId,
            current_period_start: periodStart,
            current_period_end: periodEnd,
            analyses_used: 0,
            analyses_limit: limits.analyses,
            resumes_used: 0,
            resumes_limit: limits.resumes,
            covers_used: 0,
            covers_limit: limits.covers,
            updated_at: new Date().toISOString()
        }, {
            onConflict: 'user_id'
        });

    if (error) {
        console.error('Error upserting subscription:', error);
        throw error;
    }

    console.log(`Subscription created/updated for user ${userId}: ${resolvedTier}`);
}

/**
 * Handle invoice.paid
 * Resets monthly usage counters at the start of each billing cycle
 */
async function handleInvoicePaid(invoice, stripeEvent) {
    const customerId = invoice.customer;
    // PROD-54: newer API versions moved the subscription ID under invoice.parent
    const subscriptionId = getInvoiceSubscriptionId(invoice);

    if (!subscriptionId) {
        console.log('No subscription on invoice, skipping');
        return;
    }

    // PROD-43: receipt for every successful charge, first charge included.
    // Sent before the first-invoice return below; never throws.
    await sendReceipt(invoice, stripeEvent, subscriptionId);

    // Skip the first invoice (handled by checkout.session.completed)
    if (invoice.billing_reason === 'subscription_create') {
        console.log('First invoice (subscription creation), skipping reset');
        return;
    }

    console.log(`Invoice paid: customer=${customerId}, subscription=${subscriptionId}`);

    // Get subscription details for period dates
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const { periodStart, periodEnd } = getPeriodDates(sub);

    // Reset usage counters
    const { error } = await supabase
        .from('subscriptions')
        .update({
            analyses_used: 0,
            resumes_used: 0,
            covers_used: 0,
            // PROD-54: never overwrite stored dates with nulls
            ...(periodStart && { current_period_start: periodStart }),
            ...(periodEnd && { current_period_end: periodEnd }),
            updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscriptionId);

    if (error) {
        console.error('Error resetting usage:', error);
        throw error;
    }

    console.log(`Usage counters reset for subscription ${subscriptionId}`);
}

/**
 * PROD-43: receipt after a successful charge.
 * On the first charge the subscriptions row may not exist yet (checkout.session.completed
 * can arrive later), so the plan comes from the invoice's price and the address from the
 * invoice, with the row and Stripe customer as fallbacks.
 */
async function sendReceipt(invoice, stripeEvent, subscriptionId) {
    try {
        if (!(invoice.amount_paid > 0)) {
            console.log('[email] receipt: nothing charged, skipping');
            return;
        }

        const { data: row } = await supabase
            .from('subscriptions')
            .select('user_id, tier')
            .eq('stripe_subscription_id', subscriptionId)
            .maybeSingle();

        const tier = PRICE_TO_TIER[getInvoicePriceId(invoice)] || row?.tier;
        if (!PAID_TIERS.includes(tier)) {
            console.log(`[email] receipt: tier ${tier} is not a paid tier, skipping`);
            return;
        }

        const to = invoice.customer_email || await getRecipientEmail(row?.user_id, invoice.customer);
        await sendBillingEmailOnce(supabase, {
            eventId: stripeEvent.id,
            emailType: 'receipt',
            userId: row?.user_id,
            to,
            template: templates.receipt({
                tier,
                amount: invoice.amount_paid,
                currency: invoice.currency,
                paidDate: invoice.status_transitions?.paid_at || invoice.created,
                invoiceUrl: invoice.hosted_invoice_url,
                manageUrl: manageLinkFor(invoice.customer)
            })
        });
    } catch (err) {
        console.error('[email] receipt failed:', err.message);
    }
}

/**
 * PROD-43: handle invoice.upcoming (Stripe sends it 7 days before renewal, per the
 * Billing setting). Sends the renewal reminder, or the cancel-first version when
 * nothing was used this period. Lite and Pro only.
 */
async function handleInvoiceUpcoming(invoice, stripeEvent) {
    const subscriptionId = getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) {
        console.log('[email] upcoming invoice has no subscription, skipping');
        return;
    }

    const { data: row, error } = await supabase
        .from('subscriptions')
        .select('user_id, tier, stripe_customer_id, analyses_used, analyses_limit, resumes_used, resumes_limit, covers_used, covers_limit')
        .eq('stripe_subscription_id', subscriptionId)
        .maybeSingle();

    if (error) {
        console.error('[email] subscription lookup failed:', error.message);
        return;
    }
    if (!row || !PAID_TIERS.includes(row.tier)) {
        console.log(`[email] reminder: no paid subscription row for ${subscriptionId}, skipping`);
        return;
    }
    if (!(invoice.amount_due > 0)) {
        console.log('[email] reminder: nothing due, skipping');
        return;
    }

    // Don't remind people whose plan won't renew
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (sub.status !== 'active' || sub.cancel_at_period_end || sub.cancel_at) {
        console.log(`[email] reminder: subscription ${subscriptionId} will not renew, skipping`);
        return;
    }

    const { periodEnd } = getPeriodDates(sub);
    const chargeDate = invoice.next_payment_attempt || periodEnd;
    const customerId = row.stripe_customer_id || invoice.customer;
    const usage = {
        analyses: row.analyses_used || 0,
        resumes: row.resumes_used || 0,
        covers: row.covers_used || 0
    };
    const limits = { analyses: row.analyses_limit, resumes: row.resumes_limit, covers: row.covers_limit };
    const zeroUsage = usage.analyses === 0 && usage.resumes === 0 && usage.covers === 0;

    const details = {
        tier: row.tier,
        amount: invoice.amount_due,
        currency: invoice.currency,
        chargeDate,
        usage,
        limits,
        manageUrl: manageLinkFor(customerId)
    };

    await sendBillingEmailOnce(supabase, {
        eventId: stripeEvent.id,
        emailType: zeroUsage ? 'renewal_reminder_zero_usage' : 'renewal_reminder',
        userId: row.user_id,
        to: await getRecipientEmail(row.user_id, customerId),
        template: zeroUsage ? templates.zeroUsageReminder(details) : templates.renewalReminder(details)
    });
}

/**
 * Handle customer.subscription.updated
 * Handles plan upgrades/downgrades
 */
async function handleSubscriptionUpdated(subscription, stripeEvent) {
    const subscriptionId = subscription.id;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const status = subscription.status;

    console.log(`Subscription updated: ${subscriptionId}, price=${priceId}, status=${status}`);

    const newTier = PRICE_TO_TIER[priceId] || 'pro';
    const limits = TIER_LIMITS[newTier] || TIER_LIMITS.pro;

    // PROD-54: read period dates from either field layout (the event payload follows
    // the webhook endpoint's API version, not the library's)
    const { periodStart, periodEnd } = getPeriodDates(subscription);

    const updateData = {
        tier: newTier,
        status: status,
        trial_expires_at: null,
        analyses_limit: limits.analyses,
        resumes_limit: limits.resumes,
        covers_limit: limits.covers,
        // PROD-54: never overwrite stored dates with nulls
        ...(periodStart && { current_period_start: periodStart }),
        ...(periodEnd && { current_period_end: periodEnd }),
        updated_at: new Date().toISOString()
    };

    // On upgrade, reset usage counters so user gets full new allowance
    if (newTier === 'pro') {
        updateData.analyses_used = 0;
        updateData.resumes_used = 0;
        updateData.covers_used = 0;
    }

    const { error } = await supabase
        .from('subscriptions')
        .update(updateData)
        .eq('stripe_subscription_id', subscriptionId);

    if (error) {
        console.error('Error updating subscription:', error);
        throw error;
    }

    console.log(`Subscription ${subscriptionId} updated to ${newTier}`);

    // PROD-43: confirmation when the subscriber cancels (access continues to period end).
    // Fires only on the update where cancellation was just scheduled.
    const prev = stripeEvent?.data?.previous_attributes || {};
    const nowScheduled = subscription.cancel_at_period_end === true || !!subscription.cancel_at;
    const justScheduled = nowScheduled &&
        (prev.cancel_at_period_end === false || ('cancel_at' in prev && !prev.cancel_at));

    if (justScheduled && PAID_TIERS.includes(newTier)) {
        try {
            const { data: row } = await supabase
                .from('subscriptions')
                .select('user_id')
                .eq('stripe_subscription_id', subscriptionId)
                .maybeSingle();

            await sendBillingEmailOnce(supabase, {
                eventId: stripeEvent.id,
                emailType: 'cancellation_scheduled',
                userId: row?.user_id,
                to: await getRecipientEmail(row?.user_id, subscription.customer),
                template: templates.cancellationScheduled({
                    tier: newTier,
                    accessEndDate: subscription.cancel_at || periodEnd,
                    manageUrl: manageLinkFor(subscription.customer)
                })
            });
        } catch (err) {
            console.error('[email] cancellation confirmation failed:', err.message);
        }
    }
}

/**
 * Handle customer.subscription.deleted
 * Downgrades user to free tier when subscription is canceled
 */
async function handleSubscriptionDeleted(subscription, stripeEvent) {
    const subscriptionId = subscription.id;

    console.log(`Subscription deleted: ${subscriptionId}`);

    // PROD-43: read who this was before the update below clears stripe_subscription_id
    const { data: endedRow } = await supabase
        .from('subscriptions')
        .select('user_id, tier, stripe_customer_id')
        .eq('stripe_subscription_id', subscriptionId)
        .maybeSingle();

    const limits = TIER_LIMITS.free;

    const { error } = await supabase
        .from('subscriptions')
        .update({
            tier: 'free',
            status: 'canceled',
            trial_expires_at: new Date().toISOString(), // read-only immediately after cancellation
            analyses_used: 0,
            analyses_limit: limits.analyses,
            resumes_used: 0,
            resumes_limit: limits.resumes,
            covers_used: 0,
            covers_limit: limits.covers,
            stripe_subscription_id: null,
            current_period_start: null,
            current_period_end: null,
            updated_at: new Date().toISOString()
        })
        .eq('stripe_subscription_id', subscriptionId);

    if (error) {
        console.error('Error downgrading subscription:', error);
        throw error;
    }

    console.log(`Subscription ${subscriptionId} canceled, user downgraded to free`);

    // PROD-43: "your plan has ended" email (paid tiers only)
    if (endedRow && PAID_TIERS.includes(endedRow.tier)) {
        try {
            const customerId = endedRow.stripe_customer_id || subscription.customer;
            await sendBillingEmailOnce(supabase, {
                eventId: stripeEvent.id,
                emailType: 'subscription_ended',
                userId: endedRow.user_id,
                to: await getRecipientEmail(endedRow.user_id, customerId),
                template: templates.subscriptionEnded({
                    tier: endedRow.tier,
                    endedDate: subscription.ended_at || Math.floor(Date.now() / 1000)
                })
            });
        } catch (err) {
            console.error('[email] subscription ended email failed:', err.message);
        }
    }
}
