const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { email, userId, priceId, tier } = JSON.parse(event.body);

        if (!email || !userId || !priceId) {
            return {
                statusCode: 400,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ error: 'Missing required fields: email, userId, priceId' })
            };
        }

        // Determine the site URL for redirects
        const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://matchmentum.com';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer_email: email,
            line_items: [
                {
                    price: priceId,
                    quantity: 1
                }
            ],
            metadata: {
                userId: userId,
                tier: tier || 'pro'  // Pass tier so webhook knows which plan
            },
            subscription_data: {
                metadata: {
                    userId: userId,
                    tier: tier || 'pro'
                }
            },
            success_url: `${siteUrl}?payment=success`,
            cancel_url: `${siteUrl}?payment=cancelled`,
            allow_promotion_codes: true
        });

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ sessionId: session.id })
        };

    } catch (error) {
        console.error('Error creating checkout session:', error);
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: error.message })
        };
    }
};
