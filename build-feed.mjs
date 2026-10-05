#!/usr/bin/env node
/**
 * Vivino product feed generator for Shopify (Sociovino)
 * ------------------------------------------------------------
 * Fetches every ACTIVE wine from the Shopify Admin GraphQL API (no
 * 250-product limit) and writes a Vivino-format XML file to
 * public/vivino.xml.
 *
 * Wine data comes from the theme's "key__value" product tags, the same
 * scheme snippets/parse-tags.liquid reads:
 *   t__red-wine / white-wine / rose-wine / sparkling-wine / sweet-wine / orange-wine
 *                    wine type: decides inclusion + colour
 *   v__2019 / v__nv  vintage
 *   abv__135         ABV in tenths of a percent (13.5%)
 *   bs__75cl / bs__15l / bs__375cl ...  bottle size
 *   p__<handle>      producer: the title of the collection with that handle
 *   c__ / r__ / gv__ country / region / grape varieties
 * Gaps are filled from the older global.product_details metafield
 * ("Vintage:2019|ABV:13.5%|Bottle Size:75cl|Grape Variety:...").
 *
 * No dependencies: needs Node.js 20+ (uses the built-in fetch).
 *
 * Environment variables
 *   SHOPIFY_STORE_DOMAIN   required  your-store.myshopify.com
 *   SHOPIFY_CLIENT_ID      } use these two (Dev Dashboard app, client credentials grant)
 *   SHOPIFY_CLIENT_SECRET  }
 *   SHOPIFY_ACCESS_TOKEN   or this one (an existing Admin API token, shpat_...)
 *   SHOPIFY_API_VERSION    optional  default 2026-07
 *   WINE_TYPE_TAGS         optional  default "red-wine,white-wine,rose-wine,sparkling-wine,sweet-wine,orange-wine"
 *   EXCLUDED_PRODUCT_TYPES optional  default "Wine Case,Wine Club,Gift Card"
 *   NAME_USES_SUBTITLE     optional  default false (true = add the title part after "|" to the wine name)
 *   DEFAULT_INVENTORY      optional  default 24 (used when Shopify doesn't track stock)
 *   OUTPUT_FILE            optional  default public/vivino.xml
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------- config

const env = (name, fallback = '') => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
};
const list = (s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

const CONFIG = {
  shop: env('SHOPIFY_STORE_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  apiVersion: env('SHOPIFY_API_VERSION', '2026-07'),
  accessToken: env('SHOPIFY_ACCESS_TOKEN'),
  clientId: env('SHOPIFY_CLIENT_ID'),
  clientSecret: env('SHOPIFY_CLIENT_SECRET'),
  wineTypeTags: list(env('WINE_TYPE_TAGS', 'red-wine,white-wine,rose-wine,sparkling-wine,sweet-wine,orange-wine')),
  excludedProductTypes: list(env('EXCLUDED_PRODUCT_TYPES', 'Wine Case,Wine Club,Gift Card')),
  nameUsesSubtitle: env('NAME_USES_SUBTITLE', 'false').toLowerCase() === 'true',
  defaultInventory: Number.parseInt(env('DEFAULT_INVENTORY', '24'), 10),
  outputFile: env('OUTPUT_FILE', 'public/vivino.xml'),
};

// Kept small so each request stays under Shopify's 1,000-point query cost limit.
const PRODUCTS_PER_PAGE = 15;
const VARIANTS_PER_PRODUCT = 10;
const COLLECTIONS_PER_PAGE = 250;

// Vivino only imports these bottle sizes (ml).
const BOTTLE_SIZES_ML = {
  '': 750, '75cl': 750, '750ml': 750, '0.75l': 750, '075l': 750,
  '375cl': 375, '37.5cl': 375, '375ml': 375,
  '50cl': 500, '500ml': 500, '0.5l': 500, '05l': 500,
  '1l': 1000, '100cl': 1000, '1000ml': 1000,
  '15l': 1500, '1.5l': 1500, '150cl': 1500, '1500ml': 1500, 'magnum': 1500,
};

// Colour per t__ tag: `color` for the <color> extra, `inName` for the product name (never red).
const COLOURS = {
  'red-wine': { color: 'Red', inName: '' },
  'white-wine': { color: 'White', inName: 'White' },
  'rose-wine': { color: 'Rosé', inName: 'Rosé' },
  'orange-wine': { color: 'Orange', inName: 'Orange' },
};

// ---------------------------------------------------------------- GraphQL

const PRODUCTS_QUERY = /* GraphQL */ `
  query VivinoProducts($cursor: String, $search: String!) {
    products(first: ${PRODUCTS_PER_PAGE}, after: $cursor, query: $search, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        productType
        tags
        onlineStoreUrl
        description(truncateAt: 2000)
        featuredMedia { preview { image { url } } }
        productDetails: metafield(namespace: "global", key: "product_details") { value }
        variants(first: ${VARIANTS_PER_PRODUCT}) {
          pageInfo { hasNextPage }
          nodes {
            legacyResourceId
            title
            sku
            price
            barcode
            availableForSale
            inventoryQuantity
            inventoryItem { tracked }
            bottleQuantity: metafield(namespace: "custom", key: "bottle_quantity") { value }
            quantityIsMinimum: metafield(namespace: "custom", key: "quantity_is_minimum") { value }
          }
        }
      }
    }
  }
`;

const COLLECTIONS_QUERY = /* GraphQL */ `
  query VivinoCollections($cursor: String) {
    collections(first: ${COLLECTIONS_PER_PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle title }
    }
  }
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getAccessToken() {
  if (CONFIG.accessToken) return CONFIG.accessToken;

  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ACCESS_TOKEN).');
  }

  const res = await fetch(`https://${CONFIG.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Could not get an access token (HTTP ${res.status}). Is the app installed on the store? ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error('Shopify returned no access_token.');
  return json.access_token;
}

/** How long to wait before the next request, based on Shopify's leaky-bucket rate limit. */
function throttleWait(json) {
  const cost = json?.extensions?.cost;
  if (!cost?.throttleStatus) return 0;
  const { currentlyAvailable, restoreRate } = cost.throttleStatus;
  const shortfall = cost.requestedQueryCost - currentlyAvailable;
  return shortfall > 0 ? Math.ceil((shortfall / restoreRate) * 1000) + 250 : 0;
}

async function graphql(token, query, variables, attempt = 1) {
  const res = await fetch(`https://${CONFIG.shop}/admin/api/${CONFIG.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Shopify API kept failing (HTTP ${res.status}).`);
    await sleep(2000 * attempt);
    return graphql(token, query, variables, attempt + 1);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const hint = res.status === 401 || res.status === 403 ? ' Check the token and that the app has read_products and read_inventory.' : '';
    throw new Error(`Shopify API error (HTTP ${res.status}).${hint}`);
  }

  if (json.errors?.length) {
    const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 6) {
      await sleep(throttleWait(json) || 2000 * attempt);
      return graphql(token, query, variables, attempt + 1);
    }
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }

  const wait = throttleWait(json);
  if (wait) await sleep(wait);
  return json.data;
}

async function fetchProducts(token) {
  const typeTags = CONFIG.wineTypeTags.map((t) => `tag:"t__${t}"`).join(' OR ');
  const search = `status:active AND (${typeTags})`;

  const products = [];
  let cursor = null;
  do {
    const data = await graphql(token, PRODUCTS_QUERY, { cursor, search });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    console.log(`Fetched ${products.length} products...`);
  } while (cursor);

  return products;
}

/** Map of collection handle -> title, used to turn p__<handle> tags into producer names. */
async function fetchCollectionTitles(token) {
  const titles = new Map();
  let cursor = null;
  do {
    const data = await graphql(token, COLLECTIONS_QUERY, { cursor });
    for (const c of data.collections.nodes) titles.set(c.handle, c.title.trim());
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);
  console.log(`Fetched ${titles.size} collections (for producer names).`);
  return titles;
}

// ---------------------------------------------------------------- tag parsing

const value = (field) => (field?.value ?? '').toString().trim();
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "new-zealand" -> "New Zealand", like parse-tags.liquid (Liquid's capitalize lowercases the rest). */
const prettyTag = (raw) =>
  raw
    .replace(/-/g, ' ')
    .replace(/ and /g, ' & ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const GRAPE_FIXES = { 'Muller Thurgau': 'Müller Thurgau', 'Gruner Veltliner': 'Grüner Veltliner' };

function parseTags(tags) {
  const t = { type: '', vintage: '', abv: '', bottleSize: '', producer: '', country: '', region: '', grapes: [] };

  for (const tagStr of tags) {
    if (!tagStr.includes('__')) continue;
    const [keyRaw, rawValue = ''] = tagStr.split('__');
    const key = keyRaw.trim().toLowerCase();
    const raw = rawValue.trim();
    if (!raw) continue;

    switch (key) {
      case 't': t.type = raw.toLowerCase(); break;
      case 'v': t.vintage = raw.toUpperCase(); break;
      case 'abv': {
        const tenths = Number.parseFloat(raw);
        if (Number.isFinite(tenths)) t.abv = `${tenths / 10}%`;
        break;
      }
      case 'bs': t.bottleSize = raw.toLowerCase().replace(/\s+/g, ''); break;
      case 'p': t.producer = raw; break;
      case 'c': t.country = prettyTag(raw); break;
      case 'r': t.region = prettyTag(raw); break;
      case 'gv': {
        const grape = prettyTag(raw);
        t.grapes.push(GRAPE_FIXES[grape] || grape);
        break;
      }
    }
  }
  return t;
}

/** Fills gaps from the older "Vintage:2019|ABV:13.5%|Bottle Size:75cl" metafield. */
function applyProductDetails(t, details) {
  if (!details) return;
  const text = details.replace(/<[^>]*>/g, ' ');
  for (const row of text.split('|')) {
    const idx = row.indexOf(':');
    if (idx === -1) continue;
    const label = row.slice(0, idx).trim().toLowerCase();
    const val = collapse(row.slice(idx + 1));
    if (!val) continue;

    if (label === 'vintage' && !t.vintage) t.vintage = val.toUpperCase();
    if (label === 'abv' && !t.abv) t.abv = `${val.replace('%', '').replace(',', '.').trim()}%`;
    if (label === 'bottle size' && !t.bottleSize) t.bottleSize = val.toLowerCase().replace(/[\s]/g, '');
    if (label === 'grape variety' && t.grapes.length === 0) t.grapes = val.split(',').map((g) => g.trim()).filter(Boolean);
  }
}

function producerName(handle, collectionTitles) {
  if (!handle) return '';
  return collectionTitles.get(handle) || prettyTag(handle);
}

/** Vivino name format: Producer + Wine name/appellation + Vintage + Colour (not red). */
function buildName({ title, producer, vintage, colourInName }) {
  const [main, subtitle] = title.split('|').map((s) => (s || '').trim());
  let wineName = CONFIG.nameUsesSubtitle && subtitle ? `${main} ${subtitle}` : main;

  // Vivino: no punctuation such as commas, exclamation or quotation marks.
  wineName = wineName.replace(/[,!"“”*]/g, ' ');

  // Vintage and colour are appended at the end, so take them out of the title.
  wineName = wineName.replace(new RegExp(`\\b${escapeRegExp(vintage)}\\b`, 'g'), ' ');
  if (colourInName) {
    const variants = colourInName === 'Rosé' ? ['Rosé', 'Rose'] : [colourInName];
    for (const c of variants) wineName = wineName.replace(new RegExp(`(^|\\s)${c}(?=\\s|$)`, 'gi'), ' ');
  }
  wineName = collapse(wineName);

  const parts = [];
  if (producer && !wineName.toLowerCase().includes(producer.toLowerCase())) parts.push(producer);
  parts.push(wineName, vintage);
  if (colourInName) parts.push(colourInName);
  return { name: collapse(parts.filter(Boolean).join(' ')), wineName };
}

/** Bottles sold at this price: variant metafield, else "Case of 6" / "12 Bottles" in the variant title, else 1. */
function bottleQuantity(variant) {
  const fromMetafield = Number.parseInt(value(variant.bottleQuantity), 10);
  if (fromMetafield > 0) return fromMetafield;

  const title = (variant.title || '').toLowerCase();
  if (/case|bottle|pack/.test(title)) {
    const match = title.match(/\b(\d+)\b/);
    const n = match ? Number.parseInt(match[1], 10) : 0;
    if (n > 1) return n;
  }
  return 1;
}

// ---------------------------------------------------------------- feed building

function buildEntries(products, collectionTitles) {
  const wineTypes = new Set(CONFIG.wineTypeTags);
  const excludedTypes = new Set(CONFIG.excludedProductTypes);
  const entries = [];
  const skipped = { notWine: 0, notOnOnlineStore: 0, unsupportedBottleSize: 0, outOfStock: 0 };
  const warnings = { noVintage: [], noAbv: [], noProducer: [], bottleSizes: [] };

  for (const p of products) {
    const t = parseTags(p.tags || []);
    applyProductDetails(t, value(p.productDetails));

    // Double-check the API filter, and drop mixed cases, wine club and gift cards.
    if (p.status !== 'ACTIVE' || !wineTypes.has(t.type) || excludedTypes.has((p.productType || '').trim().toLowerCase())) {
      skipped.notWine++;
      continue;
    }
    // No storefront URL = not published to the Online Store, so the link would break.
    if (!p.onlineStoreUrl) {
      skipped.notOnOnlineStore++;
      continue;
    }

    const bottleMl = BOTTLE_SIZES_ML[t.bottleSize.replace(/\s+/g, '')];
    if (!bottleMl) {
      skipped.unsupportedBottleSize++;
      warnings.bottleSizes.push(`${p.title} (${t.bottleSize})`);
      continue;
    }

    if (p.variants.pageInfo.hasNextPage) {
      console.warn(`Warning: "${p.title}" has more than ${VARIANTS_PER_PRODUCT} variants; only the first ${VARIANTS_PER_PRODUCT} are included.`);
    }

    if (!t.vintage) warnings.noVintage.push(p.title);
    if (!t.abv) warnings.noAbv.push(p.title);
    if (!t.producer) warnings.noProducer.push(p.title);

    const vintage = !t.vintage || t.vintage === 'N V' ? 'NV' : t.vintage;
    const colour = COLOURS[t.type] || { color: '', inName: '' };
    const producer = producerName(t.producer, collectionTitles);
    const { name, wineName } = buildName({ title: p.title, producer, vintage, colourInName: colour.inName });

    const shared = {
      name,
      // Vivino links may not contain "?" or "=", so every variant links to the product page.
      link: p.onlineStoreUrl,
      bottleSize: `${bottleMl} ml`,
      alcohol: t.abv,
      producer,
      wineName,
      appellation: t.region,
      vintage,
      country: t.country,
      color: colour.color,
      varietal: t.grapes.join(', '),
      image: p.featuredMedia?.preview?.image?.url || '',
      description: collapse(p.description || ''),
    };

    for (const v of p.variants.nodes) {
      if (!v.availableForSale) {
        skipped.outOfStock++;
        continue;
      }

      // Vivino: products with inventory < 1 must be left out; the maximum is 9999.
      const inventory = v.inventoryItem?.tracked ? (v.inventoryQuantity ?? 0) : CONFIG.defaultInventory;
      if (inventory < 1) {
        skipped.outOfStock++;
        continue;
      }

      entries.push({
        ...shared,
        price: Number(v.price).toFixed(2),
        bottleQuantity: bottleQuantity(v),
        quantityIsMinimum: value(v.quantityIsMinimum) === 'true' ? 'true' : 'false',
        inventory: Math.min(inventory, 9999),
        productId: v.sku?.trim() || v.legacyResourceId,
        gtin: v.barcode?.trim() || '',
      });
    }
  }

  return { entries, skipped, warnings };
}

// ---------------------------------------------------------------- XML

const escapeXml = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // characters XML 1.0 forbids
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const tag = (name, val, indent) =>
  val === '' || val === null || val === undefined ? '' : `${indent}<${name}>${escapeXml(val)}</${name}>\n`;

function buildXml(entries) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<vivino-product-list>\n';
  xml += '  <meta-data>\n';
  xml += `    <feed-generation-date>${new Date().toISOString()}</feed-generation-date>\n`;
  xml += '  </meta-data>\n';
  for (const e of entries) {
    const i = '    ';
    const x = '      ';
    xml += '  <product>\n';
    xml += tag('product-name', e.name, i);
    xml += tag('price', e.price, i);
    xml += tag('quantity-is-minimum', e.quantityIsMinimum, i);
    xml += tag('bottle_size', e.bottleSize, i);
    xml += tag('bottle_quantity', e.bottleQuantity, i);
    xml += tag('link', e.link, i);
    xml += tag('inventory-count', e.inventory, i);
    xml += tag('product-id', e.productId, i);
    xml += `${i}<extras>\n`;
    xml += tag('alcohol', e.alcohol, x);
    xml += tag('producer', e.producer, x);
    xml += tag('wine-name', e.wineName, x);
    xml += tag('appellation', e.appellation, x);
    xml += tag('vintage', e.vintage, x);
    xml += tag('country', e.country, x);
    xml += tag('color', e.color, x);
    xml += tag('varietal', e.varietal, x);
    xml += tag('gtin', e.gtin, x);
    xml += tag('image', e.image, x);
    xml += tag('description', e.description, x);
    xml += `${i}</extras>\n`;
    xml += '  </product>\n';
  }
  xml += '</vivino-product-list>\n';
  return xml;
}

// ---------------------------------------------------------------- main

function printWarnings(warnings) {
  const show = (label, titles) => {
    if (!titles.length) return;
    console.log(`\n  ${titles.length} ${label}:`);
    for (const title of titles.slice(0, 20)) console.log(`    - ${title}`);
    if (titles.length > 20) console.log(`    ... and ${titles.length - 20} more`);
  };
  show('wines without a vintage (sent as NV)', warnings.noVintage);
  show('wines without an ABV (Vivino requires one)', warnings.noAbv);
  show('wines without a p__ producer tag', warnings.noProducer);
  show('wines left out for an unsupported bottle size', warnings.bottleSizes);
}

async function main() {
  if (!CONFIG.shop) throw new Error('SHOPIFY_STORE_DOMAIN is not set (e.g. your-store.myshopify.com).');

  const token = await getAccessToken();
  const collectionTitles = await fetchCollectionTitles(token);
  const products = await fetchProducts(token);
  const { entries, skipped, warnings } = buildEntries(products, collectionTitles);

  // Never replace a good feed with an empty one: fail the run instead.
  if (entries.length === 0) {
    throw new Error('No products ended up in the feed, so nothing was published. Check t__ tags, status and stock.');
  }

  await mkdir(path.dirname(CONFIG.outputFile), { recursive: true });
  await writeFile(CONFIG.outputFile, buildXml(entries), 'utf8');

  console.log(`\n✔ Wrote ${entries.length} entries from ${products.length} products to ${CONFIG.outputFile}`);
  console.log(
    `  Skipped: ${skipped.outOfStock} out-of-stock variants, ${skipped.notOnOnlineStore} products not on the Online Store, ` +
      `${skipped.unsupportedBottleSize} unsupported bottle sizes, ${skipped.notWine} not wine / excluded type`,
  );
  printWarnings(warnings);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
