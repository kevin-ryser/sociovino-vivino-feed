# Vivino product feed for Shopify

This generates a Vivino-format XML feed from your Shopify store every hour and hosts it on GitHub Pages:

```
https://<your-github-username>.github.io/<repo-name>/vivino.xml
```

It includes every **active** wine (any product with a `t__…-wine` tag) that is published to the Online Store, one entry per in-stock variant. Wine data is read from the theme's `key__value` product tags, the same ones `snippets/parse-tags.liquid` uses. There's no product limit, no server, and no cost.

## 1. Create the Shopify app

1. Go to the **Shopify Dev Dashboard** (dev.shopify.com) and log in with the account that owns your store.
2. Choose **Create app**, give it a name like "Vivino feed", and create it.
3. Under the app's configuration / versions, set the **Admin API scopes** to `read_products` and `read_inventory`. Leave everything else off; the feed only reads data.
4. Release the version, then **install the app on your store**.
5. Open the app's **Settings** and copy the **Client ID** and **Client secret**.

The script uses these with Shopify's client credentials grant to get a fresh access token on every run. Shopify's menu names shift from time to time, so if something above is labelled slightly differently, look for the same options nearby.

> Already have an older custom app made in the Shopify admin, with an Admin API access token (`shpat_...`)? You can use that token instead of the client ID and secret, as long as it has the same two scopes.

## 2. Create the GitHub repository

1. On GitHub, create a new repository, e.g. `vivino-feed`. Make it **public**: GitHub Pages on private repositories needs a paid GitHub plan. Nothing secret lives in the code, because credentials go into encrypted secrets (step 3), and the feed only contains product data that's already public in your shop.
2. Upload all the files from this folder, keeping the structure:
   ```
   build-feed.mjs
   README.md
   .gitignore
   .github/workflows/vivino-feed.yml
   ```
   In the web uploader, drag in the whole folder so the `.github/workflows` path is kept.

## 3. Add your credentials as secrets

In the repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `your-store.myshopify.com` (the myshopify domain, not your own domain) |
| `SHOPIFY_CLIENT_ID` | Client ID from step 1 |
| `SHOPIFY_CLIENT_SECRET` | Client secret from step 1 |

Or, instead of the last two, `SHOPIFY_ACCESS_TOKEN` with an existing `shpat_...` token.

Optional settings go on the **Variables** tab of the same page:

| Variable | Default | Meaning |
|---|---|---|
| `WINE_TYPE_TAGS` | `red-wine,white-wine,rose-wine,sparkling-wine,sweet-wine,orange-wine` | `t__` tag values that count as wine |
| `EXCLUDED_PRODUCT_TYPES` | `Wine Case,Wine Club,Gift Card` | Product types that are never included (mixed cases aren't allowed on Vivino) |
| `NAME_USES_SUBTITLE` | `false` | `true` adds the part of the product title after `\|` to the wine name |
| `DEFAULT_INVENTORY` | `24` | Stock count reported for variants where Shopify doesn't track inventory |

## 4. Turn on GitHub Pages

Go to **Settings → Pages**, and under **Build and deployment → Source** choose **GitHub Actions**.

## 5. Run it

Go to the **Actions** tab, choose **Build Vivino feed**, and click **Run workflow**. After a minute or two the run turns green and the deploy step shows the feed URL. Open it in your browser to check the output, then send that URL to Vivino.

From then on it rebuilds automatically every hour, and also whenever you push a change to `main`. If a run fails (for example when Shopify is unreachable, or the feed would be empty), nothing is published and Vivino keeps getting the last good feed. GitHub emails you about failed runs.

## Optional: use your own domain

To serve the feed at something like `https://feeds.yourstore.nl/vivino.xml`:

1. In **Settings → Pages → Custom domain**, enter `feeds.yourstore.nl` and save.
2. At your domain provider, add a **CNAME** record: `feeds` → `<your-github-username>.github.io`.
3. Once the DNS check passes, tick **Enforce HTTPS**.

## Product data (tags)

The feed reads the same `key__value` tags the theme already uses:

| Tag | Example | Feed field |
|---|---|---|
| `t__` | `t__red-wine`, `t__white-wine`, `t__rose-wine`, `t__sparkling-wine`, `t__sweet-wine`, `t__orange-wine` | Decides whether the product is a wine; colour (`<color>`, and in the name for white, rosé and orange) |
| `v__` | `v__2019`, `v__nv` | `vintage` (missing = `NV`) |
| `abv__` | `abv__135` = 13.5% | `alcohol` (**required by Vivino**) |
| `bs__` | `bs__75cl`, `bs__375cl`, `bs__50cl`, `bs__1l`, `bs__15l` (1.5 l) | `bottle_size` (missing = 750 ml) |
| `p__` | `p__ettore-germano` | `producer`: the title of the collection with that handle |
| `c__` | `c__italy` | `country` |
| `r__` | `r__piedmont` | `appellation` |
| `gv__` | `gv__nebbiolo` (can repeat) | `varietal` |

If a product has the older `global.product_details` metafield (`Vintage:2019|ABV:13.5%|Bottle Size:75cl|Grape Variety:…`), it fills in anything the tags don't have.

Vivino only accepts 375, 500, 750, 1000 and 1500 ml bottles. Wines with any other size are left out.

**Product name** is built as Producer + the product title before `|` + Vintage + Colour (not for red). Commas, `!`, quotes and `*` are removed, the producer isn't repeated if the title already contains it, and a vintage or colour already in the title is moved to the end. Vivino matches wines by this name and asks you not to change it once products are live, so check the first feed carefully.

**Cases and multi-buy:** each variant becomes its own entry. Bottle quantity comes from an optional variant metafield `custom.bottle_quantity` (integer), otherwise from a variant title like "Case of 6" or "12 Bottles", otherwise 1. Set the variant metafield `custom.quantity_is_minimum` (true/false) to `true` for a "6 or more" price.

Barcodes are sent as `gtin`, and the product's main image and description are included automatically.

Each run prints the wines with no vintage, no ABV or no producer tag, and those left out for their bottle size, so you can fix the data in Shopify.

## How the feed decides what to include

- The product must be **Active**, have one of the wine `t__` tags, not be a `Wine Case`, `Wine Club` or `Gift Card`, and be published to the **Online Store** sales channel (otherwise the link would be dead).
- The bottle size must be one Vivino supports.
- The variant must be available for sale and have stock of at least 1. Stock is capped at 9999.
- `product-id` is the variant SKU, or the Shopify variant ID when the SKU is empty.
- `link` is the product page. Vivino doesn't allow `?` or `=` in links, so variants aren't linked individually.
- Prices are taken exactly as stored in Shopify, including VAT, which is what Vivino wants outside the US and Canada.

## Things to know

- **Inactive repositories:** GitHub disables scheduled workflows in public repositories after **60 days without any repository activity**. It emails you first; to keep things running, click **Enable workflow** on the Actions tab or make any small commit (editing this README is enough) at least every couple of months.
- **Timing:** GitHub sometimes starts scheduled runs a few minutes late at busy times. For an hourly stock feed this doesn't matter.
- **API versions:** Shopify retires each API version about a year after release. The version is set at the top of `build-feed.mjs` (`2026-07`) and can be overridden with a `SHOPIFY_API_VERSION` variable. Bump it about once a year.
- **Tag names:** The XML tag names follow Vivino's feed specification. If Vivino asks for a different name for a field, change it in the `buildXml` function in `build-feed.mjs`.

## Testing locally

With Node.js 20 or newer:

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
SHOPIFY_CLIENT_ID=xxx \
SHOPIFY_CLIENT_SECRET=yyy \
node build-feed.mjs
```

The feed is written to `public/vivino.xml`.
