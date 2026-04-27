// ============================================================
//  Ocean Sand Installation — sketch.js
// ============================================================

const appState = {
  scene: "violent",
  peopleCount: 0,
  armSegments: [],
  wristPositions: [null, null, null],
  wristTrails: {},
  partyTriggered: false,
};

const MAX_PEOPLE = 2;
const INITIAL_PARTICLES = 10000;
const MAX_PARTICLES = 20000;
const TRAIL_MAX_PTS = 20;

const MOON_FALL_MS = 30000;
const MOON_HIDE_MS = 30000;
const MOON_CYCLE_MS = MOON_FALL_MS + MOON_HIDE_MS;
const MOON_RADIUS = 20;
const MOON_TOUCH_PX = MOON_RADIUS + 30;

const PERSON_RGBA = [
  [216, 90, 48],
  [29, 158, 117],
  [216, 90, 48],
];

// Day bg: #1c6b73
const DAY_BG = [28, 107, 115];
// Night bg: deep dark ocean
const NIGHT_BG = [6, 10, 35];

// Sand colours per time state
// Each is [r, g, b] centre values — particle gets small random offset at spawn
const SAND_DAY = [220, 195, 150]; // warm beige
const SAND_NIGHT = [150, 215, 255]; // cool blue-white

const BG_PALETTES = [
  [180, 20, 60],
  [20, 60, 180],
  [20, 140, 80],
  [120, 20, 160],
  [180, 100, 10],
  [10, 130, 160],
  [160, 40, 120],
  [60, 20, 160],
];

const FADE_SPEED = 0.025;
let sceneGains = [0, 0, 1];
let targetGains = [0, 0, 1];
let midiOutput = null;

const SMOOTHING = 0.25; // 0 = frozen, 1 = raw (try 0.2–0.35)
let smoothedWrists = [{}, {}, {}];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function setStatus(msg, dotColor) {
  const dot = document.getElementById("status-dot");
  const txt = document.getElementById("status-text");
  if (dot) dot.style.background = dotColor;
  if (txt) txt.textContent = msg;
}
function setSceneLabel(text) {
  const lbl = document.getElementById("scene-label");
  if (lbl) lbl.textContent = text;
}

function setScene(scene) {
  if (appState.scene === scene) return;
  appState.scene = scene;
  switch (scene) {
    case "violent":
      targetGains = [0, 0, 1];
      setStatus("Violent ocean — waiting…", "#E24B4A");
      setSceneLabel("Scene 3 — Violent");
      break;
    case "calm":
      targetGains = [1, 0, 0];
      setStatus("Calm ocean — performers active", "#1D9E75");
      setSceneLabel("Scene 1 — Calm");
      break;
    case "party":
      targetGains = [0, 1, 0];

      overlayColor = [
        ...BG_PALETTES[Math.floor(Math.random() * BG_PALETTES.length)],
        120, // alpha (IMPORTANT)
      ];

      setStatus("PARTY MODE — moon touched!", "#EF9F27");
      setSceneLabel("Scene 2 — Party 🌙");
      break;
  }
}

async function initMIDI() {
  if (typeof WebMidi === "undefined") {
    console.warn("WebMidi.js not loaded — MIDI disabled.");
    return;
  }
  try {
    await WebMidi.enable();
    if (WebMidi.outputs.length === 0) {
      console.warn("No MIDI outputs. Is IAC Driver enabled?");
      return;
    }
    midiOutput = WebMidi.outputs[0];
    console.log("MIDI output connected:", midiOutput.name);
  } catch (err) {
    console.warn("WebMidi enable failed:", err);
  }
}

function updateMIDI() {
  if (!midiOutput) return;
  for (let i = 0; i < 3; i++) {
    sceneGains[i] = lerp(sceneGains[i], targetGains[i], FADE_SPEED);
    midiOutput.channels[1].sendControlChange(
      i + 1,
      Math.round(sceneGains[i] * 127)
    );
  }
}

function landmarkToScreen(lm, idx, sliceX0, sliceX1, vw, vh, sw, sh) {
  const pt = lm[idx];
  if (!pt || pt.visibility < 0.3) return null;
  const sliceW = sliceX1 - sliceX0;
  const fullFx = (sliceX0 + pt.x * sliceW) / vw;
  return { x: (1 - fullFx) * sw, y: pt.y * sh };
}

function extractForearmSegments(lm, sliceX0, sliceX1, vw, vh, sw, sh) {
  const segments = [];
  if (!lm) return segments;
  const get = (i) => landmarkToScreen(lm, i, sliceX0, sliceX1, vw, vh, sw, sh);
  for (const [eI, wI, fI] of [
    [13, 15, 19],
    [14, 16, 20],
  ]) {
    const e = get(eI),
      w = get(wI),
      f = get(fI);
    if (e && w) segments.push({ a: e, b: w });
    if (w && f) segments.push({ a: w, b: f });
  }
  return segments;
}

function extractWristPositions(lm, sliceX0, sliceX1, vw, vh, sw, sh) {
  if (!lm) return null;
  const get = (i) => landmarkToScreen(lm, i, sliceX0, sliceX1, vw, vh, sw, sh);
  const lw = get(15),
    rw = get(16);
  return lw || rw ? { lw, rw } : null;
}

function smoothPoint(prev, next) {
  if (!prev) return next;
  return {
    x: lerp(prev.x, next.x, SMOOTHING),
    y: lerp(prev.y, next.y, SMOOTHING),
  };
}

function isJump(prev, next, maxDist = 120) {
  if (!prev || !next) return false;
  const d = Math.hypot(next.x - prev.x, next.y - prev.y);
  return d > maxDist;
}

async function initMediaPipe() {
  const video = document.getElementById("webcam-video");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    setStatus("Camera error: " + err.message, "#E24B4A");
    return;
  }

  const { PoseLandmarker, FilesetResolver } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
  );

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    },
    runningMode: "VIDEO",
    numPoses: 2,              // 👈 THIS is the magic (multi-person)
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  setStatus("Active — multi-person tracking", "#1D9E75");
  setSceneLabel("Scene 3 — Violent");

  let lastVideoTime = -1;

  const loop = async () => {
    if (video.readyState >= 2) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;

        const result = landmarker.detectForVideo(video, now);

        // Reset
        const allSegments = [];
        const wristArray = [];

        const poses = result.landmarks || [];

        appState.peopleCount = poses.length;

        for (let i = 0; i < MAX_PEOPLE; i++) {
          const lm = poses[i];

          if (!lm) {
            appState.wristPositions[i] = null;
            continue;
          }

          // --- reuse your existing helpers (UNCHANGED) ---
          const segs = extractForearmSegments(
            lm,
            0,
            video.videoWidth,
            video.videoWidth,
            video.videoHeight,
            window.innerWidth,
            window.innerHeight
          );

          for (const s of segs) {
            allSegments.push({ ...s, personIdx: i });
          }

          const wrists = extractWristPositions(
            lm,
            0,
            video.videoWidth,
            video.videoWidth,
            video.videoHeight,
            window.innerWidth,
            window.innerHeight
          );

          if (wrists) {
            const prev = smoothedWrists[i] || {};

            const lw = wrists.lw;
            const rw = wrists.rw;

            smoothedWrists[i] = {
              lw: lw ? smoothPoint(prev.lw, lw) : null,
              rw: rw ? smoothPoint(prev.rw, rw) : null,
            };

            appState.wristPositions[i] = smoothedWrists[i];
          } else {
            appState.wristPositions[i] = null;
          }

          // --- PARTY TRAILS (unchanged logic) ---
          const smooth = appState.wristPositions[i];

          if (appState.scene === "party" && smooth) {
            for (const [key, pt] of [
              ["lw", smooth.lw],
              ["rw", smooth.rw],
            ]) {
              if (!pt) continue;

              const k = `${i}-${key}`;

              if (!appState.wristTrails[k]) {
                appState.wristTrails[k] = { points: [], personIdx: i };
              }

              const trail = appState.wristTrails[k];
              const last = trail.points[trail.points.length - 1];

              const smoothPt = last
                ? {
                    x: lerp(last.x, pt.x, 0.35),
                    y: lerp(last.y, pt.y, 0.35),
                  }
                : pt;

              trail.points.push(smoothPt);

              if (trail.points.length > TRAIL_MAX_PTS) {
                trail.points.shift();
              }
            }
          }
        }

        appState.armSegments = allSegments;

        // Scene switching logic (same as yours)
        if (poses.length === 0 && appState.scene !== "party") {
          setScene("violent");
        } else if (poses.length > 0 && appState.scene === "violent") {
          setScene("calm");
        }
      }
    }

    requestAnimationFrame(loop);
  };

  loop();
}

// ─────────────────────────────────────────────────────────────
//  P5.JS SKETCH
// ─────────────────────────────────────────────────────────────
new p5((p) => {
  let particles = [];
  let ringRadius;
  let bgColor = [...NIGHT_BG];
  let isNightTime = true;
  let uiVisible = true;

  let overlayColor = [0, 0, 0, 0];
  let targetOverlay = [0, 0, 0, 0];

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    ringRadius = p.min(p.width, p.height) * 0.35;
    isNightTime = true;
    for (let i = 0; i < INITIAL_PARTICLES; i++) spawnRingParticle();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    ringRadius = p.min(p.width, p.height) * 0.35;
  };

  p.keyPressed = () => {
    if (p.key === "h" || p.key === "H") {
      uiVisible = !uiVisible;
      const display = uiVisible ? "flex" : "none";
      const overlay = document.getElementById("ui-overlay");
      const cards = document.getElementById("person-cards");
      if (overlay) overlay.style.display = display;
      if (cards) cards.style.display = display;
    }
  };

  // Returns a sand colour [r,g,b] appropriate for the current time of day,
  // with small per-particle random variation so the island has texture.
  function makeSandColor() {
    const base = isNightTime ? SAND_NIGHT : SAND_DAY;
    return [
      base[0] + Math.random() * 30 - 15,
      base[1] + Math.random() * 30 - 15,
      base[2] + Math.random() * 30 - 15,
    ];
  }

  // ── Spawn one particle ON the thick ring ───────────────────
  // The random radial offset (±60) is what gives the ring its
  // visible width. Both spawnRingParticle and spawnArmParticle
  // must use the same spread so all particles share the same
  // thick home band rather than converging to a thin circle.
  function spawnRingParticle() {
    const a = p.random(p.TWO_PI);
    const spread = p.random(-60, 60); // ← thickness of ring
    const r = ringRadius + spread;
    const cx = p.width / 2,
      cy = p.height / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    const part = new Particle(x, y, true, null);
    // Home is THIS particle's own spawn point — sits inside the thick band
    part.home = p.createVector(x, y);
    particles.push(part);
  }

  // ── Spawn a particle near a forearm, homed into the thick ring ─
  function spawnArmParticle(x, y, col) {
    const cx = p.width / 2,
      cy = p.height / 2;
    const angle = Math.atan2(y - cy, x - cx);
    // Give the home the same ±60 spread as ring particles so it
    // targets a point inside the thick band, not the thin edge.
    const spread = p.random(-60, 60);
    const part = new Particle(
      x + p.random(-15, 15),
      y + p.random(-15, 15),
      false,
      col
    );
    part.home = p.createVector(
      cx + Math.cos(angle) * (ringRadius + spread),
      cy + Math.sin(angle) * (ringRadius + spread)
    );
    particles.push(part);
  }

  // ── Main draw loop ──────────────────────────────────────────
  p.draw = () => {
    // ── Moon clock ─────────────────────────────────────────────
    const t = p.millis() % MOON_CYCLE_MS;
    const moonVisible = t < MOON_FALL_MS;
    const moonX = p.width / 2;
    const moonY = moonVisible
      ? p.lerp(-MOON_RADIUS * 2, p.height + MOON_RADIUS * 2, t / MOON_FALL_MS)
      : -9999;

    // Update time-of-day flag — drives sand colour targets
    isNightTime = moonVisible;

    // ── Moon-exit ───────────────────────────────────────────────
    if (!moonVisible) {
      appState.partyTriggered = false;
      if (appState.scene === "party") {
        setScene(appState.peopleCount > 0 ? "calm" : "violent");
      }
    }

    // ── Moon collision ──────────────────────────────────────────
    if (moonVisible && !appState.partyTriggered) {
      outer: for (const wrists of appState.wristPositions) {
        if (!wrists) continue;
        for (const pt of [wrists.lw, wrists.rw]) {
          if (!pt) continue;
          const d = Math.sqrt((pt.x - moonX) ** 2 + (pt.y - moonY) ** 2);
          if (d < MOON_TOUCH_PX) {
            appState.partyTriggered = true;
            setScene("party");
            break outer;
          }
        }
      }
    }

    // ── Background base (ocean) ─────────────────────────
    const targetBg = isNightTime ? NIGHT_BG : DAY_BG;
    for (let i = 0; i < 3; i++) {
      bgColor[i] = lerp(bgColor[i], targetBg[i], 0.018);
    }
    p.background(bgColor[0], bgColor[1], bgColor[2]);

    // ── FLASHING PARTY OVERLAY ─────────────────
    if (appState.scene === "party") {
      // change colour every ~6 frames (~10x per sec)
      if (p.frameCount % 6 === 0) {
        const pal = BG_PALETTES[Math.floor(p.random(BG_PALETTES.length))];
        overlayColor = [pal[0], pal[1], pal[2], 120];
      }

      p.noStroke();
      p.fill(
        overlayColor[0],
        overlayColor[1],
        overlayColor[2],
        overlayColor[3]
      );
      p.rect(0, 0, p.width, p.height);
    }

    // ── Moon ────────────────────────────────────────────────────
    if (moonVisible) {
      p.noStroke();
      p.fill(255, 255, 255, 80);
      p.circle(moonX, moonY, MOON_RADIUS * 2 + 24);
      p.fill(255, 255, 255, 255);
      p.circle(moonX, moonY, MOON_RADIUS * 2);
    }

    // ── Wrist trails — party only ───────────────────────────────
    if (appState.scene === "party") {
      for (const key of Object.keys(appState.wristTrails)) {
        const { points, personIdx } = appState.wristTrails[key];
        if (points.length < 2) continue;
        const [r, g, b] = PERSON_RGBA[personIdx] || [255, 255, 255];
        drawWristTrail(points, r, g, b);
      }
    }

    // ── Spawn arm particles — calm only, forearms only ──────────
    if (appState.scene === "calm" && appState.armSegments.length > 0) {
      for (const s of appState.armSegments) {
        if (particles.length >= MAX_PARTICLES) break;
        const col = PERSON_RGBA[s.personIdx] || null;
        for (let i = 0; i < 2; i++) {
          const t = p.random(1);
          spawnArmParticle(
            p.lerp(s.a.x, s.b.x, t),
            p.lerp(s.a.y, s.b.y, t),
            col
          );
        }
      }
    }

    // ── MIDI ────────────────────────────────────────────────────
    updateMIDI();

    // ── Particles ───────────────────────────────────────────────
    for (let i = particles.length - 1; i >= 0; i--) {
      particles[i].update();
      particles[i].display();
      if (particles[i].isDead()) particles.splice(i, 1);
    }
  };

  // ── Wrist trail — with infinite-loop guard ──────────────────
  function drawWristTrail(trail, r, g, b) {
    const spacing = 18;
    const barWidth = 3;
    const beatPhase = ((p.millis() / 1000) % (60 / 90)) / (60 / 90);
    let distAccum = 0;
    p.noStroke();

    for (let i = 1; i < trail.length; i++) {
      const prev = trail[i - 1],
        curr = trail[i];
      const dx = curr.x - prev.x,
        dy = curr.y - prev.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen === 0) continue;
      // Skip tracking-glitch jumps
      if (segLen > 300) {
        distAccum = 0;
        continue;
      }

      distAccum += segLen;
      let iterGuard = 0;
      while (distAccum >= spacing && iterGuard < 50) {
        iterGuard++;
        distAccum -= spacing;
        const t = 1 - distAccum / segLen;
        const x = p.lerp(prev.x, curr.x, t);
        const y = p.lerp(prev.y, curr.y, t);
        const alpha = p.map(i / trail.length, 0, 1, 40, 220);
        const wave = Math.pow(Math.sin(p.TWO_PI * beatPhase + i * 0.2), 3);
        const h = p.map(wave, -1, 1, 10, 350);
        p.fill(r, g, b, alpha);
        p.rectMode(p.CENTER);
        p.rect(x, y, barWidth, h);
      }
    }
    p.rectMode(p.CORNER);
  }

  // ── Shortest distance from point to segment ─────────────────
  function distToSegment(pX, pY, a, b) {
    const l2 = p.dist(a.x, a.y, b.x, b.y) ** 2;
    if (l2 === 0) return p.dist(pX, pY, a.x, a.y);
    let t = ((pX - a.x) * (b.x - a.x) + (pY - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return p.dist(pX, pY, a.x + t * (b.x - a.x), a.y + t * (b.y - a.y));
  }

  // ─────────────────────────────────────────────────────────────
  //  PARTICLE CLASS
  // ─────────────────────────────────────────────────────────────
  class Particle {
    constructor(x, y, hasHome, col) {
      this.pos = p.createVector(x, y);
      this.home = hasHome ? p.createVector(x, y) : null;
      this.vel = p.createVector(p.random(-0.1, 0.1), p.random(-0.1, 0.1));
      this.life = 255;
      this.decay = p.random(0.4, 0.9);
      this.size = p.random(1.2, 3.2);

      // isSand: true for default particles — these shift colour with day/night.
      // false for person-coloured particles — colour stays fixed.
      this.isSand = col === null;

      if (this.isSand) {
        // col is null — use time-appropriate sand colour at spawn
        this.col = makeSandColor();
        // targetCol drives the day/night lerp each frame
        this.targetCol = [...this.col];
      } else {
        this.col = [...col];
        this.targetCol = null;
      }
    }

    update() {
      // ── Colour lerp for sand particles ─────────────────────────
      // Each frame, update the target to match the current time of
      // day and slowly lerp the displayed colour toward it.
      // Rate 0.008 gives a gradual ~4 s shift at 60 fps so the
      // colour change is noticeable but never jarring.
      if (this.isSand && this.targetCol) {
        const base = isNightTime ? SAND_NIGHT : SAND_DAY;
        // Nudge target toward the base — keeps per-particle variation
        // while still following the global day/night shift
        for (let i = 0; i < 3; i++) {
          this.targetCol[i] = lerp(this.targetCol[i], base[i], 0.008);
          this.col[i] = lerp(this.col[i], this.targetCol[i], 0.02);
        }
      }

      // ── Home pull — viscous, slow ───────────────────────────────
      // Force 0.003: gentle enough that particles feel like they are
      // being slowly dragged through wet sand rather than snapping back.
      // Disabled in party mode so the island scatters freely.
      if (this.home && appState.scene !== "party") {
        const homeForce = p5.Vector.sub(this.home, this.pos).mult(0.003);
        this.vel.add(homeForce);
      }

      // ── Arm repulsion — calm only ───────────────────────────────
      if (appState.scene === "calm") {
        for (const s of appState.armSegments) {
          const d = distToSegment(this.pos.x, this.pos.y, s.a, s.b);
          if (d < 75) {
            const strength = 1.8 * (1 - d / 75);
            const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
            const push = p5.Vector.sub(this.pos, p.createVector(mid.x, mid.y))
              .normalize()
              .mult(strength);
            this.vel.add(push);
          }
        }
      }

      this.vel.mult(0.94);
      this.pos.add(this.vel);
      this.life -= this.decay;
    }

    isDead() {
      return this.life <= 0;
    }

    display() {
      p.noStroke();
      p.fill(this.col[0], this.col[1], this.col[2], this.life);
      p.circle(this.pos.x, this.pos.y, this.size);
    }
  }
}); // end p5 sketch

// ─────────────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────────────
(async () => {
  await initMIDI();
  await initMediaPipe();
})();