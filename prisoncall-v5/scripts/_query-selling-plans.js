#!/usr/bin/env node
'use strict';

/**
 * One-off script: queries Shopify Storefront API for all selling plan groups.
 *
 * Usage (pass token as CLI arg):
 *   node _query-selling-plans.js <STOREFRONT_ACCESS_TOKEN>
 *
 * Or set env vars and run without args:
 *   $env:SHOPIFY_STORE_DOMAIN="nq5ig1-5w.myshopify.com"
 *   $env:SHOPIFY_STOREFRONT_ACCESS_TOKEN="your-token"
 *   node _query-selling-plans.js
 */

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'nq5ig1-5w.myshopify.com';
const ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || process.argv[2];
const API_VERSION  = '2025-04';

if (!ACCESS_TOKEN) {
  console.error('Error: Storefront access token required.');
  console.error('Usage:  node _query-selling-plans.js <YOUR_STOREFRONT_TOKEN>');
  console.error('   or:  set SHOPIFY_STOREFRONT_ACCESS_TOKEN env var, then run without arg.');
  process.exit(1);
}

const ENDPOINT = `https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`;

const QUERY = `{
  nodes(ids: [
    "gid://shopify/Product/10440892154135",
    "gid://shopify/Product/10440892678423",
    "gid://shopify/Product/10440893104407"
  ]) {
    ... on Product {
      id
      title
      sellingPlanGroups(first: 5) {
        edges {
          node {
            name
            sellingPlans(first: 5) {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}`;

async function run() {
  console.log(`\nQuerying ${ENDPOINT} ...\n`);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query: QUERY }),
  });

  if (!res.ok) {
    console.error(`HTTP error ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.error(text);
    process.exit(1);
  }

  const json = await res.json();

  if (json.errors) {
    console.error('GraphQL errors:');
    console.error(JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  const products = json.data.nodes;

  if (!products || !products.length) {
    console.log('No products found.');
    return;
  }

  products.forEach(product => {
    if (!product) return;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Product: ${product.title}`);
    console.log(`  GID:   ${product.id}`);
    const groups = product.sellingPlanGroups.edges;
    if (!groups.length) {
      console.log('  (no selling plan groups)');
    } else {
      groups.forEach(({ node: group }) => {
        console.log(`\n  Selling Plan Group: "${group.name}"`);
        const plans = group.sellingPlans.edges;
        if (!plans.length) {
          console.log('    (no selling plans)');
        } else {
          plans.forEach(({ node: plan }) => {
            const numericId = plan.id.split('/').pop();
            console.log(`    Name:       ${plan.name}`);
            console.log(`    ID (full):  ${plan.id}`);
            console.log(`    ID (numeric): ${numericId}`);
            console.log('');
          });
        }
      });
    }
  });

  console.log('\n--- Raw JSON ---');
  console.log(JSON.stringify(json.data, null, 2));
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
