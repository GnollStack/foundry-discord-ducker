/**
 * foundry-discord-ducker Module
 *
 * Automatically ducks audio in Foundry VTT when Discord voice activity is detected.
 * Requires the companion Discord bot to be running.
 *
 * @module foundry-discord-ducker
 * @version 0.1.0
 * @license MIT
 * @author GnollStack
 */

const MODULE_ID = "foundry-discord-ducker";

// ============================================================================
// CONFIGURATION
// ============================================================================
const RECONNECT_DELAY_MS = 5000; // Wait 5 seconds before reconnecting if connection drops

// Helper function to get settings (only available after init)
function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

// ============================================================================
// SETTINGS REGISTRATION
// ============================================================================
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enableDucking", {
    name: "Enable Discord Ducking",
    hint: "When enabled, your playlist volume will automatically lower when someone speaks in the connected Discord voice channel.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      if (value && !isConnected) {
        connectToDiscordBot();
      } else if (!value) {
        // Restore volume if currently ducked
        if (isDucked && originalVolume !== null) {
          game.settings.set("core", "globalPlaylistVolume", originalVolume);
          isDucked = false;
          console.log(
            `${MODULE_ID} | 🎚️ Ducking disabled, restored volume to ${(
              originalVolume * 100
            ).toFixed(0)}%`
          );
        }
        if (websocket) {
          websocket.close();
        }
      }
    },
  });

  game.settings.register(MODULE_ID, "websocketUrl", {
    name: "WebSocket URL",
    hint: "The WebSocket server address where the Discord bot is running (e.g., ws://localhost:8080 or ws://192.168.1.100:8080).",
    scope: "client",
    config: true,
    type: String,
    default: "ws://localhost:8080",
  });

  game.settings.register(MODULE_ID, "authToken", {
    name: "Authentication Token",
    hint: "The secret token to authenticate with the Discord bot. Get this from your GM.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "duckReductionPercent", {
    name: "Volume Reduction (%)",
    hint: "How much to reduce your volume by when someone is speaking. 20% means your volume drops by 20% (e.g., 100% → 80%, 50% → 40%).",
    scope: "client",
    config: true,
    type: Number,
    default: 30,
    range: {
      min: 5,
      max: 100,
      step: 5,
    },
  });

  game.settings.register(MODULE_ID, "duckDurationMs", {
    name: "Duck Fade Duration (ms)",
    hint: "How quickly the volume fades down when ducking begins. Lower = faster.",
    scope: "client",
    config: true,
    type: Number,
    default: 500,
    range: {
      min: 100,
      max: 5000,
      step: 100,
    },
  });

  game.settings.register(MODULE_ID, "unduckDurationMs", {
    name: "Unduck Fade Duration (ms)",
    hint: "How quickly the volume fades back up after speaking stops. Lower = faster.",
    scope: "client",
    config: true,
    type: Number,
    default: 1200,
    range: {
      min: 100,
      max: 5000,
      step: 100,
    },
  });

  game.settings.register(MODULE_ID, "unduckDelayMs", {
    name: "Unduck Delay (ms)",
    hint: "How long to wait after speaking stops before volume starts fading back up. Useful to prevent volume bouncing during conversation pauses.",
    scope: "client",
    config: true,
    type: Number,
    default: 0,
    range: {
      min: 0,
      max: 3000,
      step: 100,
    },
  });

  game.settings.register(MODULE_ID, "volumeDuckingFps", {
    name: "Volume Ducking FPS",
    hint: "How many times per second to update the volume slider during ducking. Higher = smoother visual feedback, but more CPU usage. Audio fading is always smooth regardless of this setting.",
    scope: "client",
    config: true,
    type: Number,
    default: 30,
    range: {
      min: 5,
      max: 60,
      step: 5,
    },
  });

  game.settings.register(MODULE_ID, "debugLogging", {
    name: "Enable Debug Logging",
    hint: "Show detailed console logs for troubleshooting. Also shows notifications when volume baseline changes.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
});

// ============================================================================
// HANDLE NEW SOUNDS STARTING WHILE DUCKED
// ============================================================================
Hooks.on("playSound", (sound) => {
  if (!isDucked) return;

  // A new sound started while we're ducked - fade it to duck volume
  const reductionPercent = getSetting("duckReductionPercent");
  const volumeRatio = 1 - reductionPercent / 100;

  // Wait a tiny bit for the sound to initialize its gain node
  setTimeout(() => {
    if (sound.gain && isDucked) {
      const currentVolume = sound.gain.value;
      const targetVolume = currentVolume * volumeRatio;

      // Smooth fade instead of instant cut
      try {
        sound.fade(Math.max(targetVolume, 0.0001), {
          duration: 200,
          from: Math.max(currentVolume, 0.0001),
          type: "exponential",
        });
      } catch (err) {
        // Fallback to instant if fade fails
        sound.gain.value = targetVolume;
      }

      const debugEnabled = getSetting("debugLogging");
      if (debugEnabled) {
        console.log(
          `${MODULE_ID} | 🎵 Fading newly started sound to duck level: ${sound.src}`
        );
      }
    }
  }, 50);
});

// ============================================================================
// TRACK MANUAL VOLUME CHANGES
// ============================================================================

/**
 * Check if user manually changed volume and update baseline if needed.
 * Called before ducking to ensure we have the correct baseline.
 */
function checkForManualVolumeChange() {
  // Can't check if we don't have a baseline yet
  if (originalVolume === null) return;

  // Don't check while we're fading
  if (currentFade) return;

  const currentVolume = game.settings.get("core", "globalPlaylistVolume");
  const reductionPercent = getSetting("duckReductionPercent");
  const expectedDuckedVolume = originalVolume * (1 - reductionPercent / 100);

  // Allow small tolerance for floating point comparison
  const tolerance = 0.01;

  // If not ducked, current volume should match originalVolume
  // If it doesn't, user changed it manually
  if (!isDucked) {
    if (Math.abs(currentVolume - originalVolume) > tolerance) {
      const oldBaseline = originalVolume;
      originalVolume = currentVolume;

      const debugEnabled = getSetting("debugLogging");
      if (debugEnabled) {
        console.log(
          `${MODULE_ID} | 🎚️ Manual volume change detected: ${(
            oldBaseline * 100
          ).toFixed(0)}% → ${(currentVolume * 100).toFixed(0)}%`
        );
        ui.notifications.info(
          `Discord Ducker: Volume baseline updated to ${(
            currentVolume * 100
          ).toFixed(0)}%`
        );
      }
    }
  }
  // If ducked, current volume should match expectedDuckedVolume
  // If it's higher than expected AND higher than ducked level, user raised it manually
  else {
    if (currentVolume > expectedDuckedVolume + tolerance) {
      // User raised volume while ducked - they want it louder
      // Calculate what their intended baseline would be
      const newBaseline = currentVolume / (1 - reductionPercent / 100);
      const oldBaseline = originalVolume;
      originalVolume = Math.min(newBaseline, 1.0); // Cap at 100%

      const debugEnabled = getSetting("debugLogging");
      if (debugEnabled) {
        console.log(
          `${MODULE_ID} | 🎚️ Volume raised while ducked: baseline ${(
            oldBaseline * 100
          ).toFixed(0)}% → ${(originalVolume * 100).toFixed(0)}%`
        );
        ui.notifications.info(
          `Discord Ducker: Volume baseline updated to ${(
            originalVolume * 100
          ).toFixed(0)}%`
        );
      }
    }
  }
}

// ============================================================================
// STATE
// ============================================================================
let websocket = null;
let isConnected = false;
let isDucked = false;
let originalVolume = null;
let reconnectTimeout = null;
let currentFade = null; // Track active fade animation

// ============================================================================
// INITIALIZATION
// ============================================================================
Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | 🎵 Foundry Discord Ducker initializing...`);

  // Check if user has ducking enabled
  const duckingEnabled = game.settings.get(MODULE_ID, "enableDucking");
  if (!duckingEnabled) {
    console.log(
      `${MODULE_ID} | ⭕ Ducking disabled in settings, skipping WebSocket connection`
    );
    return;
  }

  // Store the current volume
  originalVolume = game.settings.get("core", "globalPlaylistVolume");
  console.log(
    `${MODULE_ID} | 📊 Current global playlist volume: ${originalVolume}`
  );

  // Connect to Discord bot
  connectToDiscordBot();
});

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================
function connectToDiscordBot() {
  const websocketUrl = getSetting("websocketUrl");
  const authToken = getSetting("authToken");

  // Validate auth token
  if (!authToken || authToken.trim() === "") {
    console.warn(`${MODULE_ID} | ⚠️ No auth token configured`);
    ui.notifications.warn(
      "Discord Ducker: Please configure your authentication token in module settings"
    );
    return;
  }

  // Build URL with auth token
  const urlWithAuth = `${websocketUrl}?token=${encodeURIComponent(authToken)}`;
  console.log(
    `${MODULE_ID} | 🔌 Attempting to connect to Discord bot at ${websocketUrl}...`
  );

  try {
    websocket = new WebSocket(urlWithAuth);

    // ====================================================================
    // CONNECTION OPENED
    // ====================================================================
    websocket.onopen = () => {
      isConnected = true;
      console.log(`${MODULE_ID} | ✅ Connected to Discord bot!`);
      ui.notifications.info("Discord Ducker: Connected to Discord bot");

      // Clear any pending reconnect
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    };

    // ====================================================================
    // MESSAGE RECEIVED
    // ====================================================================
    websocket.onmessage = (event) => {
      const debugEnabled = getSetting("debugLogging");
      if (debugEnabled) {
        console.log(`${MODULE_ID} | 📨 Received message:`, event.data);
      }

      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (error) {
        console.error(`${MODULE_ID} | ❌ Failed to parse message:`, error);
      }
    };

    // ====================================================================
    // CONNECTION CLOSED
    // ====================================================================
    websocket.onclose = (event) => {
      isConnected = false;

      // Check for auth rejection
      if (event.code === 4001) {
        console.error(
          `${MODULE_ID} | 🔒 Authentication failed - check your token`
        );
        ui.notifications.error(
          "Discord Ducker: Authentication failed - check your token in settings"
        );
        return; // Don't auto-reconnect on auth failure
      }

      console.log(
        `${MODULE_ID} | 🔌 Disconnected from Discord bot (code: ${event.code})`
      );
      ui.notifications.warn("Discord Ducker: Disconnected from Discord bot");

      // Attempt to reconnect
      console.log(
        `${MODULE_ID} | ⏳ Will attempt to reconnect in ${
          RECONNECT_DELAY_MS / 1000
        } seconds...`
      );
      reconnectTimeout = setTimeout(connectToDiscordBot, RECONNECT_DELAY_MS);
    };

    // ====================================================================
    // CONNECTION ERROR
    // ====================================================================
    websocket.onerror = (error) => {
      console.error(`${MODULE_ID} | ❌ WebSocket error:`, error);
    };
  } catch (error) {
    console.error(`${MODULE_ID} | ❌ Failed to create WebSocket:`, error);
    // Try to reconnect
    reconnectTimeout = setTimeout(connectToDiscordBot, RECONNECT_DELAY_MS);
  }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================
function handleMessage(message) {
  const debugEnabled = getSetting("debugLogging");

  if (debugEnabled) {
    console.log(`${MODULE_ID} | 🎯 Handling message type: ${message.type}`);
  }

  switch (message.type) {
    case "DUCK":
      if (debugEnabled) {
        console.log(
          `${MODULE_ID} | 🔉 DUCK command received (${message.speakerCount} speaker(s))`
        );
      }
      duckVolume();
      break;

    case "UNDUCK":
      if (debugEnabled) {
        console.log(`${MODULE_ID} | 🔊 UNDUCK command received`);
      }
      unduckVolume();
      break;

    case "PING":
      if (debugEnabled) {
        console.log(`${MODULE_ID} | 🏓 PING received, sending PONG`);
      }
      if (websocket && isConnected) {
        websocket.send(JSON.stringify({ type: "PONG" }));
      }
      break;

    default:
      console.warn(`${MODULE_ID} | ⚠️  Unknown message type: ${message.type}`);
  }
}

// ============================================================================
// SMOOTH VOLUME FADING
// ============================================================================

/**
 * Smoothly fade volume - HYBRID approach
 * Uses native Web Audio API for smooth audio, low-rate updates for UI feedback
 */
function fadeVolume(startVolume, endVolume, durationMs) {
  if (currentFade) {
    cancelAnimationFrame(currentFade.animationId);
    currentFade = null;
  }

  return new Promise((resolve) => {
    const startTime = performance.now();
    const uiUpdateInterval = 1000 / getSetting("volumeDuckingFps"); // Dynamic FPS setting
    let lastUIUpdate = 0;

    // Apply hardware-accelerated fade to all currently playing sounds
    applyNativeFadesToPlayingSounds(startVolume, endVolume, durationMs);

    // Animate UI slider at low framerate for visual feedback only
    function animateUI(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / durationMs, 1.0);

      if (currentTime - lastUIUpdate >= uiUpdateInterval || progress === 1.0) {
        lastUIUpdate = currentTime;

        // Use same easing curve for UI to match audio perception
        let easedProgress;
        if (endVolume < startVolume) {
          easedProgress = progress === 1 ? 1 : 1 - Math.pow(2, -6 * progress);
        } else {
          easedProgress = Math.pow(progress, 2);
        }

        const currentVolume =
          startVolume + (endVolume - startVolume) * easedProgress;
        game.settings.set("core", "globalPlaylistVolume", currentVolume);
      }

      if (progress < 1.0) {
        currentFade = { animationId: requestAnimationFrame(animateUI) };
      } else {
        currentFade = null;
        const debugEnabled = getSetting("debugLogging");
        if (debugEnabled) {
          console.log(
            `${MODULE_ID} | ✅ Fade complete (final: ${endVolume.toFixed(4)})`
          );
        }
        resolve();
      }
    }

    currentFade = { animationId: requestAnimationFrame(animateUI) };
  });
}

/**
 * Apply native Web Audio fades to all currently playing sounds
 * This runs on the audio thread for buttery-smooth fading
 */
function applyNativeFadesToPlayingSounds(startVolume, endVolume, durationMs) {
  // Calculate the ratio of change based on start/end volumes
  const volumeRatio = startVolume > 0 ? endVolume / startVolume : 1;

  for (const sound of game.audio.playing.values()) {
    if (!sound.gain) continue;

    try {
      // Calculate this sound's target volume based on ratio
      const currentSoundVolume = sound.gain.value;
      const targetSoundVolume = currentSoundVolume * volumeRatio;

      // Use Foundry's native fade - hardware accelerated!
      // Exponential fades sound more natural to human hearing
      // Note: exponential can't reach exactly 0, so use small minimum
      const safeTargetVolume = Math.max(targetSoundVolume, 0.0001);
      sound.fade(safeTargetVolume, {
        duration: durationMs,
        from: Math.max(currentSoundVolume, 0.0001),
        type: "exponential",
      });
    } catch (err) {
      // Sound might have stopped, ignore
    }
  }

  const debugEnabled = getSetting("debugLogging");
  if (debugEnabled) {
    console.log(
      `${MODULE_ID} | 🎵 Applied native fades to ${game.audio.playing.size} playing sound(s)`
    );
  }
}

// ============================================================================
// VOLUME CONTROL
// ============================================================================
async function duckVolume() {
  const debugEnabled = getSetting("debugLogging");
  // Check if user manually changed volume before we duck
  checkForManualVolumeChange();

  if (isDucked) {
    console.log(`${MODULE_ID} | ⏭️  Already ducked, skipping`);
    return;
  }

  // Get current volume (in case it changed since we stored it)
  const currentVolume = game.settings.get("core", "globalPlaylistVolume");

  // Store original volume if we haven't already
  if (originalVolume === null) {
    originalVolume = currentVolume;
    console.log(`${MODULE_ID} | 💾 Stored original volume: ${originalVolume}`);
  }

  const reductionPercent = getSetting("duckReductionPercent");
  const duckDuration = getSetting("duckDurationMs");
  const targetVolume = originalVolume * (1 - reductionPercent / 100);
  if (debugEnabled) {
    console.log(
      `${MODULE_ID} | 🎚️ Ducking from ${currentVolume.toFixed(
        4
      )} to ${targetVolume.toFixed(4)} over ${duckDuration}ms`
    );
  }

  isDucked = true;

  // Smooth fade to ducked volume
  await fadeVolume(currentVolume, targetVolume, duckDuration);
}

async function unduckVolume() {
  const debugEnabled = getSetting("debugLogging");
  // Check if user manually changed volume while ducked
  checkForManualVolumeChange();

  if (!isDucked) {
    console.log(`${MODULE_ID} | ⭕ Not ducked, skipping`);
    return;
  }

  const currentVolume = game.settings.get("core", "globalPlaylistVolume");
  const unduckDelay = getSetting("unduckDelayMs");
  const unduckDuration = getSetting("unduckDurationMs");

  // Set state BEFORE fade so incoming duck commands can interrupt
  isDucked = false;

  // Wait for delay before starting fade (if configured)
  if (unduckDelay > 0) {
    const debugEnabled = getSetting("debugLogging");
    if (debugEnabled) {
      console.log(
        `${MODULE_ID} | ⏳ Waiting ${unduckDelay}ms before unducking...`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, unduckDelay));

    // Check if we got re-ducked during the delay
    if (isDucked) {
      const debugEnabled = getSetting("debugLogging");
      if (debugEnabled) {
        console.log(
          `${MODULE_ID} | ⏸️ Re-ducked during delay, aborting unduck`
        );
      }
      return;
    }
  }
  if (debugEnabled) {
    console.log(
      `${MODULE_ID} | 🎚️ Unducking from ${currentVolume.toFixed(
        4
      )} to ${originalVolume.toFixed(4)} over ${unduckDuration}ms`
    );
  }

  // Smooth fade back to original volume
  await fadeVolume(currentVolume, originalVolume, unduckDuration);
}

// ============================================================================
// CLEANUP
// ============================================================================
window.addEventListener("beforeunload", () => {
  if (websocket) {
    console.log(`${MODULE_ID} | 🔌 Closing WebSocket connection...`);
    websocket.close();
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (currentFade) {
    cancelAnimationFrame(currentFade.animationId);
  }
});

console.log(`${MODULE_ID} | ✅ Module script loaded`);
