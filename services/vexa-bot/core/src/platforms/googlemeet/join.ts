import { Page } from "playwright";
import { log, randomDelay, callJoiningCallback } from "../../utils";
import { BotConfig } from "../../types";
import { 
  googleNameInputSelectors,
  googleJoinButtonSelectors,
  googleMicrophoneButtonSelectors,
  googleCameraButtonSelectors
} from "./selectors";

export async function joinGoogleMeeting(
  page: Page,
  meetingUrl: string,
  botName: string,
  botConfig: BotConfig
): Promise<void> {
  // Install RTCPeerConnection hook BEFORE navigation — intercepts per-speaker audio tracks
  // from Google Meet's SFU (Last-3 architecture: 3 separate audio streams for loudest speakers).
  // Each track is mirrored into a hidden <audio> element for per-speaker transcription.
  await page.addInitScript(() => {
    try {
      const win = window as any;
      if (win.__vexaPerSpeakerHookInstalled || typeof RTCPeerConnection !== 'function') {
        return;
      }

      win.__vexaPerSpeakerHookInstalled = true;
      win.__vexaPerSpeakerAudioElements = [];
      win.__vexaPerSpeakerPeerConnections = [];
      // CSRC → speaker name mapping (learned by correlating DOM speaker events with audio levels)
      win.__vexaCsrcToName = {};
      // Track ID → CSRC mapping (updated by polling getContributingSources)
      win.__vexaTrackToCsrc = {};

      const OriginalPC = RTCPeerConnection;

      function wrapPeerConnection(this: any, ...args: any[]) {
        const pc: RTCPeerConnection = new (OriginalPC as any)(...args);
        win.__vexaPerSpeakerPeerConnections.push(pc);

        const handleTrack = (event: RTCTrackEvent) => {
          try {
            if (!event.track || event.track.kind !== 'audio') {
              return;
            }

            const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);

            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.muted = false;
            audioEl.volume = 1.0;
            audioEl.dataset.vexaPerSpeaker = 'true';
            audioEl.dataset.vexaTrackId = event.track.id;
            audioEl.style.position = 'absolute';
            audioEl.style.left = '-9999px';
            audioEl.style.width = '1px';
            audioEl.style.height = '1px';
            audioEl.srcObject = stream;
            audioEl.play?.().catch(() => {});

            if (document.body) {
              document.body.appendChild(audioEl);
            } else {
              document.addEventListener('DOMContentLoaded', () => document.body?.appendChild(audioEl), { once: true });
            }

            win.__vexaPerSpeakerAudioElements.push(audioEl);
            win.logBot?.(`[PerSpeaker] Injected audio element for track=${event.track.id}, readyState=${event.track.readyState}`);
          } catch (hookError) {
            console.error('Vexa per-speaker audio hook error:', hookError);
          }
        };

        pc.addEventListener('track', handleTrack);

        // Also wrap the ontrack setter to catch tracks registered via property assignment
        const originalOnTrack = Object.getOwnPropertyDescriptor(OriginalPC.prototype, 'ontrack');
        if (originalOnTrack && originalOnTrack.set) {
          Object.defineProperty(pc, 'ontrack', {
            set(handler: any) {
              if (typeof handler !== 'function') {
                return originalOnTrack.set!.call(this, handler);
              }
              const wrapped = function (this: RTCPeerConnection, event: RTCTrackEvent) {
                handleTrack(event);
                return handler.call(this, event);
              };
              return originalOnTrack.set!.call(this, wrapped);
            },
            get: originalOnTrack.get,
            configurable: true,
            enumerable: true
          });
        }

        // Clean up on connection close
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            const idx = win.__vexaPerSpeakerPeerConnections.indexOf(pc);
            if (idx >= 0) win.__vexaPerSpeakerPeerConnections.splice(idx, 1);
          }
        });

        return pc;
      }

      wrapPeerConnection.prototype = OriginalPC.prototype;
      Object.setPrototypeOf(wrapPeerConnection, OriginalPC);
      (window as any).RTCPeerConnection = wrapPeerConnection as any;

      // Poll CSRC data every 200ms to build track → speaker mappings
      setInterval(() => {
        try {
          const pcs = win.__vexaPerSpeakerPeerConnections || [];
          for (const pc of pcs) {
            if (!pc.getReceivers) continue;
            for (const receiver of pc.getReceivers()) {
              if (receiver.track?.kind !== 'audio') continue;
              const trackId = receiver.track.id;

              // getContributingSources returns CSRC entries from the SFU
              const csrcs = receiver.getContributingSources?.() || [];
              for (const src of csrcs) {
                if (src.source) {
                  win.__vexaTrackToCsrc[trackId] = src.source;
                }
              }

              // getSynchronizationSources for presence detection
              const ssrcs = receiver.getSynchronizationSources?.() || [];
              if (ssrcs.length > 0) {
                win.__vexaTrackToCsrc[trackId] = win.__vexaTrackToCsrc[trackId] || ssrcs[0].source;
              }
            }
          }
        } catch {}
      }, 200);

      // Expose a function to learn CSRC → name mapping
      // Called by the DOM-based speaker detection when it identifies a speaker
      win.__vexaLearnSpeakerCsrc = (speakerName: string) => {
        try {
          // Find which track currently has the highest audio level
          const pcs = win.__vexaPerSpeakerPeerConnections || [];
          let bestTrackId: string | null = null;
          let bestLevel = 0;

          for (const pc of pcs) {
            if (!pc.getReceivers) continue;
            for (const receiver of pc.getReceivers()) {
              if (receiver.track?.kind !== 'audio') continue;
              const csrcs = receiver.getContributingSources?.() || [];
              for (const src of csrcs) {
                if (src.audioLevel !== undefined && src.audioLevel > bestLevel) {
                  bestLevel = src.audioLevel;
                  bestTrackId = receiver.track.id;
                }
              }
            }
          }

          if (bestTrackId && bestLevel > 0.01) {
            const csrc = win.__vexaTrackToCsrc[bestTrackId];
            if (csrc) {
              const prevName = win.__vexaCsrcToName[csrc];
              if (prevName !== speakerName) {
                win.__vexaCsrcToName[csrc] = speakerName;
                win.logBot?.(`[PerSpeaker] Learned: CSRC ${csrc} → "${speakerName}" (track=${bestTrackId}, level=${bestLevel.toFixed(3)})`);
              }
            }
          }
        } catch {}
      };

      // Expose function to get participant count from WebRTC (replaces DOM-based counting)
      win.__vexaGetWebRTCParticipantCount = () => {
        try {
          const pcs = win.__vexaPerSpeakerPeerConnections || [];
          const now = performance.timeOrigin + performance.now();
          const activeSources = new Set<number>();

          for (const pc of pcs) {
            if (!pc.getReceivers) continue;
            for (const receiver of pc.getReceivers()) {
              if (receiver.track?.kind !== 'audio') continue;
              const ssrcs = receiver.getSynchronizationSources?.() || [];
              for (const src of ssrcs) {
                if (src.timestamp && (now - src.timestamp) < 5000) {
                  activeSources.add(src.source);
                }
              }
              const csrcs = receiver.getContributingSources?.() || [];
              for (const src of csrcs) {
                if (src.timestamp && (now - src.timestamp) < 5000) {
                  activeSources.add(src.source);
                }
              }
            }
          }

          return activeSources.size;
        } catch {
          return 0;
        }
      };

      // Expose function to get the current speaker name for a given track
      win.__vexaGetSpeakerForTrack = (trackId: string): string | null => {
        try {
          const csrc = win.__vexaTrackToCsrc[trackId];
          if (csrc && win.__vexaCsrcToName[csrc]) {
            return win.__vexaCsrcToName[csrc];
          }
          return null;
        } catch {
          return null;
        }
      };

      win.logBot?.('[PerSpeaker] RTCPeerConnection patched for per-speaker audio capture + CSRC mapping.');
    } catch (initError) {
      console.error('Failed to install Vexa per-speaker audio hook:', initError);
    }
  });

  await page.goto(meetingUrl, { waitUntil: "networkidle" });
  await page.bringToFront();

  // Take screenshot after navigation
  await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-after-navigation.png', fullPage: true });
  log("📸 Screenshot taken: After navigation to meeting URL");
  
  // --- Call joining callback to notify bot-manager that bot is joining ---
  try {
    await callJoiningCallback(botConfig);
    log("Joining callback sent successfully");
  } catch (callbackError: any) {
    log(`Warning: Failed to send joining callback: ${callbackError.message}. Continuing with join process...`);
  }

  // Wait for page elements to settle after navigation
  log("Waiting for page elements to settle after navigation...");
  await page.waitForTimeout(5000);

  await page.waitForTimeout(randomDelay(1000));

  // ── Smart join: detect anonymous vs signed-in flow ─────────────────────
  // Anonymous: shows name input → fill name → click "Ask to join"
  // Signed-in: skips name input → shows "Join now" / "Ask to join" directly
  // We race both paths — whichever element appears first wins.
  log("Detecting join flow (anonymous vs signed-in)...");

  // Build combined selector: name input OR any join button
  const nameSelectors = googleNameInputSelectors;
  const joinSelectors = googleJoinButtonSelectors;
  const allSelectors = [...nameSelectors, ...joinSelectors];

  // Wait for ANY of these elements to appear (up to 120s)
  let detectedElement: string | null = null;
  let isAnonymousFlow = false;

  try {
    // Race: first visible element wins
    const result = await Promise.race(
      allSelectors.map(async (selector) => {
        try {
          await page.waitForSelector(selector, { timeout: 120000, state: 'visible' });
          return selector;
        } catch {
          return null;
        }
      })
    );
    detectedElement = result;
  } catch {
    detectedElement = null;
  }

  // If the race finished but returned null (all timed out), try a fallback scan
  if (!detectedElement) {
    log("Race returned no result. Scanning for any visible element...");
    for (const selector of allSelectors) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          detectedElement = selector;
          break;
        }
      } catch {}
    }
  }

  if (!detectedElement) {
    // Last resort: take screenshot and throw
    await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-no-elements-found.png', fullPage: true });
    throw new Error("Could not find name input or join button after 120 seconds");
  }

  isAnonymousFlow = nameSelectors.includes(detectedElement);
  log(`Detected ${isAnonymousFlow ? 'ANONYMOUS' : 'SIGNED-IN'} flow (matched: ${detectedElement})`);

  await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-flow-detected.png', fullPage: true });
  log("📸 Screenshot taken: Join flow detected");

  if (isAnonymousFlow) {
    // ── Anonymous flow: fill name, then find join button ──────────────────
    log("Anonymous flow: filling bot name...");
    await page.waitForTimeout(randomDelay(500));
    await page.fill(detectedElement, botName);
    log(`Filled bot name: ${botName}`);
  }

  // ── Mute mic and camera (both flows) ─────────────────────────────────
  for (const micSelector of googleMicrophoneButtonSelectors) {
    try {
      const mic = await page.$(micSelector);
      if (mic && await mic.isVisible()) {
        await mic.click();
        log("Microphone toggled.");
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(300);

  for (const camSelector of googleCameraButtonSelectors) {
    try {
      const cam = await page.$(camSelector);
      if (cam && await cam.isVisible()) {
        await cam.click();
        log("Camera toggled.");
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(300);

  // ── Click join button ────────────────────────────────────────────────
  let joined = false;
  for (const joinSelector of joinSelectors) {
    try {
      const btn = await page.waitForSelector(joinSelector, { timeout: 15000, state: 'visible' });
      if (btn) {
        await btn.click();
        log(`Clicked join button: ${joinSelector}`);
        joined = true;
        break;
      }
    } catch {}
  }

  if (!joined) {
    await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-no-join-button.png', fullPage: true });
    throw new Error("Could not find or click any join button");
  }

  log(`${botName} joined the Google Meet Meeting.`);
  await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-after-join.png', fullPage: true });
  log("📸 Screenshot taken: After clicking join button");
}
