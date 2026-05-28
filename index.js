const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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
        const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : "Guest Customer";
        
        // Extract Phone Number
        const phone = order.phone || (order.customer && order.customer.phone) || (order.shipping_address && order.shipping_address.phone) || "No phone provided";

        // Extract Shipping Address
        let shippingAddress = "No shipping address provided";
        if (order.shipping_address) {
            const addr = order.shipping_address;
            const line1 = [addr.address1, addr.address2].filter(Boolean).join(", ");
            const line2 = [addr.city, addr.province, addr.zip].filter(Boolean).join(", ");
            shippingAddress = `${line1}\n${line2}\n${addr.country || ''}`.trim();
        }

        // Loop through the line items to format the order list
        let itemsList = "";
        if (order.line_items && order.line_items.length > 0) {
            order.line_items.forEach(item => {
                itemsList += `• ${item.quantity}x ${item.name}\n\n`;
            });
        } else {
            itemsList = "• No items found in order.";
        }

        // 4. Format the WhatsApp Message
        const messageText = `🚨 *New Order #${orderNumber}*\n\n*Customer:* ${customerName}\n*Phone:* ${phone}\n\n*Shipping Address:*\n${shippingAddress}\n\n*Items to Prepare:*\n${itemsList}\n*Total:* ${order.total_price} ${order.currency}`;

        // 5. Send the message via WhatsApp Cloud API
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
});

// A simple health check route
app.get('/', (req, res) => {
    res.send("Shopify to WhatsApp Webhook is running!");
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
