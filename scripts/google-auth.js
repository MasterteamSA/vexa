/**
 * Google Account Authentication for Vexa Meeting Bot
 *
 * Run this script locally (on a machine with a display) to sign in to the
 * bot's Google account and save the session state. Then upload the generated
 * auth-state.json file to the server.
 *
 * Usage:
 *   npx playwright install chromium
 *   node scripts/google-auth.js
 *
 * A browser window will open. Sign in with the bot's Google account
 * (automation@masterteam.sa). After sign-in completes, the session
 * will be saved to google-auth-state.json.
 */

const { chromium } = require('playwright');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'google-auth-state.json');

(async () => {
  console.log('Opening browser for Google sign-in...');
  console.log('Sign in with: automation@masterteam.sa');
  console.log('');

  const browser = await chromium.launch({
    headless: false,  // Must be visible for manual sign-in
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Navigate to Google sign-in
  await page.goto('https://accounts.google.com/signin');

  console.log('Waiting for you to complete sign-in...');
  console.log('(The script will detect when you reach the Google homepage or Meet)');
  console.log('');

  // Wait until the user has signed in (detect by URL change to myaccount, gmail, or meet)
  await page.waitForURL(/myaccount\.google|mail\.google|meet\.google|accounts\.google\.com\/b/, {
    timeout: 300000  // 5 minutes to sign in
  });

  console.log('Sign-in detected! Saving session state...');

  // Also visit meet.google.com to get Meet-specific cookies
  await page.goto('https://meet.google.com');
  await page.waitForTimeout(3000);

  // Save the storage state (cookies + localStorage)
  await context.storageState({ path: OUTPUT_PATH });

  console.log('');
  console.log(`Session saved to: ${OUTPUT_PATH}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Upload this file to the server:');
  console.log(`   scp ${OUTPUT_PATH} mabuhalib@linux-2:/tmp/google-auth-state.json`);
  console.log('2. Copy it into the Vexa container:');
  console.log('   ssh mabuhalib@linux-2 "sudo docker cp /tmp/google-auth-state.json vexa:/app/google-auth-state.json"');

  await browser.close();
})();
