// Stripe Webhook Handler for MatchMentum
// Handles subscription events and updates Supabase database

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    // Verify webhook signature
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  console.log('Received event:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(stripeEvent.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };

  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

/**
 * Handle successful checkout completion
 */
async function handleCheckoutCompleted(session) {
  console.log('Processing checkout completion...');

  const clerkUserId = session.client_reference_id;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!clerkUserId) {
    console.error('No clerk_user_id in session');
    return;
  }

  // Update user to pro plan
  const { data, error } = await supabase
    .from('users')
    .update({
      plan: 'pro',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId
    })
    .eq('clerk_user_id', clerkUserId);

  if (error) {
    console.error('Error updating user:', error);
    throw error;
  }

  console.log(`✅ User ${clerkUserId} upgraded to Pro plan`);
}

/**
 * Handle subscription updates (plan changes, renewals, etc.)
 */
async function handleSubscriptionUpdated(subscription) {
  console.log('Processing subscription update...');

  const customerId = subscription.customer;
  const status = subscription.status;

  // Update user based on subscription status
  const updates = {};

  if (status === 'active') {
    updates.plan = 'pro';
  } else if (status === 'canceled' || status === 'unpaid') {
    updates.plan = 'trial';
  }

  const { error } = await supabase
    .from('users')
    .update(updates)
    .eq('stripe_customer_id', customerId);

  if (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }

  console.log(`✅ Subscription updated for customer ${customerId}`);
}

/**
 * Handle subscription cancellation
 */
async function handleSubscriptionDeleted(subscription) {
  console.log('Processing subscription cancellation...');

  const customerId = subscription.customer;

  // Downgrade user to trial
  const { error } = await supabase
    .from('users')
    .update({ plan: 'trial' })
    .eq('stripe_customer_id', customerId);

  if (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }

  console.log(`✅ Subscription cancelled for customer ${customerId}`);
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(invoice) {
  console.log('Processing payment failure...');

  const customerId = invoice.customer;

  // Optionally downgrade or flag user
  // For now, just log it
  console.log(`⚠️ Payment failed for customer ${customerId}`);

  // You could send them an email, update a status, etc.
}
