#!/usr/bin/env node
'use strict';

/**
 * One-time script: creates all 18 Prisoncall products and prices in Stripe sandbox.
 *
 * Usage:
 *   node create-sandbox-products.js sk_test_XXXX
 *
 * Requirements:
 *   npm install stripe   (run once in this directory or a parent with node_modules)
 */

const key = process.argv[2];

if (!key) {
  console.error('Error: Stripe sandbox key required.');
  console.error('Usage: node create-sandbox-products.js sk_test_XXXX');
  process.exit(1);
}

if (!key.startsWith('sk_test_')) {
  console.error('Error: Key must be a Stripe TEST key (must start with sk_test_).');
  console.error('This script will not run against a live Stripe account.');
  process.exit(1);
}

let stripe;
try {
  stripe = require('stripe')(key);
} catch (e) {
  console.error('Error: Could not load the stripe package.');
  console.error('Run:  npm install stripe');
  process.exit(1);
}

/* ── Product definitions ─────────────────────────────────────────────────── */

const PRODUCTS = [
  /* ── Plans ── */
  {
    product_key: 'plan_weekly',
    name:        'Prisoncall Weekly Plan',
    amount:      1499,
    recurring:   { interval: 'week', interval_count: 1 },
  },
  {
    product_key: 'plan_fortnightly',
    name:        'Prisoncall Fortnightly Plan',
    amount:      1999,
    recurring:   { interval: 'week', interval_count: 2 },
  },
  {
    product_key: 'plan_monthly',
    name:        'Prisoncall Monthly Plan',
    amount:      3499,
    recurring:   { interval: 'month', interval_count: 1 },
  },
  {
    product_key: 'plan_annual',
    name:        'Prisoncall Annual Plan',
    amount:      34999,
    recurring:   { interval: 'year', interval_count: 1 },
  },

  /* ── Add-on 1: 48 Hours Cancellation Guarantee (one-time) ── */
  {
    product_key: 'addon_48hr_cancel',
    name:        '48 Hours Cancellation Guarantee',
    amount:      599,
    recurring:   null,
  },

  /* ── Add-on 2: Unlimited Prison Transfers (recurring) ── */
  {
    product_key: 'addon_transfers_weekly',
    name:        'Unlimited Prison Transfers (Weekly)',
    amount:      299,
    recurring:   { interval: 'week', interval_count: 1 },
  },
  {
    product_key: 'addon_transfers_fortnightly',
    name:        'Unlimited Prison Transfers (Fortnightly)',
    amount:      399,
    recurring:   { interval: 'week', interval_count: 2 },
  },
  {
    product_key: 'addon_transfers_monthly',
    name:        'Unlimited Prison Transfers (Monthly)',
    amount:      499,
    recurring:   { interval: 'month', interval_count: 1 },
  },
  {
    product_key: 'addon_transfers_annual',
    name:        'Unlimited Prison Transfers (Annual)',
    amount:      1999,
    recurring:   { interval: 'year', interval_count: 1 },
  },

  /* ── Add-on 3: 96 Hours Post Renewal Cancellation (recurring) ── */
  {
    product_key: 'addon_post_renewal_weekly',
    name:        '96 Hours Post Renewal Cancellation (Weekly)',
    amount:      299,
    recurring:   { interval: 'week', interval_count: 1 },
  },
  {
    product_key: 'addon_post_renewal_fortnightly',
    name:        '96 Hours Post Renewal Cancellation (Fortnightly)',
    amount:      399,
    recurring:   { interval: 'week', interval_count: 2 },
  },
  {
    product_key: 'addon_post_renewal_monthly',
    name:        '96 Hours Post Renewal Cancellation (Monthly)',
    amount:      499,
    recurring:   { interval: 'month', interval_count: 1 },
  },
  {
    product_key: 'addon_post_renewal_annual',
    name:        '96 Hours Post Renewal Cancellation (Annual)',
    amount:      1999,
    recurring:   { interval: 'year', interval_count: 1 },
  },

  /* ── Combo: Bundle Deal (recurring) ── */
  {
    product_key: 'addon_combo23_weekly',
    name:        'Bundle Deal (Weekly)',
    amount:      499,
    recurring:   { interval: 'week', interval_count: 1 },
  },
  {
    product_key: 'addon_combo23_fortnightly',
    name:        'Bundle Deal (Fortnightly)',
    amount:      699,
    recurring:   { interval: 'week', interval_count: 2 },
  },
  {
    product_key: 'addon_combo23_monthly',
    name:        'Bundle Deal (Monthly)',
    amount:      799,
    recurring:   { interval: 'month', interval_count: 1 },
  },
  {
    product_key: 'addon_combo23_annual',
    name:        'Bundle Deal (Annual)',
    amount:      3399,
    recurring:   { interval: 'year', interval_count: 1 },
  },

  /* ── Lifetime: Lifetime Protection Bundle (one-time) ── */
  {
    product_key: 'has_lifetime_protection',
    name:        'Lifetime Protection Bundle',
    amount:      2999,
    recurring:   null,
  },
];

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('Creating ' + PRODUCTS.length + ' Stripe sandbox products...\n');

  const results = [];

  for (const def of PRODUCTS) {
    try {
      const product = await stripe.products.create({
        name:     def.name,
        metadata: { product_key: def.product_key },
      });

      const priceParams = {
        product:     product.id,
        unit_amount: def.amount,
        currency:    'aud',
        metadata:    { product_key: def.product_key },
      };
      if (def.recurring) {
        priceParams.recurring = def.recurring;
      }

      const price = await stripe.prices.create(priceParams);

      console.log('  created  ' + def.product_key + '  →  ' + price.id);
      results.push({ product_key: def.product_key, price_id: price.id });

    } catch (err) {
      console.error('\nFAILED on ' + def.product_key + ': ' + err.message);
      process.exit(1);
    }
  }

  /* ── Summary table ── */
  const COL = 35;
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY — copy these into the admin portal (Test Price ID column)');
  console.log('='.repeat(70));
  console.log('product_key'.padEnd(COL) + '| price_id');
  console.log('-'.repeat(COL) + '+' + '-'.repeat(34));
  for (const r of results) {
    console.log(r.product_key.padEnd(COL) + '| ' + r.price_id);
  }
  console.log('='.repeat(70));
  console.log('\nDone. ' + results.length + ' price IDs ready to paste.\n');
}

main().catch(function(err) {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
