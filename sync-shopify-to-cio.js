#!/usr/bin/env node
/**
 * Pulls data from Shopify's Admin API and pushes it into Customer.io
 * Collections, fully replacing each collection's contents every run.
 *
 * This file has no server component — it's meant to be invoked by a
 * scheduler (GitHub Actions cron, a serverless cron function, etc.) and
 * exit when done. See .github/workflows/sync-shopify-collection.yml for
 * a ready-to-use GitHub Actions schedule.
 *
 * It pushes up to two Customer.io Collections:
 *
 *   1. The full product catalog (always runs) — one row per product.
 *   2. Collection → product membership (runs only if CIO_COLLECTIONS_ID is
 *      set) — one row per product per Shopify collection it belongs to,
 *      shaped as { collection_handle, collection_id, product_handle,
 *      product_id }, mirroring Shopify's own "Collections" CSV export
 *      columns (Handle / ID / Product: Handle / Product: ID).
 *
 * Required environment variables:
 *   SHOPIFY_STORE        e.g. "my-shop.myshopify.com"
 *   SHOPIFY_ADMIN_TOKEN  Admin API access token from a custom/private app
 *                        with the read_products scope
 *   CIO_APP_API_KEY      Customer.io App API key (Settings > API Credentials > App API Keys)
 *   CIO_COLLECTION_ID    Numeric ID of the Collection that holds the product list
 *                        (create it once in the Customer.io UI, or via POST /v1/collections)
 *
 * Optional environment variables:
 *   CIO_COLLECTIONS_ID    Numeric ID of a second Collection to hold collection→product
 *                         membership rows. Leave unset to skip this part entirely.
 *   CIO_REGION            "us" (default) or "eu" — must match your CIO workspace region
 *   SHOPIFY_API_VERSION   Shopify Admin API version, default "2025-01"
 */

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Tolerate common copy-paste mistakes: a full URL (with https:// and/or a
// trailing slash) instead of the bare *.myshopify.com domain the API needs.
const SHOPIFY_STORE = required("SHOPIFY_STORE")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const SHOPIFY_ADMIN_TOKEN = required("SHOPIFY_ADMIN_TOKEN");
const CIO_APP_API_KEY = required("CIO_APP_API_KEY");
const CIO_COLLECTION_ID = required("CIO_COLLECTION_ID");
const CIO_COLLECTIONS_ID = (process.env.CIO_COLLECTIONS_ID || "").trim() || null;
const CIO_REGION = process.env.CIO_REGION === "eu" ? "eu" : "us";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

const CIO_BASE_URL =
  CIO_REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";

const SHOPIFY_ADMIN_BASE = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`;

// Wraps fetch() with basic handling for Shopify's rate limiting (HTTP 429):
// waits for the Retry-After it sends, then retries a few times before giving up.
async function fetchWithRetry(url, options, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const waitSeconds = Number(res.headers.get("retry-after")) || 2;
    console.log(`Rate limited by Shopify, waiting ${waitSeconds}s (attempt ${attempt}/${maxAttempts})...`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  throw new Error(`Shopify API error 429: gave up after ${maxAttempts} attempts (rate limited)`);
}

// Shopify paginates the REST Admin API via a `Link` response header
// (cursor-based, not page numbers) — this walks it until there's no "next".
async function fetchAllPages(startUrl, bodyKey) {
  const items = [];
  let url = startUrl;

  while (url) {
    const res = await fetchWithRetry(url, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
    });
    if (!res.ok) {
      throw new Error(`Shopify API error ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    items.push(...body[bodyKey]);
    url = parseNextLink(res.headers.get("link") || res.headers.get("Link"));
  }

  return items;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"') return urlPart.slice(1, -1); // strip <...>
  }
  return null;
}

async function fetchAllProducts() {
  return fetchAllPages(`${SHOPIFY_ADMIN_BASE}/products.json?limit=250`, "products");
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

// Shopify has two kinds of collections — manually curated ("custom") and
// rule-based ("smart") — listed via separate endpoints, but both expose their
// member products through the same /collections/{id}/products.json endpoint.
async function fetchAllCollections() {
  const [custom, smart] = await Promise.all([
    fetchAllPages(`${SHOPIFY_ADMIN_BASE}/custom_collections.json?limit=250`, "custom_collections"),
    fetchAllPages(`${SHOPIFY_ADMIN_BASE}/smart_collections.json?limit=250`, "smart_collections"),
  ]);
  return [...custom, ...smart];
}

// Builds one row per (collection, product) pair — the same shape as
// Shopify's own "Collections" CSV export: Handle / ID / Product: Handle / Product: ID.
async function fetchCollectionMembershipRows() {
  const collections = await fetchAllCollections();
  const rows = [];

  for (const collection of collections) {
    const products = await fetchAllPages(
      `${SHOPIFY_ADMIN_BASE}/collections/${collection.id}/products.json?limit=250`,
      "products"
    );
    for (const product of products) {
      rows.push({
        collection_handle: collection.handle,
        collection_id: String(collection.id),
        product_handle: product.handle,
        product_id: String(product.id),
      });
    }
  }

  return rows;
}

function checkPayloadSize(rows, label) {
  const approxBytes = Buffer.byteLength(JSON.stringify(rows));
  if (approxBytes > 9 * 1024 * 1024) {
    throw new Error(
      `${label} payload is ~${(approxBytes / 1024 / 1024).toFixed(1)}MB, close to Customer.io's ` +
        `10MB collection limit. Trim fields, or split across multiple collections.`
    );
  }
}

// PUT /v1/collections/{id} with a `data` array fully replaces the collection's
// contents in one call — no separate create/clear step needed.
async function pushToCollection(collectionId, rows) {
  const res = await fetch(`${CIO_BASE_URL}/v1/collections/${collectionId}`, {
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

  const productRows = products.map(toCollectionRow);
  checkPayloadSize(productRows, "Product list");

  console.log(`Pushing ${productRows.length} rows to Customer.io collection ${CIO_COLLECTION_ID}...`);
  await pushToCollection(CIO_COLLECTION_ID, productRows);

  if (CIO_COLLECTIONS_ID) {
    console.log("Fetching collections and their member products...");
    const membershipRows = await fetchCollectionMembershipRows();
    console.log(`Fetched ${membershipRows.length} collection-product membership rows.`);
    checkPayloadSize(membershipRows, "Collection membership");

    console.log(`Pushing ${membershipRows.length} rows to Customer.io collection ${CIO_COLLECTIONS_ID}...`);
    await pushToCollection(CIO_COLLECTIONS_ID, membershipRows);
  } else {
    console.log("CIO_COLLECTIONS_ID not set — skipping collection/product membership sync.");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
