#!/usr/bin/env node
/**
 * Pulls product data from Shopify's Admin API and pushes it into a
 * Customer.io Collection, fully replacing the collection's contents each run.
 *
 * This file has no server component — it's meant to be invoked by a
 * scheduler (GitHub Actions cron, a serverless cron function, etc.) and
 * exit when done. See .github/workflows/sync-shopify-collection.yml for
 * a ready-to-use GitHub Actions schedule.
 *
 * Required environment variables:
 *   SHOPIFY_STORE        e.g. "my-shop.myshopify.com"
 *   SHOPIFY_ADMIN_TOKEN  Admin API access token from a custom/private app
 *                        with the read_products scope
 *   CIO_APP_API_KEY      Customer.io App API key (Settings > API Credentials > App API Keys)
 *   CIO_COLLECTION_ID    Numeric ID of the target Collection (create it once
 *                        in the Customer.io UI, or via POST /v1/collections)
 *
 * Optional environment variables:
 *   CIO_REGION            "us" (default) or "eu" — must match your CIO workspace region
 *   SHOPIFY_API_VERSION   Shopify Admin API version, default "2025-01"
 */

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const SHOPIFY_STORE = required("SHOPIFY_STORE");
const SHOPIFY_ADMIN_TOKEN = required("SHOPIFY_ADMIN_TOKEN");
const CIO_APP_API_KEY = required("CIO_APP_API_KEY");
const CIO_COLLECTION_ID = required("CIO_COLLECTION_ID");
const CIO_REGION = process.env.CIO_REGION === "eu" ? "eu" : "us";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

const CIO_BASE_URL =
  CIO_REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";

// Shopify paginates the REST Admin API via a `Link` response header
// (cursor-based, not page numbers) — this walks it until there's no "next".
async function fetchAllProducts() {
  const products = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
    });
    if (!res.ok) {
      throw new Error(`Shopify API error ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    products.push(...body.products);
    url = parseNextLink(res.headers.get("link") || res.headers.get("Link"));
  }

  return products;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"') return urlPart.slice(1, -1); // strip <...>
  }
  return null;
}

// Shape each Shopify product into whatever fields your Liquid templates
// actually need. Keep this lean — collections cap at 10MB total / 10KB per row.
function toCollectionRow(product) {
  const firstVariant = product.variants && product.variants[0];
  const storeHandle = SHOPIFY_STORE.replace(".myshopify.com", "");
  return {
    id: String(product.id),
    title: product.title,
    handle: product.handle,
    product_type: product.product_type,
    tags: product.tags,
    image: (product.image && product.image.src) || null,
    price: (firstVariant && firstVariant.price) || null,
    available: firstVariant ? firstVariant.inventory_quantity > 0 : null,
    url: `https://${storeHandle}.com/products/${product.handle}`,
    updated_at: product.updated_at,
  };
}

// PUT /v1/collections/{id} with a `data` array fully replaces the collection's
// contents in one call — no separate create/clear step needed.
async function pushToCollection(rows) {
  const res = await fetch(`${CIO_BASE_URL}/v1/collections/${CIO_COLLECTION_ID}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CIO_APP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: rows }),
  });
  if (!res.ok) {
    throw new Error(`Customer.io API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log(`Fetching products from ${SHOPIFY_STORE}...`);
  const products = await fetchAllProducts();
  console.log(`Fetched ${products.length} products.`);

  const rows = products.map(toCollectionRow);

  const approxBytes = Buffer.byteLength(JSON.stringify(rows));
  if (approxBytes > 9 * 1024 * 1024) {
    throw new Error(
      `Payload is ~${(approxBytes / 1024 / 1024).toFixed(1)}MB, close to Customer.io's ` +
        `10MB collection limit. Trim fields in toCollectionRow(), or split products ` +
        `across multiple collections (e.g. by product_type).`
    );
  }

  console.log(`Pushing ${rows.length} rows to Customer.io collection ${CIO_COLLECTION_ID}...`);
  await pushToCollection(rows);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
