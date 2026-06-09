const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple memory cache to prevent duplicate Shopify webhooks
const processedOrders = new Set();

// Middleware to capture raw body for HMAC verification
app.use(express.raw({ type: 'application/json' }));

app.post('/api/webhook', async (req, res) => {
    try {
        const rawBody = req.body; // express.raw makes this a Buffer
        
        // 1. Verify the Shopify HMAC signature (Security check)
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

        // 2. Parse the order data now that it's verified
        const order = JSON.parse(rawBody.toString('utf8'));
        
        // 3. Extract necessary order details
        const orderNumber = order.order_number || order.name;

        // Prevent Duplicate Sends (Shopify sometimes sends the exact same webhook twice in one second)
        if (processedOrders.has(orderNumber)) {
            console.log(`Order #${orderNumber} already processed. Skipping duplicate.`);
            return res.status(200).send("OK");
        }
        processedOrders.add(orderNumber);
        
        // Keep the memory cache from growing too large
        if (processedOrders.size > 1000) {
            processedOrders.clear();
        }

        const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : "Guest Customer";
        
        // Extract Phone Number
        const phone = order.phone || (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone) || "No phone provided";

        // Extract Shipping Address
        let shippingAddress = "No shipping address provided";
        if (order.shipping_address) {
            const addr = order.shipping_address;
            const line1 = [addr.address1, addr.address2].filter(Boolean).join(", ");
            const line2 = [addr.city, addr.province, addr.zip].filter(Boolean).join(", ");
            shippingAddress = `${line1}, ${line2}, ${addr.country || ''}`.replace(/,\s*,/g, ',').trim();
        }

        // Loop through the line items to format the order list (up to 10 slots)
        const lineItems = order.line_items || [];
        const itemParams = [];
        for (let i = 0; i < 10; i++) {
            if (i < 9) {
                if (i < lineItems.length) {
                    const item = lineItems[i];
                    itemParams.push({ type: "text", text: `• x${item.quantity} ${item.name}` });
                } else {
                    itemParams.push({ type: "text", text: " " });
                }
            } else {
                // The 10th slot: group all remaining items if there are any
                if (i < lineItems.length) {
                    const remainingItems = lineItems.slice(i).map(item => `• x${item.quantity} ${item.name}`).join(", ");
                    const truncated = remainingItems.length > 1000 ? remainingItems.substring(0, 997) + "..." : remainingItems;
                    itemParams.push({ type: "text", text: truncated });
                } else {
                    itemParams.push({ type: "text", text: " " });
                }
            }
        }

        // 4. Send the message via WhatsApp Cloud API using the official Template
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
            type: "template",
            template: {
                name: "new_order_alert",
                language: { code: "en_US" },
                components: [
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: String(orderNumber) },
                            { type: "text", text: String(customerName) },
                            { type: "text", text: String(phone) },
                            { type: "text", text: String(shippingAddress) },
                            ...itemParams,
                            { type: "text", text: `${order.total_price} ${order.currency}` }
                        ]
                    }
                ]
            }
        };

        // Immediately acknowledge the webhook to prevent Shopify from thinking it failed and retrying
        res.status(200).send("OK");

        // 5. Send the message via WhatsApp Cloud API asynchronously
        fetch(whatsappApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(whatsappPayload)
        })
        .then(response => response.json().then(data => ({ ok: response.ok, data })))
        .then(({ ok, data }) => {
            if (!ok) {
                console.error("Error from WhatsApp API:", data);
            } else {
                console.log(`WhatsApp message sent successfully for Order #${orderNumber}`);
            }
        })
        .catch(err => console.error("Error sending message:", err));

    } catch (error) {
        console.error("Error processing webhook:", error);
        // If we haven't responded yet, send a 500
        if (!res.headersSent) {
            return res.status(500).send("Internal Server Error");
        }
    }
});

// A simple health check route
app.get('/', (req, res) => {
    res.send("Shopify to WhatsApp Webhook is running!");
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
