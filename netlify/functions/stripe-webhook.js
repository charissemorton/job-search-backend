const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

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
    free: { analyses: 10, resumes: 0, covers: 0 },
    lite: { analyses: null, resumes: 10, covers: 10 },
    pro: { analyses: null, resumes: null, covers: null }
};

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
                await handleInvoicePaid(stripeEvent.data.object);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(stripeEvent.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(stripeEvent.data.object);
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
        periodStart = new Date(sub.current_period_start * 1000).toISOString();
        periodEnd = new Date(sub.current_period_end * 1000).toISOString();
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
async function handleInvoicePaid(invoice) {
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;

    if (!subscriptionId) {
        console.log('No subscription on invoice, skipping');
        return;
    }

    // Skip the first invoice (handled by checkout.session.completed)
    if (invoice.billing_reason === 'subscription_create') {
        console.log('First invoice (subscription creation), skipping reset');
        return;
    }

    console.log(`Invoice paid: customer=${customerId}, subscription=${subscriptionId}`);

    // Get subscription details for period dates
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const periodStart = new Date(sub.current_period_start * 1000).toISOString();
    const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

    // Reset usage counters
    const { error } = await supabase
        .from('subscriptions')
        .update({
            analyses_used: 0,
            resumes_used: 0,
            covers_used: 0,
            current_period_start: periodStart,
            current_period_end: periodEnd,
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
 * Handle customer.subscription.updated
 * Handles plan upgrades/downgrades
 */
async function handleSubscriptionUpdated(subscription) {
    const subscriptionId = subscription.id;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const status = subscription.status;

    console.log(`Subscription updated: ${subscriptionId}, price=${priceId}, status=${status}`);

    const newTier = PRICE_TO_TIER[priceId] || 'pro';
    const limits = TIER_LIMITS[newTier] || TIER_LIMITS.pro;

    const periodStart = new Date(subscription.current_period_start * 1000).toISOString();
    const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();

    const updateData = {
        tier: newTier,
        status: status,
        analyses_limit: limits.analyses,
        resumes_limit: limits.resumes,
        covers_limit: limits.covers,
        current_period_start: periodStart,
        current_period_end: periodEnd,
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
}

/**
 * Handle customer.subscription.deleted
 * Downgrades user to free tier when subscription is canceled
 */
async function handleSubscriptionDeleted(subscription) {
    const subscriptionId = subscription.id;

    console.log(`Subscription deleted: ${subscriptionId}`);

    const limits = TIER_LIMITS.free;

    const { error } = await supabase
        .from('subscriptions')
        .update({
            tier: 'free',
            status: 'canceled',
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
}
