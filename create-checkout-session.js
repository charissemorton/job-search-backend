// Create Stripe Checkout Session
// Modern, secure approach with server-side session creation

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { email, clerkUserId, priceId } = JSON.parse(event.body);

    if (!email || !clerkUserId || !priceId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }

    // Create Checkout Session on the server
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: email,
      client_reference_id: clerkUserId,
      success_url: `${event.headers.origin || 'https://matchmentum.com'}?payment=success`,
      cancel_url: `${event.headers.origin || 'https://matchmentum.com'}?payment=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      subscription_data: {
        metadata: {
          clerk_user_id: clerkUserId,
        },
      },
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ sessionId: session.id })
    };

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
