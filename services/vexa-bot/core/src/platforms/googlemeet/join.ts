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

  // Add a longer, fixed wait after navigation for page elements to settle
  log("Waiting for page elements to settle after navigation...");
  await page.waitForTimeout(5000); // Wait 5 seconds

  // Enter name and join
  await page.waitForTimeout(randomDelay(1000));
  log("Attempting to find name input field...");
  
  // Use selector from selectors.ts instead of inline
  const nameFieldSelector = googleNameInputSelectors[0];
  await page.waitForSelector(nameFieldSelector, { timeout: 120000 }); // 120 seconds
  log("Name input field found.");
  
  // Take screenshot after finding name field
  await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-name-field-found.png', fullPage: true });
  log("📸 Screenshot taken: Name input field found");

  await page.waitForTimeout(randomDelay(1000));
  await page.fill(nameFieldSelector, botName);

  // Mute mic and camera if available
  try {
    await page.waitForTimeout(randomDelay(500));
    const micSelector = googleMicrophoneButtonSelectors[0];
    await page.click(micSelector, { timeout: 200 });
    await page.waitForTimeout(200);
  } catch (e) {
    log("Microphone already muted or not found.");
  }
  
  try {
    await page.waitForTimeout(randomDelay(500));
    const cameraSelector = googleCameraButtonSelectors[0];
    await page.click(cameraSelector, { timeout: 200 });
    await page.waitForTimeout(200);
  } catch (e) {
    log("Camera already off or not found.");
  }

  // Use join button selector from selectors.ts
  const joinSelector = googleJoinButtonSelectors[0];
  await page.waitForSelector(joinSelector, { timeout: 60000 });
  await page.click(joinSelector);
  log(`${botName} joined the Google Meet Meeting.`);
  
  // Take screenshot after clicking "Ask to join"
  await page.screenshot({ path: '/app/storage/screenshots/bot-checkpoint-0-after-ask-to-join.png', fullPage: true });
  log("📸 Screenshot taken: After clicking 'Ask to join'");
}
