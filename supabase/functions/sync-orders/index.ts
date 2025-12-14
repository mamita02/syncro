import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// -----------------------
// 1. CONFIGURATION
// -----------------------

const WC_URL = Deno.env.get("WOO_URL") || "https://moda-sn.com";
const WC_CK = Deno.env.get("WOO_CK") || "";
const WC_CS = Deno.env.get("WOO_CS") || "";

const ODOO_URL = Deno.env.get("ODOO_URL") || "https://mce-senegal.odoo.com";
const ODOO_DB = Deno.env.get("ODOO_DB") || "mce-senegal";
const ODOO_USER = Deno.env.get("ODOO_EMAIL") || "";
const ODOO_PASS = Deno.env.get("ODOO_PASSWORD") || "";

// -----------------------
// 2. HELPER FUNCTIONS
// -----------------------

function log(message: string) {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    console.log(`[${timestamp}] ${message}`);
}

// Basic Auth for WooCommerce
function getWooAuth() {
    return "Basic " + btoa(`${WC_CK}:${WC_CS}`);
}

// -----------------------
// 3. ODOO CLIENT
// -----------------------

class OdooClient {
    baseUrl: string;
    db: string;
    user: string;
    pass: string;
    sessionId: string | null = null;

    constructor(url: string, db: string, user: string, pass: string) {
        this.baseUrl = url;
        this.db = db;
        this.user = user;
        this.pass = pass;
    }

    // Commenter ou supprimer cette fonction d'authentification
    // async authenticate() { ... }

    // Méthode pour créer directement une commande sans authentification Odoo
    async createOrder(order: any) {
        const url = `${this.baseUrl}/web/dataset/call_kw`;
        const payload = {
            jsonrpc: "2.0",
            method: "call",
            params: {
                model: "sale.order",
                method: "create",
                args: [order], // Utilisation des données de la commande WooCommerce
                kwargs: {},
            },
        };

        // Si vous avez besoin d'un jeton pour l'authentification, ajoutez-le ici
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.pass}`, // Si nécessaire
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (data.error) {
            log(`⚠️ Error creating order in Odoo: ${data.error}`);
            return null;
        }
        return data.result;
    }
}

// -----------------------
// 4. LOGIQUE METIER
// -----------------------

async function getOrCreateCustomer(odoo: OdooClient, order: any) {
    const billing = order.billing || {};
    const email = (billing.email || "").trim() || `no-email-${order.id}@example.com`;

    const existing = await odoo.search("res.partner", [["email", "=", email]]);
    if (existing && existing.length > 0) {
        return existing[0].id;
    }

    const firstName = billing.first_name || "";
    const lastName = billing.last_name || "";
    const fullName = `${firstName} ${lastName}`.trim() || `Woo Client #${order.id}`;

    const values = {
        name: fullName,
        email: email,
        phone: billing.phone || "",
        street: billing.address_1 || "",
        city: billing.city || "",
        country_id: 195, // Hardcoded Senegal ID from script
        customer_rank: 1,
    };

    return await odoo.create("res.partner", values);
}

async function getOrCreateProduct(odoo: OdooClient, item: any) {
    const sku = item.sku || item.name;
    const existing = await odoo.search("product.product", [["default_code", "=", sku]]);
    if (existing && existing.length > 0) {
        return existing[0].id;
    }

    const values = {
        name: item.name,
        list_price: parseFloat(item.price || "0"),
        default_code: sku,
        type: "consu",
        sale_ok: true,
    };
    return await odoo.create("product.product", values);
}

async function syncOrder(odoo: OdooClient, order: any) {
    const wcId = order.id;
    const originTag = `WC-${wcId}`;

    const existing = await odoo.search("sale.order", [["origin", "=", originTag]]);
    if (existing && existing.length > 0) {
        log(`⏩ Order ${originTag} already imported.`);
        return;
    }

    log(`🔄 Processing Order ${originTag}...`);
    const partnerId = await getOrCreateCustomer(odoo, order);
    if (!partnerId) {
        log("❌ Failed to create customer, skipping order.");
        return;
    }

    const orderLines = [];
    for (const item of order.line_items) {
        const productId = await getOrCreateProduct(odoo, item);
        if (productId) {
            const lineData = {
                product_id: productId,
                name: item.name,
                product_uom_qty: parseFloat(item.quantity),
                price_unit: parseFloat(item.price),
            };
            orderLines.push([0, 0, lineData]);
        }
    }

    if (orderLines.length === 0) {
        log("⚠️ No valid product lines, skipping order.");
        return;
    }

    const orderValues = {
        partner_id: partnerId,
        origin: originTag,
        client_order_ref: String(wcId),
        state: "draft",
        order_line: orderLines,
    };

    const newOrderId = await odoo.createOrder(orderValues);
    if (newOrderId) {
        log(`✅ SUCCESS: Order ${originTag} created (Odoo ID: ${newOrderId})`);
    } else {
        log(`❌ FINAL FAILURE creating order ${originTag}`);
    }
}

// -----------------------
// 5. MAIN HANDLER
// -----------------------

serve(async (_req) => {
    log("🚀 Starting Sync Job...");

    // Initialize Odoo
    const odoo = new OdooClient(ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS);
    // Aucune authentification nécessaire ici, on passe directement à la création de commande.

    try {
        log("📡 Fetching WooCommerce orders...");
        // Using WP REST API - default defaults include per_page=10, we want 20
        const res = await fetch(`${WC_URL}/wp-json/wc/v3/orders?per_page=20`, {
            headers: {
                "Authorization": getWooAuth(),
            },
        });

        if (!res.ok) {
            const txt = await res.text();
            log(`❌ WooCommerce Error: ${txt}`);
            return new Response(`WooCommerce Error: ${txt}`, { status: 500 });
        }

        const orders = await res.json();
        log(`🔎 Found ${orders.length} orders.`);

        for (const order of orders) {
            try {
                await syncOrder(odoo, order);
            } catch (e) {
                log(`❌ Unexpected crash on order ${order.id}: ${e}`);
            }
        }

        log("🏁 Sync finished.");
        return new Response("Sync Finished Successfully", { status: 200 });

    } catch (e) {
        log(`❌ Error fetching orders: ${e}`);
        return new Response(`Error: ${e}`, { status: 500 });
    }
});
