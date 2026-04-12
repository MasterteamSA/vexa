/**
 * Unit tests for Google Meet admission detection logic.
 *
 * Validates that:
 * 1. Admission indicators are authoritative (win over lobby indicators)
 * 2. Waiting room selectors don't include false-positive triggers
 * 3. The join flow handles both anonymous and signed-in paths
 *
 * Run with: npx ts-node tests/test_admission_logic.ts
 */

import {
  googleInitialAdmissionIndicators,
  googleWaitingRoomIndicators,
  googleRejectionIndicators,
  googleJoinButtonSelectors,
  googleNameInputSelectors,
} from "../src/platforms/googlemeet/selectors";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

console.log("\n=== Test 1: Waiting room selectors must NOT include generic loading indicators ===");
const dangerousPatterns = [
  '[role="progressbar"]',
  '[aria-label*="loading"]',
  '.loading-spinner',
];
for (const pattern of dangerousPatterns) {
  assert(
    !googleWaitingRoomIndicators.includes(pattern),
    `Waiting room should NOT include '${pattern}' (causes false positives in meeting room)`
  );
}

console.log("\n=== Test 2: Waiting room selectors must NOT include join buttons ===");
const joinButtonTexts = ['text="Ask to join"', 'text="Join now"'];
for (const text of joinButtonTexts) {
  assert(
    !googleWaitingRoomIndicators.includes(text),
    `Waiting room should NOT include '${text}' (that's a pre-join button, not waiting room)`
  );
}

console.log("\n=== Test 3: Waiting room selectors must NOT include rejection indicators ===");
const rejectionTexts = ['text="Can\'t join the meeting"', 'text="Meeting not found"'];
for (const text of rejectionTexts) {
  assert(
    !googleWaitingRoomIndicators.includes(text),
    `Waiting room should NOT include '${text}' (that's a rejection, not waiting room)`
  );
}

console.log("\n=== Test 4: Admission indicators should include essential meeting controls ===");
const essentialAdmission = [
  'button[aria-label*="Leave call"]',
  '[data-participant-id]',
  'button[aria-label*="Turn off microphone"]',
];
for (const selector of essentialAdmission) {
  assert(
    googleInitialAdmissionIndicators.includes(selector),
    `Admission indicators should include '${selector}'`
  );
}

console.log("\n=== Test 5: Waiting room indicators should only match explicit waiting text ===");
for (const selector of googleWaitingRoomIndicators) {
  const isExplicitWaiting =
    selector.includes("Asking to be let in") ||
    selector.includes("join the call when someone lets you") ||
    selector.includes("wait until a meeting host") ||
    selector.includes("Waiting for the host") ||
    selector.includes("waiting room") ||
    selector.includes("waiting for admission");
  assert(
    isExplicitWaiting,
    `Waiting room selector '${selector}' should match explicit waiting text`
  );
}

console.log("\n=== Test 6: Join selectors should cover both anonymous and signed-in flows ===");
assert(
  googleJoinButtonSelectors.some(s => s.includes("Ask to join")),
  "Should have 'Ask to join' selector (anonymous flow)"
);
assert(
  googleJoinButtonSelectors.some(s => s.includes("Join now")),
  "Should have 'Join now' selector (signed-in flow)"
);

console.log("\n=== Test 7: Name input selectors should exist for anonymous flow ===");
assert(
  googleNameInputSelectors.length > 0,
  "Should have at least one name input selector"
);
assert(
  googleNameInputSelectors.some(s => s.includes('aria-label="Your name"')),
  "Should have aria-label name input selector"
);

console.log("\n=== Test 8: No overlap between admission and waiting room selectors ===");
const overlap = googleInitialAdmissionIndicators.filter(s =>
  googleWaitingRoomIndicators.includes(s)
);
assert(
  overlap.length === 0,
  `No selectors should appear in both admission and waiting room (overlap: ${overlap.join(", ") || "none"})`
);

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
