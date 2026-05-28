const crypto = require('crypto');

// Helper to read the raw body of the request
async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let body = [];
        req.on('data', (chunk) => {
            body.push(chunk);
        });
        req.on('end', () => {
            resolve(Buffer.concat(body));
        });
        req.on('error', (err) => reject(err));
    });
}

// Vercel requires disabling the default body parser to get the raw body stream
module.exports.config = {
    api: {
        bodyParser: false,
    },
};

module.exports = async (req, res) => {
    // 1. Only allow POST requests (Shopify Webhooks are POST)
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // 2. Read the raw request body
        const rawBody = await getRawBody(req);
        
        // 3. Verify the Shopify HMAC signature (Security check)
        const hmacHeader = req.headers['x-shopify-hmac-sha256'];
        const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

        if (!secret) {
            console.error("Missing SHOPIFY_WEBHOOK_SECRET environment variable");
            return res.status(500).send("Server Configuration Error");
        }

        const generatedHash = crypto
            .createHmac('sha256', secret)
            .update(rawBody, 'utf8')
            .digest('base64');

        if (generatedHash !== hmacHeader) {
            console.error("HMAC verification failed");
            return res.status(401).send("Unauthorized Webhook Request");
        }

        // 4. Parse the order data now that it's verified
        const order = JSON.parse(rawBody.toString('utf8'));
        
        // 5. Extract necessary order details
        const orderNumber = order.order_number || order.name;
        const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : "Guest Customer";
        
        // Loop through the line items to format the order list
        let itemsList = "";
        if (order.line_items && order.line_items.length > 0) {
            order.line_items.forEach(item => {
                itemsList += `• ${item.quantity}x ${item.name}\n`;
            });
        } else {
            itemsList = "• No items found in order.";
        }

        // 6. Format the WhatsApp Message
        const messageText = `🚨 *New Order #${orderNumber}*\n\n*Customer:* ${customerName}\n*Items to Prepare:*\n${itemsList}\n*Total:* ${order.total_price} ${order.currency}`;

        // 7. Send the message via WhatsApp Cloud API
        const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
        const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const EMPLOYEE_PHONE_NUMBER = process.env.EMPLOYEE_PHONE_NUMBER;

        if (!WHATSAPP_API_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !EMPLOYEE_PHONE_NUMBER) {
            console.error("Missing WhatsApp configuration variables");
            return res.status(500).send("Server Configuration Error");
        }

        const whatsappApiUrl = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

        const whatsappPayload = {
            messaging_product: "whatsapp",
            to: EMPLOYEE_PHONE_NUMBER,
            type: "text",
            text: { body: messageText }
        };

        const response = await fetch(whatsappApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(whatsappPayload)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Error from WhatsApp API:", data);
            return res.status(500).send("Failed to send WhatsApp message");
        }

        console.log(`WhatsApp message sent successfully for Order #${orderNumber}`);
        return res.status(200).send("OK");

    } catch (error) {
        console.error("Error processing webhook:", error);
        return res.status(500).send("Internal Server Error");
    }
};
