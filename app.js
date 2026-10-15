  /* ==========================================================================
     PHOTOTOUR — INTERACTIVE PHOTOGRAPHY LEARNING SIMULATOR
     Full-Fidelity Optical Physics & Rendering Engine
     ========================================================================== */

  // Global State
  const state = {
    currentSection: 'home',
    simulator: {
      sceneIndex: 0,
      iso: 400,
      shutterIndex: 7, // 1/125s
      aperture: 4.0,
      whiteBalancePreset: 'daylight',
      kelvin: 5500,
      focusDistance: 2.5, // meters
      focalLength: 50, // mm
      showGrid: false,
      showClipping: false,
      compareMode: false,
      renderDebounceTimer: null
    },
    composition3D: {
      height: 1.5,
      distance: 3.0,
      angleDeg: 0,
      tiltDeg: 0,
      focalLength: 50,
      activeGuide: 'thirds',
      activeTechniqueIndex: 0,
      studioLight: true
    },
    challenges: {
      activeId: 0,
      completedCount: 0,
      totalStars: 0,
      scores: {} // id -> { stars: 0-3, scorePct: 0-100 }
    },
    lensExplorer: {
      lensA: 24,
      lensB: 135,
      testScene: 'portrait_distant'
    },
    progress: {
      xp: 240,
      photosTaken: 0,
      totalTimeSeconds: 0,
      conceptsMastered: ['iso', 'aperture', 'shutter'],
      unlockedBadges: []
    }
  };

  // Optical Constants
  const SHUTTER_SPEEDS = ['1/4000', '1/2000', '1/1000', '1/500', '1/250', '1/125', '1/60', '1/30', '1/15', '1/8', '1/4', '1/2', '1"', '2"', '4"', '8"', '15"', '30"'];
  const SHUTTER_VALUES = [1/4000, 1/2000, 1/1000, 1/500, 1/250, 1/125, 1/60, 1/30, 1/15, 1/8, 1/4, 0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0];
  const APERTURE_VALUES = [1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0, 22.0];
  const ISO_VALUES = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
  const FOCAL_LENGTHS = [14, 24, 35, 50, 85, 135, 200, 300];

  /* --------------------------------------------------------------------------
     AUDIO SYNTHESIZER: Realistic Mechanical Shutter Sound
     -------------------------------------------------------------------------- */
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playShutterSound(isSlowShutter = false) {
    try {
      initAudio();
      if (!audioCtx) return;

      const now = audioCtx.currentTime;
      
      // Step 1: Front curtain click / Mirror slap
      const bufferSize = audioCtx.sampleRate * 0.04;
      const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
      }

      const whiteNoise = audioCtx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 3;

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.7, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(audioCtx.destination);
      whiteNoise.start(now);

      // Step 2: Mechanical spring click tone
      const osc = audioCtx.createOscillator();
      const oscGain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.05);
      oscGain.gain.setValueAtTime(0.4, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      osc.connect(oscGain);
      oscGain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.05);

      // Step 3: Rear curtain click
      const rearDelay = isSlowShutter ? 0.25 : 0.07;
      const rearNoise = audioCtx.createBufferSource();
      rearNoise.buffer = noiseBuffer;
      const rearGain = audioCtx.createGain();
      rearGain.gain.setValueAtTime(0.5, now + rearDelay);
      rearGain.gain.exponentialRampToValueAtTime(0.001, now + rearDelay + 0.03);

      rearNoise.connect(filter);
      filter.connect(rearGain);
      rearGain.connect(audioCtx.destination);
      rearNoise.start(now + rearDelay);
    } catch (e) {
      console.warn('Audio synthesis not supported or blocked:', e);
    }
  }

  function playShutterAnimation() {
    playShutterSound(false);
    const wrapper = document.getElementById('heroShutterSvg');
    if (wrapper) {
      wrapper.style.transform = 'scale(0.96)';
      setTimeout(() => wrapper.style.transform = 'scale(1)', 150);
    }
  }

  /* --------------------------------------------------------------------------
     EXPOSURE CALCULATION SYSTEM
     -------------------------------------------------------------------------- */
  function calculateCameraEV(iso, aperture, shutterSeconds) {
    // Standard EV100 = log2(N^2 / t)
    // Adjusted for ISO: EV = log2(N^2 / t) - log2(iso / 100)
    const N = aperture;
    const t = shutterSeconds;
    const ev100 = Math.log2((N * N) / t);
    const isoShift = Math.log2(iso / 100);
    return ev100 - isoShift;
  }

  function calculateExposureDelta(sceneBaseEv, iso, aperture, shutterSeconds) {
    const settingsEv = calculateCameraEV(iso, aperture, shutterSeconds);
    // delta > 0 means camera gathers more light than needed (overexposed)
    // delta < 0 means camera gathers less light than needed (underexposed)
    return sceneBaseEv - settingsEv;
  }

  function calculateDepthOfField(aperture, focusDistance, focalLengthMm) {
    // Circle of confusion for full frame ~ 0.030mm
    const c = 0.029; 
    const f = focalLengthMm;
    const s = focusDistance * 1000; // convert to mm
    const N = aperture;

    // Hyperfocal distance H = f^2 / (N * c)
    const H = (f * f) / (N * c);

    // Near limit = (H * s) / (H + (s - f))
    let nearLimit = (H * s) / (H + (s - f));
    // Far limit = (H * s) / (H - (s - f))
    let farLimit = (H * s) / (H - (s - f));

    if (farLimit < 0 || farLimit > 50000) farLimit = 50000; // infinity
    nearLimit = Math.max(200, nearLimit);

    return {
      nearMeters: (nearLimit / 1000).toFixed(1),
      farMeters: farLimit >= 45000 ? 'Infinity' : (farLimit / 1000).toFixed(1),
      hyperfocalMeters: (H / 1000).toFixed(1)
    };
  }

  /* --------------------------------------------------------------------------
     COLOR TEMPERATURE (KELVIN TO RGB ALGORITHM)
     Based on Tanner Helland Planckian locus approximation
     -------------------------------------------------------------------------- */
  function kelvinToRgb(kelvin) {
    const temp = kelvin / 100;
    let red, green, blue;

    if (temp <= 66) {
      red = 255;
      green = 99.4708025861 * Math.log(temp) - 161.1195681661;
      if (temp <= 19) {
        blue = 0;
      } else {
        blue = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
      }
    } else {
      red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
      green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
      blue = 255;
    }

    return {
      r: Math.max(0, Math.min(255, red)) / 255,
      g: Math.max(0, Math.min(255, green)) / 255,
      b: Math.max(0, Math.min(255, blue)) / 255
    };
  }

  /* --------------------------------------------------------------------------
     12 PROCEDURAL CANVASES SCENE LIBRARY
     Each scene has 3 depth layers (BG, Midground, Foreground/Subject)
     -------------------------------------------------------------------------- */
  const SCENES = [
    {
      id: 'portrait_daylight',
      name: 'Portrait Daylight',
      baseEV: 13.0,
      baseWB: 5500,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 2.0,
      description: 'Golden afternoon portrait in garden with sunlit bokeh circles.',
      layers: {
        background: {
          depth: 25.0,
          render(ctx, w, h) {
            // Sunny garden background with warm radial gradient & layered bokeh
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, '#598544');
            grad.addColorStop(0.4, '#c9a84d');
            grad.addColorStop(1, '#3b5c2a');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            // Sunbeam flares
            const sunGrad = ctx.createRadialGradient(w * 0.8, h * 0.1, 10, w * 0.8, h * 0.1, w * 0.7);
            sunGrad.addColorStop(0, 'rgba(255, 245, 200, 0.7)');
            sunGrad.addColorStop(0.5, 'rgba(255, 220, 140, 0.25)');
            sunGrad.addColorStop(1, 'rgba(255, 200, 100, 0)');
            ctx.fillStyle = sunGrad;
            ctx.fillRect(0, 0, w, h);

            // Layered bokeh circles
            const bokehPoints = [
              {x: 80, y: 70, r: 42, a: 0.35, c: '#ffeaa7'},
              {x: 140, y: 130, r: 65, a: 0.28, c: '#fdcb6e'},
              {x: 230, y: 60, r: 50, a: 0.32, c: '#55efc4'},
              {x: 480, y: 90, r: 75, a: 0.40, c: '#ffeaa7'},
              {x: 520, y: 180, r: 55, a: 0.25, c: '#fab1a0'},
              {x: 380, y: 220, r: 48, a: 0.20, c: '#dfe6e9'},
              {x: 560, y: 70, r: 60, a: 0.45, c: '#fff'},
              {x: 70, y: 260, r: 55, a: 0.22, c: '#81ecec'},
              {x: 440, y: 290, r: 65, a: 0.26, c: '#ffeaa7'},
              {x: 190, y: 280, r: 35, a: 0.18, c: '#fab1a0'}
            ];
            bokehPoints.forEach(b => {
              ctx.beginPath();
              ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
              ctx.fillStyle = b.c;
              ctx.globalAlpha = b.a;
              ctx.fill();
              ctx.lineWidth = 2;
              ctx.strokeStyle = 'rgba(255,255,255,0.3)';
              ctx.stroke();
            });
            ctx.globalAlpha = 1.0;
          }
        },
        midground: {
          depth: 5.0,
          render(ctx, w, h) {
            // Gentle garden flora
            ctx.fillStyle = '#2d5a27';
            ctx.beginPath();
            ctx.arc(w * 0.1, h * 0.85, 90, 0, Math.PI * 2);
            ctx.arc(w * 0.92, h * 0.8, 110, 0, Math.PI * 2);
            ctx.fill();
          }
        },
        foreground: {
          depth: 2.0, // Primary subject!
          render(ctx, w, h) {
            // Elegant portrait silhouette with warm rim light
            const cx = w * 0.52;
            const cy = h * 0.48;

            // Hair & Head
            ctx.fillStyle = '#1c140d';
            ctx.beginPath();
            ctx.arc(cx, cy - 35, 62, 0, Math.PI * 2);
            ctx.fill();

            // Face & Jaw profile
            ctx.fillStyle = '#d99879';
            ctx.beginPath();
            ctx.ellipse(cx - 8, cy - 30, 40, 52, 0.05, 0, Math.PI * 2);
            ctx.fill();

            // Eye & Eyebrow
            ctx.fillStyle = '#422115';
            ctx.beginPath();
            ctx.ellipse(cx - 24, cy - 36, 6, 3, -0.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(cx - 32, cy - 45, 18, 3);

            // Nose & Lips
            ctx.fillStyle = '#c57c5f';
            ctx.beginPath();
            ctx.moveTo(cx - 42, cy - 32);
            ctx.lineTo(cx - 49, cy - 20);
            ctx.lineTo(cx - 38, cy - 18);
            ctx.fill();
            ctx.fillStyle = '#ab4d48';
            ctx.beginPath();
            ctx.ellipse(cx - 36, cy - 8, 8, 4, 0, 0, Math.PI * 2);
            ctx.fill();

            // Hair curls framing
            ctx.fillStyle = '#1c140d';
            ctx.beginPath();
            ctx.arc(cx + 12, cy - 50, 48, 0, Math.PI * 2);
            ctx.arc(cx + 25, cy - 10, 52, 0, Math.PI * 2);
            ctx.arc(cx - 20, cy - 65, 36, 0, Math.PI * 2);
            ctx.fill();

            // Neck & Shoulders
            ctx.fillStyle = '#cf896c';
            ctx.beginPath();
            ctx.moveTo(cx - 22, cy + 18);
            ctx.lineTo(cx + 8, cy + 18);
            ctx.lineTo(cx + 15, cy + 80);
            ctx.lineTo(cx - 28, cy + 80);
            ctx.closePath();
            ctx.fill();

            // Linen Shirt / Dress
            ctx.fillStyle = '#f5f0eb';
            ctx.beginPath();
            ctx.moveTo(cx - 120, h);
            ctx.quadraticCurveTo(cx - 70, cy + 65, cx - 28, cy + 80);
            ctx.lineTo(cx + 15, cy + 80);
            ctx.quadraticCurveTo(cx + 85, cy + 68, cx + 130, h);
            ctx.closePath();
            ctx.fill();

            // Warm rim lighting highlight along edge
            ctx.strokeStyle = 'rgba(255, 230, 160, 0.75)';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(cx + 10, cy - 35, 63, -0.8, 1.4);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'portrait_distant',
      name: 'Portrait Distant Overlook',
      baseEV: 12.0,
      baseWB: 5600,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 1.8,
      description: 'Scenic viewpoint with distant mountain ridges and a close traveler.',
      layers: {
        background: {
          depth: 80.0,
          render(ctx, w, h) {
            // Sky gradient
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
            sky.addColorStop(0, '#4b6cb7');
            sky.addColorStop(0.7, '#8aa9d6');
            sky.addColorStop(1, '#ffdfba');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Layer 1: Distant mountains
            ctx.fillStyle = '#7a8fb8';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.45);
            ctx.lineTo(w * 0.2, h * 0.32);
            ctx.lineTo(w * 0.45, h * 0.42);
            ctx.lineTo(w * 0.7, h * 0.28);
            ctx.lineTo(w, h * 0.40);
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.fill();

            // Layer 2: Mid-distance hills
            ctx.fillStyle = '#50688a';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.52);
            ctx.lineTo(w * 0.3, h * 0.42);
            ctx.lineTo(w * 0.6, h * 0.50);
            ctx.lineTo(w * 0.85, h * 0.38);
            ctx.lineTo(w, h * 0.48);
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.fill();
          }
        },
        midground: {
          depth: 12.0,
          render(ctx, w, h) {
            // Valley lake & shoreline
            ctx.fillStyle = '#395370';
            ctx.fillRect(0, h * 0.58, w, h * 0.15);
            // Overlook terrace floor
            ctx.fillStyle = '#3a3a46';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.72);
            ctx.lineTo(w, h * 0.68);
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.fill();
            // Railing
            ctx.strokeStyle = '#5a5a6a';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(0, h * 0.7);
            ctx.lineTo(w, h * 0.66);
            ctx.stroke();
          }
        },
        foreground: {
          depth: 1.8,
          render(ctx, w, h) {
            // Portrait subject standing near right third
            const cx = w * 0.68;
            const cy = h * 0.55;

            // Hat
            ctx.fillStyle = '#c79d62';
            ctx.beginPath();
            ctx.ellipse(cx, cy - 70, 45, 14, -0.05, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx, cy - 74, 25, Math.PI, 0);
            ctx.fill();

            // Head & Face
            ctx.fillStyle = '#dca685';
            ctx.beginPath();
            ctx.ellipse(cx, cy - 50, 24, 30, 0, 0, Math.PI * 2);
            ctx.fill();

            // Jacket
            ctx.fillStyle = '#1e3852';
            ctx.beginPath();
            ctx.moveTo(cx - 55, h);
            ctx.lineTo(cx - 35, cy - 20);
            ctx.lineTo(cx + 35, cy - 20);
            ctx.lineTo(cx + 60, h);
            ctx.closePath();
            ctx.fill();

            // Camera strap around neck
            ctx.strokeStyle = '#e8a030';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(cx, cy + 20, 28, 0, Math.PI);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'mountain_landscape',
      name: 'Mountain Landscape',
      baseEV: 14.0,
      baseWB: 5500,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 15.0,
      description: 'Jagged snowy peaks over an alpine lake with pine trees and granite rocks.',
      layers: {
        background: {
          depth: 120.0,
          render(ctx, w, h) {
            // Bright mountain daylight sky
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.5);
            sky.addColorStop(0, '#1b63b8');
            sky.addColorStop(0.6, '#5698e6');
            sky.addColorStop(1, '#d8eaff');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Fluffy cumulus clouds
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.arc(w * 0.25, h * 0.16, 35, 0, Math.PI * 2);
            ctx.arc(w * 0.32, h * 0.14, 45, 0, Math.PI * 2);
            ctx.arc(w * 0.40, h * 0.17, 30, 0, Math.PI * 2);
            ctx.fill();

            // Majestic snow-capped peaks
            ctx.fillStyle = '#3f4756';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.45);
            ctx.lineTo(w * 0.22, h * 0.15);
            ctx.lineTo(w * 0.48, h * 0.38);
            ctx.lineTo(w * 0.72, h * 0.12);
            ctx.lineTo(w, h * 0.42);
            ctx.lineTo(w, h * 0.6);
            ctx.lineTo(0, h * 0.6);
            ctx.fill();

            // Snow glaciers on peaks
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(w * 0.22, h * 0.15);
            ctx.lineTo(w * 0.17, h * 0.23);
            ctx.lineTo(w * 0.23, h * 0.26);
            ctx.lineTo(w * 0.28, h * 0.22);
            ctx.closePath();
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(w * 0.72, h * 0.12);
            ctx.lineTo(w * 0.66, h * 0.21);
            ctx.lineTo(w * 0.73, h * 0.25);
            ctx.lineTo(w * 0.78, h * 0.19);
            ctx.closePath();
            ctx.fill();
          }
        },
        midground: {
          depth: 15.0,
          render(ctx, w, h) {
            // Pine forest line
            ctx.fillStyle = '#17311f';
            for (let i = 0; i < w; i += 18) {
              const th = 25 + Math.sin(i * 0.05) * 12;
              ctx.beginPath();
              ctx.moveTo(i, h * 0.52);
              ctx.lineTo(i + 9, h * 0.52 - th);
              ctx.lineTo(i + 18, h * 0.52);
              ctx.fill();
            }

            // Alpine lake with reflections
            const water = ctx.createLinearGradient(0, h * 0.52, 0, h * 0.78);
            water.addColorStop(0, '#264e6b');
            water.addColorStop(1, '#1b3345');
            ctx.fillStyle = water;
            ctx.fillRect(0, h * 0.52, w, h * 0.26);

            // Water ripples
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            for (let y = h * 0.56; y < h * 0.76; y += 8) {
              ctx.beginPath();
              ctx.moveTo(w * 0.1, y);
              ctx.lineTo(w * 0.85, y);
              ctx.stroke();
            }
          }
        },
        foreground: {
          depth: 2.5,
          render(ctx, w, h) {
            // Granite rocks, moss, and trail wildflowers
            ctx.fillStyle = '#4f555c';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.75);
            ctx.bezierCurveTo(w * 0.25, h * 0.72, w * 0.45, h * 0.82, w * 0.65, h * 0.76);
            ctx.lineTo(w, h * 0.79);
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.fill();

            // Detailed rock boulder at left
            ctx.fillStyle = '#6e7782';
            ctx.beginPath();
            ctx.ellipse(w * 0.2, h * 0.88, 70, 42, -0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#353a40';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Wildflowers
            const flowers = [
              {x: w * 0.35, y: h * 0.86, c: '#e8a030'},
              {x: w * 0.42, y: h * 0.89, c: '#ff7675'},
              {x: w * 0.50, y: h * 0.85, c: '#74b9ff'},
              {x: w * 0.58, y: h * 0.91, c: '#ffeaa7'}
            ];
            flowers.forEach(f => {
              ctx.fillStyle = f.c;
              ctx.beginPath();
              ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = '#27ae60';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(f.x, f.y + 4);
              ctx.lineTo(f.x, f.y + 16);
              ctx.stroke();
            });
          }
        }
      }
    },
    {
      id: 'street_photo',
      name: 'Street Photography',
      baseEV: 11.5,
      baseWB: 5500,
      hasMotion: true,
      motionSpeed: 4,
      subjectDepth: 3.5,
      description: 'Urban city street with deep perspective lines, crosswalk, and walking pedestrians.',
      layers: {
        background: {
          depth: 50.0,
          render(ctx, w, h) {
            // Overcast city sky
            ctx.fillStyle = '#a8b4be';
            ctx.fillRect(0, 0, w, h * 0.4);

            // High-rise architecture vanishing perspective
            const vpX = w * 0.5;
            const vpY = h * 0.42;

            // Left building facade
            ctx.fillStyle = '#424855';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(vpX - 40, vpY);
            ctx.lineTo(vpX - 40, h);
            ctx.lineTo(0, h);
            ctx.fill();

            // Right building facade
            ctx.fillStyle = '#5c6373';
            ctx.beginPath();
            ctx.moveTo(w, 0);
            ctx.lineTo(vpX + 40, vpY);
            ctx.lineTo(vpX + 40, h);
            ctx.lineTo(w, h);
            ctx.fill();

            // Windows grid on buildings
            ctx.fillStyle = '#ffd580';
            for (let row = 40; row < h * 0.6; row += 24) {
              const lx = vpX - 40 - (row * 0.55);
              if (lx > 20) {
                ctx.fillRect(lx, row, 18, 12);
              }
              const rx = vpX + 40 + (row * 0.55);
              if (rx < w - 40) {
                ctx.fillRect(rx, row, 18, 12);
              }
            }
          }
        },
        midground: {
          depth: 10.0,
          render(ctx, w, h, time, motionBlurPx) {
            // Asphalt street
            ctx.fillStyle = '#22252a';
            ctx.beginPath();
            ctx.moveTo(w * 0.5 - 40, h * 0.42);
            ctx.lineTo(w * 0.5 + 40, h * 0.42);
            ctx.lineTo(w * 0.9, h);
            ctx.lineTo(w * 0.1, h);
            ctx.fill();

            // Yellow taxi cab moving across street (has motion!)
            ctx.save();
            const taxiX = w * 0.42;
            const taxiY = h * 0.52;

            if (motionBlurPx > 1) {
              ctx.filter = `blur(${motionBlurPx}px)`;
            }
            ctx.fillStyle = '#e5a522';
            ctx.fillRect(taxiX, taxiY, 65, 24);
            ctx.fillStyle = '#111';
            ctx.beginPath();
            ctx.arc(taxiX + 14, taxiY + 24, 7, 0, Math.PI * 2);
            ctx.arc(taxiX + 52, taxiY + 24, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        },
        foreground: {
          depth: 3.5,
          render(ctx, w, h) {
            // Crosswalk stripes
            ctx.fillStyle = '#ffffff';
            for (let x = w * 0.22; x < w * 0.78; x += 36) {
              ctx.beginPath();
              ctx.moveTo(x, h * 0.78);
              ctx.lineTo(x + 22, h * 0.78);
              ctx.lineTo(x + 15, h * 0.95);
              ctx.lineTo(x - 7, h * 0.95);
              ctx.fill();
            }

            // Pedestrian walking in trenchcoat
            const px = w * 0.36;
            const py = h * 0.72;

            // Head
            ctx.fillStyle = '#dca685';
            ctx.beginPath();
            ctx.arc(px, py - 60, 14, 0, Math.PI * 2);
            ctx.fill();

            // Fedora hat
            ctx.fillStyle = '#1c1c24';
            ctx.beginPath();
            ctx.ellipse(px, py - 70, 22, 6, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(px - 12, py - 82, 24, 12);

            // Trench coat
            ctx.fillStyle = '#a38f78';
            ctx.beginPath();
            ctx.moveTo(px - 22, py - 46);
            ctx.lineTo(px + 22, py - 46);
            ctx.lineTo(px + 28, py + 30);
            ctx.lineTo(px - 28, py + 30);
            ctx.closePath();
            ctx.fill();

            // Legs
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(px - 10, py + 30);
            ctx.lineTo(px - 18, py + 72);
            ctx.moveTo(px + 10, py + 30);
            ctx.lineTo(px + 16, py + 72);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'night_city',
      name: 'Night City Lights',
      baseEV: 3.5,
      baseWB: 4000,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 8.0,
      description: 'Luminous skyline at night with neon road reflections and skyscrapers.',
      layers: {
        background: {
          depth: 100.0,
          render(ctx, w, h) {
            // Midnight blue gradient sky
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
            sky.addColorStop(0, '#03050c');
            sky.addColorStop(0.7, '#091326');
            sky.addColorStop(1, '#16233d');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Distant starry dots
            ctx.fillStyle = '#ffffff';
            const stars = [
              {x: 45, y: 30}, {x: 120, y: 15}, {x: 280, y: 40},
              {x: 420, y: 25}, {x: 540, y: 35}, {x: 350, y: 60}
            ];
            stars.forEach(s => ctx.fillRect(s.x, s.y, 2, 2));

            // Towering skyscrapers
            const towers = [
              {x: 40, w: 70, h: 220, c: '#0d131f'},
              {x: 125, w: 90, h: 280, c: '#080d17'},
              {x: 230, w: 110, h: 320, c: '#0f1726'},
              {x: 355, w: 85, h: 260, c: '#0b101c'},
              {x: 455, w: 100, h: 290, c: '#10192a'}
            ];
            towers.forEach(t => {
              ctx.fillStyle = t.c;
              ctx.fillRect(t.x, h * 0.65 - t.h, t.w, t.h);

              // Glowing office windows
              for (let y = h * 0.65 - t.h + 20; y < h * 0.65 - 10; y += 14) {
                for (let x = t.x + 8; x < t.x + t.w - 10; x += 12) {
                  if (Math.sin(x * 7 + y * 13) > -0.2) {
                    ctx.fillStyle = Math.sin(x + y) > 0.4 ? '#ffd369' : '#82ccdd';
                    ctx.fillRect(x, y, 6, 8);
                  }
                }
              }
            });
          }
        },
        midground: {
          depth: 15.0,
          render(ctx, w, h) {
            // Elevated highway bridge with street lights
            ctx.fillStyle = '#141822';
            ctx.fillRect(0, h * 0.65, w, 28);

            // Street lamps with glowing halos
            for (let lx = 30; lx < w; lx += 80) {
              // Pole
              ctx.strokeStyle = '#3d4454';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(lx, h * 0.65);
              ctx.lineTo(lx, h * 0.65 - 24);
              ctx.stroke();

              // Glowing amber halo
              const halo = ctx.createRadialGradient(lx, h * 0.65 - 24, 2, lx, h * 0.65 - 24, 18);
              halo.addColorStop(0, '#fff');
              halo.addColorStop(0.3, 'rgba(232, 160, 48, 0.9)');
              halo.addColorStop(1, 'rgba(232, 160, 48, 0)');
              ctx.fillStyle = halo;
              ctx.beginPath();
              ctx.arc(lx, h * 0.65 - 24, 18, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        },
        foreground: {
          depth: 4.0,
          render(ctx, w, h) {
            // Wet asphalt road with colorful neon reflections
            ctx.fillStyle = '#090a0f';
            ctx.fillRect(0, h * 0.72, w, h * 0.28);

            // Shimmering neon puddles
            const neons = [
              {x: w * 0.25, w: 80, c: 'rgba(255, 74, 150, 0.4)'},
              {x: w * 0.50, w: 110, c: 'rgba(74, 158, 255, 0.45)'},
              {x: w * 0.78, w: 90, c: 'rgba(232, 160, 48, 0.5)'}
            ];
            neons.forEach(n => {
              const grad = ctx.createLinearGradient(n.x, h * 0.74, n.x, h);
              grad.addColorStop(0, n.c);
              grad.addColorStop(1, 'rgba(0,0,0,0)');
              ctx.fillStyle = grad;
              ctx.fillRect(n.x - n.w / 2, h * 0.74, n.w, h * 0.26);
            });

            // Cast iron railing in foreground
            ctx.strokeStyle = '#1b1d28';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(0, h * 0.82);
            ctx.lineTo(w, h * 0.82);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'moving_vehicle',
      name: 'Moving Vehicle (Action)',
      baseEV: 9.0,
      baseWB: 5500,
      hasMotion: true,
      motionSpeed: 16,
      subjectDepth: 4.0,
      description: 'A sports coupe speeding on a dusk freeway. Test fast shutter freeze vs motion trails.',
      layers: {
        background: {
          depth: 60.0,
          render(ctx, w, h) {
            // Twilight gradient sky
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
            sky.addColorStop(0, '#101d36');
            sky.addColorStop(0.6, '#363457');
            sky.addColorStop(1, '#a35052');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Distant tree silhouette
            ctx.fillStyle = '#0c0f18';
            ctx.beginPath();
            ctx.moveTo(0, h * 0.55);
            for (let x = 0; x < w; x += 30) {
              ctx.lineTo(x + 15, h * 0.55 - 12 - Math.sin(x) * 8);
              ctx.lineTo(x + 30, h * 0.55);
            }
            ctx.lineTo(w, h * 0.55);
            ctx.lineTo(w, h);
            ctx.lineTo(0, h);
            ctx.fill();
          }
        },
        midground: {
          depth: 4.0, // Car is subject!
          render(ctx, w, h, time, motionBlurPx) {
            ctx.save();
            const cx = w * 0.5;
            const cy = h * 0.58;

            // Highway road
            ctx.fillStyle = '#1e2026';
            ctx.fillRect(0, h * 0.55, w, h * 0.45);

            // Guardrail
            ctx.fillStyle = '#3f434d';
            ctx.fillRect(0, h * 0.54, w, 6);

            // Motion blur effect on car and light trails
            if (motionBlurPx > 1) {
              // Apply horizontal motion blur
              ctx.filter = `blur(${Math.min(32, motionBlurPx * 1.5)}px)`;
            }

            // Red taillight light streak (drawn if shutter is slow!)
            if (motionBlurPx > 8) {
              ctx.strokeStyle = 'rgba(255, 30, 30, 0.85)';
              ctx.lineWidth = 6;
              ctx.shadowColor = '#ff2222';
              ctx.shadowBlur = 18;
              ctx.beginPath();
              ctx.moveTo(0, cy + 4);
              ctx.lineTo(cx, cy + 4);
              ctx.stroke();

              // Headlight streak
              ctx.strokeStyle = 'rgba(255, 245, 180, 0.85)';
              ctx.shadowColor = '#ffee88';
              ctx.beginPath();
              ctx.moveTo(cx + 120, cy + 10);
              ctx.lineTo(w, cy + 14);
              ctx.stroke();
              ctx.shadowBlur = 0;
            }

            // Sleek red sports coupe
            ctx.fillStyle = '#d63031';
            ctx.beginPath();
            ctx.moveTo(cx - 100, cy + 16);
            ctx.lineTo(cx - 85, cy - 8);
            ctx.lineTo(cx - 35, cy - 26);
            ctx.lineTo(cx + 45, cy - 26);
            ctx.lineTo(cx + 85, cy - 4);
            ctx.lineTo(cx + 115, cy + 16);
            ctx.closePath();
            ctx.fill();

            // Windshield & windows
            ctx.fillStyle = '#2d3436';
            ctx.beginPath();
            ctx.moveTo(cx - 30, cy - 22);
            ctx.lineTo(cx + 38, cy - 22);
            ctx.lineTo(cx + 70, cy - 6);
            ctx.lineTo(cx - 45, cy - 6);
            ctx.closePath();
            ctx.fill();

            // Headlight & Taillight
            ctx.fillStyle = '#ff7675';
            ctx.fillRect(cx - 100, cy + 2, 8, 8);
            ctx.fillStyle = '#ffeaa7';
            ctx.fillRect(cx + 108, cy + 4, 8, 8);

            // Wheels & rims
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.arc(cx - 60, cy + 18, 18, 0, Math.PI * 2);
            ctx.arc(cx + 70, cy + 18, 18, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#b2bec3';
            ctx.beginPath();
            ctx.arc(cx - 60, cy + 18, 9, 0, Math.PI * 2);
            ctx.arc(cx + 70, cy + 18, 9, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
          }
        },
        foreground: {
          depth: 1.5,
          render(ctx, w, h) {
            // Road dashes in immediate foreground
            ctx.fillStyle = '#ffffff';
            for (let x = -20; x < w + 60; x += 110) {
              ctx.fillRect(x, h * 0.88, 60, 6);
            }
          }
        }
      }
    },
    {
      id: 'waterfall',
      name: 'Cascading Waterfall',
      baseEV: 12.0,
      baseWB: 5500,
      hasMotion: true,
      motionSpeed: 12,
      subjectDepth: 6.0,
      description: 'Lush mountain waterfall. Freeze crisp water droplets or blur into a silky smooth veil.',
      layers: {
        background: {
          depth: 40.0,
          render(ctx, w, h) {
            // Dark mossy canyon gorge
            const rock = ctx.createLinearGradient(0, 0, 0, h);
            rock.addColorStop(0, '#192a1d');
            rock.addColorStop(0.5, '#2f3b33');
            rock.addColorStop(1, '#1b231c');
            ctx.fillStyle = rock;
            ctx.fillRect(0, 0, w, h);

            // Lush hanging ferns & ivy
            ctx.fillStyle = '#27ae60';
            for (let i = 20; i < w; i += 40) {
              ctx.beginPath();
              ctx.arc(i, 20 + (i % 30), 28, 0, Math.PI);
              ctx.fill();
            }
          }
        },
        midground: {
          depth: 6.0,
          render(ctx, w, h, time, motionBlurPx) {
            ctx.save();
            // Waterfall chute
            const chuteX = w * 0.44;
            const chuteW = w * 0.22;

            if (motionBlurPx > 3) {
              // Silky smooth veil effect (slow shutter)
              ctx.filter = `blur(${Math.min(24, motionBlurPx * 1.2)}px)`;
              ctx.fillStyle = 'rgba(235, 245, 255, 0.95)';
              ctx.fillRect(chuteX, 40, chuteW, h * 0.65);

              // Soft mist glow at base
              const mist = ctx.createRadialGradient(w * 0.55, h * 0.72, 20, w * 0.55, h * 0.72, 120);
              mist.addColorStop(0, 'rgba(255,255,255,0.7)');
              mist.addColorStop(1, 'rgba(255,255,255,0)');
              ctx.fillStyle = mist;
              ctx.beginPath();
              ctx.arc(w * 0.55, h * 0.72, 120, 0, Math.PI * 2);
              ctx.fill();
            } else {
              // Crisp individual water cascades & droplet spray (fast shutter)
              ctx.fillStyle = '#edf2f7';
              ctx.fillRect(chuteX, 40, chuteW, h * 0.65);

              // Distinct vertical water streak lines
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 2;
              for (let x = chuteX + 6; x < chuteX + chuteW - 6; x += 8) {
                ctx.beginPath();
                ctx.moveTo(x, 40);
                ctx.lineTo(x + (Math.sin(x) * 4), h * 0.7);
                ctx.stroke();
              }

              // Splash droplets in air
              ctx.fillStyle = '#ffffff';
              for (let i = 0; i < 40; i++) {
                const dx = chuteX - 20 + Math.random() * (chuteW + 40);
                const dy = h * 0.62 + Math.random() * 50;
                ctx.beginPath();
                ctx.arc(dx, dy, 1.5 + Math.random() * 2, 0, Math.PI * 2);
                ctx.fill();
              }
            }
            ctx.restore();
          }
        },
        foreground: {
          depth: 2.0,
          render(ctx, w, h) {
            // Emerald plunge pool
            const pool = ctx.createLinearGradient(0, h * 0.7, 0, h);
            pool.addColorStop(0, '#134e4a');
            pool.addColorStop(1, '#042f2e');
            ctx.fillStyle = pool;
            ctx.fillRect(0, h * 0.7, w, h * 0.3);

            // Wet dark boulders in foreground
            ctx.fillStyle = '#222831';
            ctx.beginPath();
            ctx.ellipse(w * 0.18, h * 0.88, 80, 45, 0.1, 0, Math.PI * 2);
            ctx.ellipse(w * 0.82, h * 0.84, 95, 52, -0.15, 0, Math.PI * 2);
            ctx.fill();
            // Wet specular highlights
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(w * 0.18, h * 0.85, 45, -0.5, 0.4);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'wildlife_birds',
      name: 'Wildlife Bird in Flight',
      baseEV: 13.5,
      baseWB: 5500,
      hasMotion: true,
      motionSpeed: 14,
      subjectDepth: 7.0,
      description: 'Majestic red-tailed hawk soaring. Test fast shutter to freeze feathers vs wing blur.',
      layers: {
        background: {
          depth: 100.0,
          render(ctx, w, h) {
            // Clean azure sky with soft cirrus clouds
            const sky = ctx.createLinearGradient(0, 0, 0, h);
            sky.addColorStop(0, '#2980b9');
            sky.addColorStop(0.7, '#6dd5fa');
            sky.addColorStop(1, '#ffffff');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Cirrus wisps
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.beginPath();
            ctx.ellipse(w * 0.7, h * 0.25, 120, 18, -0.2, 0, Math.PI * 2);
            ctx.ellipse(w * 0.25, h * 0.4, 90, 14, 0.1, 0, Math.PI * 2);
            ctx.fill();
          }
        },
        midground: {
          depth: 7.0, // Flying Hawk is subject!
          render(ctx, w, h, time, motionBlurPx) {
            ctx.save();
            const bx = w * 0.52;
            const by = h * 0.44;

            if (motionBlurPx > 2) {
              ctx.filter = `blur(${Math.min(22, motionBlurPx * 1.3)}px)`;
            }

            // Hawk wings outstretched
            ctx.fillStyle = '#4a2f1b';
            ctx.beginPath();
            // Left wing
            ctx.moveTo(bx, by);
            ctx.quadraticCurveTo(bx - 90, by - 60, bx - 160, by - 40);
            ctx.lineTo(bx - 120, by + 10);
            ctx.lineTo(bx - 50, by + 15);
            // Right wing
            ctx.quadraticCurveTo(bx + 90, by - 60, bx + 160, by - 40);
            ctx.lineTo(bx + 120, by + 10);
            ctx.lineTo(bx + 50, by + 15);
            ctx.closePath();
            ctx.fill();

            // Wing feather tips (white / buff highlights)
            ctx.fillStyle = '#f8f1e5';
            for (let f = -150; f < -100; f += 12) {
              ctx.fillRect(bx + f, by - 36, 6, 14);
            }
            for (let f = 110; f < 155; f += 12) {
              ctx.fillRect(bx + f, by - 36, 6, 14);
            }

            // Bird body & head
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.ellipse(bx, by - 12, 14, 20, 0, 0, Math.PI * 2);
            ctx.fill();

            // Hooked yellow beak
            ctx.fillStyle = '#e8a030';
            ctx.beginPath();
            ctx.moveTo(bx - 6, by - 24);
            ctx.lineTo(bx, by - 34);
            ctx.lineTo(bx + 6, by - 24);
            ctx.closePath();
            ctx.fill();

            // Fan tail
            ctx.fillStyle = '#d35400';
            ctx.beginPath();
            ctx.moveTo(bx - 18, by + 18);
            ctx.lineTo(bx - 32, by + 58);
            ctx.lineTo(bx + 32, by + 58);
            ctx.lineTo(bx + 18, by + 18);
            ctx.closePath();
            ctx.fill();

            ctx.restore();
          }
        },
        foreground: {
          depth: 3.0,
          render(ctx, w, h) {
            // Oak branch framing the upper-left corner
            ctx.strokeStyle = '#2d1e13';
            ctx.lineWidth = 14;
            ctx.beginPath();
            ctx.moveTo(-10, -10);
            ctx.quadraticCurveTo(w * 0.15, h * 0.18, w * 0.32, h * 0.12);
            ctx.stroke();

            // Leaves on branch
            ctx.fillStyle = '#27ae60';
            ctx.beginPath();
            ctx.ellipse(w * 0.18, h * 0.16, 24, 12, 0.4, 0, Math.PI * 2);
            ctx.ellipse(w * 0.28, h * 0.13, 22, 10, -0.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    },
    {
      id: 'macro_flower',
      name: 'Macro Flower Bloom',
      baseEV: 11.0,
      baseWB: 5500,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 0.6,
      description: 'Extreme close-up macro flower. Demonstrates razor-thin depth of field and creamy bokeh.',
      layers: {
        background: {
          depth: 5.0,
          render(ctx, w, h) {
            // Dreamy pastel green/teal garden bokeh
            const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.5, 30, w * 0.5, h * 0.5, w * 0.7);
            bgGrad.addColorStop(0, '#10ac84');
            bgGrad.addColorStop(0.6, '#1dd1a1');
            bgGrad.addColorStop(1, '#01a3a4');
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, w, h);

            // Circular bokeh discs
            const discs = [
              {x: 70, y: 80, r: 50, a: 0.35, c: '#ffeaa7'},
              {x: 520, y: 120, r: 65, a: 0.30, c: '#fab1a0'},
              {x: 140, y: 320, r: 70, a: 0.25, c: '#ff9ff3'},
              {x: 480, y: 310, r: 55, a: 0.40, c: '#54a0ff'}
            ];
            discs.forEach(d => {
              ctx.beginPath();
              ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
              ctx.fillStyle = d.c;
              ctx.globalAlpha = d.a;
              ctx.fill();
            });
            ctx.globalAlpha = 1.0;
          }
        },
        midground: {
          depth: 1.2,
          render(ctx, w, h) {
            // Broad green stem & secondary leaves
            ctx.strokeStyle = '#0e7e45';
            ctx.lineWidth = 18;
            ctx.beginPath();
            ctx.moveTo(w * 0.5, h * 0.6);
            ctx.lineTo(w * 0.45, h);
            ctx.stroke();
          }
        },
        foreground: {
          depth: 0.6, // Extreme Macro Subject!
          render(ctx, w, h) {
            const cx = w * 0.5;
            const cy = h * 0.46;

            // Velvety magenta / coral petals radiating outward
            const petalColors = ['#ff6b81', '#ff4757', '#e84118', '#c23616'];
            for (let i = 0; i < 12; i++) {
              const angle = (i / 12) * Math.PI * 2;
              ctx.save();
              ctx.translate(cx, cy);
              ctx.rotate(angle);
              
              ctx.fillStyle = petalColors[i % petalColors.length];
              ctx.beginPath();
              ctx.ellipse(0, -95, 38, 75, 0, 0, Math.PI * 2);
              ctx.fill();

              // Petal delicate vein lines
              ctx.strokeStyle = 'rgba(255,255,255,0.2)';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(0, -35);
              ctx.lineTo(0, -155);
              ctx.stroke();

              ctx.restore();
            }

            // Central pistil dome
            ctx.fillStyle = '#2ed573';
            ctx.beginPath();
            ctx.arc(cx, cy, 32, 0, Math.PI * 2);
            ctx.fill();

            // Golden stamens with textured pollen grains
            for (let j = 0; j < 36; j++) {
              const sAngle = (j / 36) * Math.PI * 2;
              const sDist = 36 + (j % 4) * 6;
              const sx = cx + Math.cos(sAngle) * sDist;
              const sy = cy + Math.sin(sAngle) * sDist;

              // Stamen stalk
              ctx.strokeStyle = '#f1f2f6';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(cx, cy);
              ctx.lineTo(sx, sy);
              ctx.stroke();

              // Pollen anther
              ctx.fillStyle = '#ffa502';
              ctx.beginPath();
              ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    },
    {
      id: 'indoor_warm',
      name: 'Cozy Living Room (Tungsten)',
      baseEV: 6.5,
      baseWB: 3200, // Warm incandescent light!
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 2.2,
      description: 'Warm incandescent tungsten room with armchair and floor lamp pool.',
      layers: {
        background: {
          depth: 6.0,
          render(ctx, w, h) {
            // Dark cozy room walls
            ctx.fillStyle = '#1c1f26';
            ctx.fillRect(0, 0, w, h);

            // Bookshelf with colored books
            ctx.fillStyle = '#342618';
            ctx.fillRect(w * 0.08, h * 0.15, w * 0.32, h * 0.6);
            const bookColors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6'];
            for (let shelf = 0; shelf < 3; shelf++) {
              const sy = h * 0.22 + shelf * 55;
              ctx.fillStyle = '#4a3722';
              ctx.fillRect(w * 0.08, sy + 38, w * 0.32, 6);
              for (let b = 0; b < 10; b++) {
                ctx.fillStyle = bookColors[(shelf * 3 + b) % bookColors.length];
                ctx.fillRect(w * 0.1 + b * 16, sy, 12, 38);
              }
            }

            // Framed painting on wall
            ctx.strokeStyle = '#e8a030';
            ctx.lineWidth = 4;
            ctx.strokeRect(w * 0.58, h * 0.15, 110, 75);
            ctx.fillStyle = '#2c3e50';
            ctx.fillRect(w * 0.58 + 2, h * 0.15 + 2, 106, 71);
          }
        },
        midground: {
          depth: 3.5,
          render(ctx, w, h) {
            // Brass floor lamp casting warm conical light beam
            const lx = w * 0.82;
            const ly = h * 0.18;

            // Conical pool of tungsten light
            const cone = ctx.createRadialGradient(lx, ly, 10, lx, ly + 180, 240);
            cone.addColorStop(0, 'rgba(255, 195, 110, 0.85)');
            cone.addColorStop(0.5, 'rgba(255, 160, 60, 0.45)');
            cone.addColorStop(1, 'rgba(255, 120, 20, 0)');
            ctx.fillStyle = cone;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx - 160, h);
            ctx.lineTo(lx + 80, h);
            ctx.closePath();
            ctx.fill();

            // Lamp hardware
            ctx.fillStyle = '#c79d62';
            ctx.fillRect(lx - 20, ly - 22, 40, 26);
            ctx.strokeStyle = '#b8860b';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx, h * 0.85);
            ctx.stroke();
          }
        },
        foreground: {
          depth: 2.2, // Velvet Armchair & side table
          render(ctx, w, h) {
            // Velvet emerald armchair
            const ax = w * 0.54;
            const ay = h * 0.65;

            ctx.fillStyle = '#1e5f48';
            // Backrest
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(ax - 60, ay - 90, 120, 90, 16) : ctx.rect(ax - 60, ay - 90, 120, 90);
            ctx.fill();
            // Cushion seat
            ctx.fillStyle = '#164736';
            ctx.beginPath();
            ctx.ellipse(ax, ay + 15, 65, 24, 0, 0, Math.PI * 2);
            ctx.fill();

            // Wooden side table with steaming coffee mug
            ctx.fillStyle = '#4a2f18';
            ctx.fillRect(w * 0.28, h * 0.72, 65, 8);
            ctx.fillRect(w * 0.32, h * 0.74, 6, 80);

            // Coffee mug
            ctx.fillStyle = '#f5f6fa';
            ctx.fillRect(w * 0.32, h * 0.67, 16, 18);
            ctx.strokeStyle = '#f5f6fa';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(w * 0.32 + 18, h * 0.67 + 9, 5, -Math.PI / 2, Math.PI / 2);
            ctx.stroke();
          }
        }
      }
    },
    {
      id: 'sunset',
      name: 'Vibrant Coastal Sunset',
      baseEV: 10.0,
      baseWB: 6500,
      hasMotion: false,
      motionSpeed: 0,
      subjectDepth: 20.0,
      description: 'Fiery sunset sky over calm ocean with silhouetted coastal palms.',
      layers: {
        background: {
          depth: 150.0,
          render(ctx, w, h) {
            // Intense sunset sky gradient
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.65);
            sky.addColorStop(0, '#2c0c52'); // Indigo violet
            sky.addColorStop(0.3, '#8e1a5a'); // Crimson
            sky.addColorStop(0.65, '#e65100'); // Fiery orange
            sky.addColorStop(0.9, '#fbc02d'); // Golden yellow
            sky.addColorStop(1, '#fff59d'); // Sun horizon
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, w, h);

            // Glowing sun disc at horizon
            const sunX = w * 0.55;
            const sunY = h * 0.62;
            const sunGlow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 90);
            sunGlow.addColorStop(0, '#ffffff');
            sunGlow.addColorStop(0.2, '#fff176');
            sunGlow.addColorStop(0.6, 'rgba(255, 112, 67, 0.6)');
            sunGlow.addColorStop(1, 'rgba(255, 87, 34, 0)');
            ctx.fillStyle = sunGlow;
            ctx.beginPath();
            ctx.arc(sunX, sunY, 90, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff9c4';
            ctx.beginPath();
            ctx.arc(sunX, sunY, 22, 0, Math.PI * 2);
            ctx.fill();
          }
        },
        midground: {
          depth: 20.0,
          render(ctx, w, h) {
            // Ocean surface reflecting sunset
            const ocean = ctx.createLinearGradient(0, h * 0.64, 0, h);
            ocean.addColorStop(0, '#78233a');
            ocean.addColorStop(0.4, '#d84315');
            ocean.addColorStop(1, '#1a0826');
            ctx.fillStyle = ocean;
            ctx.fillRect(0, h * 0.64, w, h * 0.36);

            // Golden sun shimmer path across waves
            ctx.fillStyle = '#fff59d';
            for (let y = h * 0.65; y < h; y += 6) {
              const rw = 20 + (y - h * 0.64) * 1.6;
              const rx = w * 0.55 - rw / 2 + (Math.sin(y * 4) * 6);
              ctx.fillRect(rx, y, rw, 2.5);
            }
          }
        },
        foreground: {
          depth: 3.0,
          render(ctx, w, h) {
            // Silhouetted palm fronds hanging from top-right corner
            ctx.fillStyle = '#0a030c';
            ctx.beginPath();
            ctx.moveTo(w + 10, -10);
            ctx.quadraticCurveTo(w * 0.75, h * 0.25, w * 0.55, h * 0.42);
            ctx.quadraticCurveTo(w * 0.8, h * 0.3, w + 10, 20);
            ctx.fill();

            // Palm frond leaves
            for (let f = 0; f < 18; f++) {
              const fx = w * 0.95 - f * 20;
              const fy = h * 0.05 + f * 18;
              ctx.beginPath();
              ctx.moveTo(fx, fy);
              ctx.lineTo(fx - 45, fy + 35);
              ctx.lineTo(fx - 15, fy + 22);
              ctx.fill();
            }
          }
        }
      }
    },
    {
      id: 'lowlight_indoor',
      name: 'Moody Candlelight Study',
      baseEV: 2.0, // Extreme low light!
      baseWB: 2400,
      hasMotion: true,
      motionSpeed: 2,
      subjectDepth: 1.0,
      description: 'Dark rustic room illuminated solely by a single candle flame.',
      layers: {
        background: {
          depth: 8.0,
          render(ctx, w, h) {
            // Deep inky shadow cellar walls
            ctx.fillStyle = '#08090d';
            ctx.fillRect(0, 0, w, h);

            // Faint silhouette of antique stone arch
            ctx.strokeStyle = '#12141c';
            ctx.lineWidth = 18;
            ctx.beginPath();
            ctx.arc(w * 0.5, h * 0.7, 180, Math.PI, 0);
            ctx.stroke();
          }
        },
        midground: {
          depth: 3.0,
          render(ctx, w, h) {
            // Old oak table surface illuminated by flame
            const cx = w * 0.5;
            const cy = h * 0.62;

            // Dramatic radial illumination
            const candleHalo = ctx.createRadialGradient(cx, cy - 40, 6, cx, cy - 40, 190);
            candleHalo.addColorStop(0, 'rgba(255, 235, 170, 0.95)');
            candleHalo.addColorStop(0.2, 'rgba(255, 150, 40, 0.6)');
            candleHalo.addColorStop(0.6, 'rgba(180, 60, 10, 0.2)');
            candleHalo.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = candleHalo;
            ctx.fillRect(0, 0, w, h);

            // Dark rustic wooden table
            ctx.fillStyle = '#19120c';
            ctx.fillRect(0, h * 0.65, w, h * 0.35);
          }
        },
        foreground: {
          depth: 1.0, // Candle holder & flame is subject!
          render(ctx, w, h) {
            const cx = w * 0.5;
            const cy = h * 0.62;

            // Vintage brass candle holder
            ctx.fillStyle = '#614619';
            ctx.beginPath();
            ctx.ellipse(cx, cy + 30, 48, 14, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(cx - 8, cy + 10, 16, 20);

            // White wax pillar
            ctx.fillStyle = '#f5ede4';
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(cx - 14, cy - 35, 28, 48, 4) : ctx.fillRect(cx - 14, cy - 35, 28, 48);
            ctx.fill();

            // Dripping wax ripples
            ctx.fillStyle = '#e8ded2';
            ctx.beginPath();
            ctx.arc(cx - 12, cy - 10, 4, 0, Math.PI * 2);
            ctx.arc(cx + 8, cy - 4, 5, 0, Math.PI * 2);
            ctx.fill();

            // Wick
            ctx.strokeStyle = '#2d2013';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(cx, cy - 35);
            ctx.lineTo(cx, cy - 44);
            ctx.stroke();

            // Glowing teardrop flame
            ctx.fillStyle = '#ff793f';
            ctx.beginPath();
            ctx.moveTo(cx, cy - 65);
            ctx.quadraticCurveTo(cx + 12, cy - 48, cx, cy - 42);
            ctx.quadraticCurveTo(cx - 12, cy - 48, cx, cy - 65);
            ctx.closePath();
            ctx.fill();

            // Inner white-hot flame core
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.ellipse(cx, cy - 48, 4, 8, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  ];
  /* --------------------------------------------------------------------------
     SIMULATION RENDERING PIPELINE
     -------------------------------------------------------------------------- */
  // Reusable offscreen canvas for rendering layers
  let offscreenCanvas = null;
  let offscreenCtx = null;

  function getOffscreen(w, h) {
    if (!offscreenCanvas) {
      offscreenCanvas = document.createElement('canvas');
      offscreenCtx = offscreenCanvas.getContext('2d');
    }
    if (offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
      offscreenCanvas.width = w;
      offscreenCanvas.height = h;
    }
    return { canvas: offscreenCanvas, ctx: offscreenCtx };
  }

  function renderSceneToCanvas(targetCanvas, scene, customSettings = null, isCompareReference = false) {
    if (!targetCanvas || !scene) return;
    const ctx = targetCanvas.getContext('2d');
    const w = targetCanvas.width;
    const h = targetCanvas.height;

    // Use global simulator settings or custom override
    const settings = customSettings || {
      iso: isCompareReference ? 100 : state.simulator.iso,
      shutterIndex: isCompareReference ? 7 : state.simulator.shutterIndex, // 1/125s
      aperture: isCompareReference ? 8.0 : state.simulator.aperture,
      kelvin: isCompareReference ? scene.baseWB : state.simulator.kelvin,
      focusDistance: isCompareReference ? scene.subjectDepth : state.simulator.focusDistance,
      focalLength: isCompareReference ? 50 : state.simulator.focalLength,
      showClipping: isCompareReference ? false : state.simulator.showClipping
    };

    const shutterSeconds = SHUTTER_VALUES[settings.shutterIndex];
    const { ctx: offCtx } = getOffscreen(w, h);
    offCtx.clearRect(0, 0, w, h);

    // 1. Calculate Optical Blur & Motion Blur per Layer
    const layerKeys = ['background', 'midground', 'foreground'];
    const nowTime = performance.now();

    // Handheld camera shake threshold: 1 / focalLength
    const minHandheldSpeed = 1 / settings.focalLength;
    const hasCameraShake = (!isCompareReference && shutterSeconds > minHandheldSpeed);
    const cameraShakePx = hasCameraShake ? Math.min(6, (shutterSeconds / minHandheldSpeed) * 1.5) : 0;

    // Update shake warning UI banner
    const shakeBanner = document.getElementById('shakeWarningBanner');
    if (shakeBanner && !customSettings) {
      if (hasCameraShake) {
        shakeBanner.classList.add('visible');
      } else {
        shakeBanner.classList.remove('visible');
      }
    }

    // Motion blur on moving objects (waterfall, car, bird)
    let objectMotionBlurPx = 0;
    if (scene.hasMotion) {
      // Faster shutter (< 1/500s) freezes action; slower shutter (> 1/30s) blurs heavily
      objectMotionBlurPx = Math.max(0, (shutterSeconds * scene.motionSpeed * 40));
    }

    // Render 3 Layers with Depth of Field Blur
    layerKeys.forEach(key => {
      const layer = scene.layers[key];
      if (!layer) return;

      offCtx.save();

      // Optical circle of confusion Gaussian blur calculation
      const distDelta = Math.abs(layer.depth - settings.focusDistance);
      // Aperture scaling: f/1.4 produces massive blur, f/16 produces zero blur
      const focalScale = Math.pow(settings.focalLength / 50, 1.8);
      const dofBlurPx = Math.min(28, (distDelta * focalScale * 14) / (settings.aperture * Math.max(0.8, settings.focusDistance)));

      const totalBlur = Math.max(0, dofBlurPx + (cameraShakePx * 0.4));
      if (totalBlur > 0.6) {
        offCtx.filter = `blur(${totalBlur.toFixed(1)}px)`;
      } else {
        offCtx.filter = 'none';
      }

      // Draw the layer
      layer.render(offCtx, w, h, nowTime, objectMotionBlurPx);
      offCtx.restore();
    });

    // 2. Focal Length Crop / Perspective Scaling (Wide 14mm to Tele 300mm)
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    
    // 50mm is 1.0x baseline. 14mm zooms out (0.6x), 200mm zooms in (2.4x)
    const zoomFactor = Math.pow(settings.focalLength / 50, 0.45);
    const cropW = w / zoomFactor;
    const cropH = h / zoomFactor;
    const cropX = (w - cropW) / 2;
    const cropY = (h - cropH) / 2;

    ctx.drawImage(offscreenCanvas, cropX, cropY, cropW, cropH, 0, 0, w, h);
    ctx.restore();

    // 3. Apply Exposure, White Balance, ISO Grain, and Tone-Mapping via Pixel Pipeline
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const pixelCount = data.length / 4;

    // Calculate Exposure Multiplier
    const evDelta = calculateExposureDelta(scene.baseEV, settings.iso, settings.aperture, shutterSeconds);
    // 2^evDelta is standard linear light factor
    const exposureMult = Math.pow(2, evDelta);

    // Calculate White Balance Color Multipliers (Scene WB vs Camera WB)
    const sceneColor = kelvinToRgb(scene.baseWB);
    const camColor = kelvinToRgb(settings.kelvin);
    // WB correction ratio
    const wbR = sceneColor.r / Math.max(0.01, camColor.r);
    const wbG = sceneColor.g / Math.max(0.01, camColor.g);
    const wbB = sceneColor.b / Math.max(0.01, camColor.b);

    // Calculate ISO Noise / Grain Intensity
    // ISO 100 = 0 noise, ISO 800 = subtle, ISO 12800 = heavy noise
    const noiseIntensity = Math.max(0, Math.log2(settings.iso / 100) * 11);

    // Histogram accumulator bins (256 luminance levels)
    const histBins = new Uint32Array(256);
    let shadowClipped = 0;
    let highlightClipped = 0;

    // Process every pixel
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 4;
      let r = data[idx];
      let g = data[idx + 1];
      let b = data[idx + 2];

      // Step A: Apply White Balance tint
      r = r * wbR;
      g = g * wbG;
      b = b * wbB;

      // Step B: Apply Exposure multiplier with S-curve tone mapping & highlight roll-off
      r = r * exposureMult;
      g = g * exposureMult;
      b = b * exposureMult;

      // Tone-mapping curve (prevents harsh clamp, creates photographic roll-off)
      r = (r * (1 + r / 400)) / (1 + r / 255);
      g = (g * (1 + g / 400)) / (1 + g / 255);
      b = (b * (1 + b / 400)) / (1 + b / 255);

      // Step C: Apply ISO grain / noise
      if (noiseIntensity > 0) {
        // Random Gaussian-like grain
        const noise = (Math.random() + Math.random() - 1) * noiseIntensity;
        // Subtle color chrominance speckling on high ISO
        const chromaR = (Math.random() - 0.5) * (noiseIntensity * 0.4);
        const chromaB = (Math.random() - 0.5) * (noiseIntensity * 0.4);
        r += noise + chromaR;
        g += noise;
        b += noise + chromaB;
      }

      // Calculate luminance for histogram and clipping detection
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const clampedLum = Math.max(0, Math.min(255, lum));
      histBins[clampedLum]++;

      // Step D: Clipping warnings or final clamp
      if (settings.showClipping) {
        if (lum > 248) {
          highlightClipped++;
          // Red zebra highlight clipping
          r = 255;
          g = ((i % 16) < 8) ? 0 : 255;
          b = 0;
        } else if (lum < 8) {
          shadowClipped++;
          // Blue shadow clipping
          r = 0;
          g = 0;
          b = 255;
        } else {
          r = Math.max(0, Math.min(255, r));
          g = Math.max(0, Math.min(255, g));
          b = Math.max(0, Math.min(255, b));
        }
      } else {
        r = Math.max(0, Math.min(255, r));
        g = Math.max(0, Math.min(255, g));
        b = Math.max(0, Math.min(255, b));
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
    }

    // Write processed pixels back to canvas
    ctx.putImageData(imgData, 0, 0);

    // If this is the main simulator canvas, update telemetry
    if (targetCanvas.id === 'simCanvas' && !customSettings) {
      updateHistogramDisplay(histBins, shadowClipped, highlightClipped);
      updateExposureMeter(evDelta);
      updateViewfinderHud(evDelta, settings, shutterSeconds);
    }

    return { evDelta, histBins };
  }

  /* --------------------------------------------------------------------------
     TELEMETRY & HUD UPDATES
     -------------------------------------------------------------------------- */
  function updateHistogramDisplay(bins, shadowClipped, highlightClipped) {
    const histCanvas = document.getElementById('histogramCanvas');
    if (!histCanvas) return;
    const hCtx = histCanvas.getContext('2d');
    const hw = histCanvas.width;
    const hh = histCanvas.height;

    hCtx.fillStyle = '#0d0d14';
    hCtx.fillRect(0, 0, hw, hh);

    // Find peak frequency
    let maxVal = 1;
    for (let i = 1; i < 255; i++) {
      if (bins[i] > maxVal) maxVal = bins[i];
    }

    // Draw smooth luminance curve
    const grad = hCtx.createLinearGradient(0, 0, hw, 0);
    grad.addColorStop(0, '#4a9eff');
    grad.addColorStop(0.5, '#e8a030');
    grad.addColorStop(1, '#ff5e57');

    hCtx.beginPath();
    hCtx.moveTo(0, hh);
    for (let x = 0; x < hw; x++) {
      const binIdx = Math.floor((x / hw) * 256);
      const val = bins[binIdx] || 0;
      const barH = (val / maxVal) * (hh - 6);
      hCtx.lineTo(x, hh - barH);
    }
    hCtx.lineTo(hw, hh);
    hCtx.closePath();

    hCtx.fillStyle = 'rgba(232, 160, 48, 0.25)';
    hCtx.fill();
    hCtx.strokeStyle = grad;
    hCtx.lineWidth = 1.5;
    hCtx.stroke();

    // Update clipping label in histogram header
    const clipLabel = document.getElementById('histogramClipState');
    if (clipLabel) {
      if (highlightClipped > 2000) {
        clipLabel.textContent = 'Highlights Blown!';
        clipLabel.style.color = 'var(--accent-red)';
      } else if (shadowClipped > 2000) {
        clipLabel.textContent = 'Shadows Crushed!';
        clipLabel.style.color = 'var(--accent-blue)';
      } else {
        clipLabel.textContent = 'Exposure Balanced';
        clipLabel.style.color = 'var(--accent-green)';
      }
    }
  }

  function updateExposureMeter(evDelta) {
    const needle = document.getElementById('meterNeedle');
    const statusTag = document.getElementById('meterStatusTag');
    const numericBadge = document.getElementById('evNumericBadge');
    if (!needle) return;

    // Needle maps EV delta [-3 to +3] to range [5% to 95%]
    const clampedEv = Math.max(-3, Math.min(3, evDelta));
    const needlePct = 50 + (clampedEv / 3) * 45;
    needle.style.left = `${needlePct}%`;

    // Numeric badge
    const sign = evDelta > 0 ? '+' : '';
    numericBadge.textContent = `${sign}${evDelta.toFixed(1)} EV`;

    // Status Tag
    if (evDelta < -1.5) {
      statusTag.textContent = 'UNDEREXPOSED';
      statusTag.className = 'meter-status-tag badge-red';
      numericBadge.style.color = 'var(--accent-red)';
    } else if (evDelta > 1.5) {
      statusTag.textContent = 'OVEREXPOSED';
      statusTag.className = 'meter-status-tag badge-red';
      numericBadge.style.color = 'var(--accent-red)';
    } else if (Math.abs(evDelta) <= 0.6) {
      statusTag.textContent = 'OPTIMAL EXPOSURE';
      statusTag.className = 'meter-status-tag badge-green';
      numericBadge.style.color = 'var(--accent-green)';
    } else {
      statusTag.textContent = evDelta > 0 ? 'SLIGHT OVER' : 'SLIGHT UNDER';
      statusTag.className = 'meter-status-tag badge-gold';
      numericBadge.style.color = 'var(--accent-gold)';
    }
  }

  function updateViewfinderHud(evDelta, settings, shutterSeconds) {
    // Top HUD
    const scene = SCENES[state.simulator.sceneIndex];
    const sceneBadge = document.getElementById('currentSceneBadge');
    if (sceneBadge) sceneBadge.textContent = scene.name;

    // Bottom HUD
    document.getElementById('hudIso').textContent = settings.iso;
    document.getElementById('hudShutter').textContent = SHUTTER_SPEEDS[state.simulator.shutterIndex];
    document.getElementById('hudAperture').textContent = `f/${settings.aperture.toFixed(1)}`;
    const sign = evDelta > 0 ? '+' : '';
    document.getElementById('hudEv').textContent = `${sign}${evDelta.toFixed(1)}`;

    // DoF range indicator
    const dof = calculateDepthOfField(settings.aperture, settings.focusDistance, settings.focalLength);
    const dofSpan = document.getElementById('dofSpanText');
    if (dofSpan) dofSpan.textContent = `${dof.nearMeters}m – ${dof.farMeters}m`;

    // DoF bar visual pins
    const sharpZone = document.getElementById('dofSharpZone');
    const focusPin = document.getElementById('dofFocusPin');
    if (sharpZone && focusPin) {
      const nearFrac = Math.min(1, parseFloat(dof.nearMeters) / 15);
      const farFrac = dof.farMeters === 'Infinity' ? 1 : Math.min(1, parseFloat(dof.farMeters) / 15);
      const focusFrac = Math.min(1, settings.focusDistance / 15);

      sharpZone.style.left = `${(nearFrac * 100).toFixed(1)}%`;
      sharpZone.style.width = `${((farFrac - nearFrac) * 100).toFixed(1)}%`;
      focusPin.style.left = `${(focusFrac * 100).toFixed(1)}%`;
    }
  }

  // Debounced Render Loop for 60fps responsiveness
  function requestSimulatorRender() {
    if (state.simulator.renderDebounceTimer) {
      cancelAnimationFrame(state.simulator.renderDebounceTimer);
    }
    state.simulator.renderDebounceTimer = requestAnimationFrame(() => {
      const mainCanvas = document.getElementById('simCanvas');
      const curScene = SCENES[state.simulator.sceneIndex];
      renderSceneToCanvas(mainCanvas, curScene);

      // Save persistent state
      saveState();
    });
  }
  /* --------------------------------------------------------------------------
     SIMULATOR CONTROLS & INTERACTION HANDLERS
     -------------------------------------------------------------------------- */
  function setIso(iso) {
    state.simulator.iso = parseInt(iso);
    document.querySelectorAll('[data-iso]').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.iso) === state.simulator.iso);
    });
    document.getElementById('isoValBadge').textContent = `ISO ${iso}`;

    // Noise level label
    const label = document.getElementById('isoNoiseLabel');
    if (iso <= 200) {
      label.textContent = 'Minimal Noise';
      label.style.color = 'var(--accent-green)';
    } else if (iso <= 800) {
      label.textContent = 'Low Noise';
      label.style.color = 'var(--accent-gold)';
    } else if (iso <= 3200) {
      label.textContent = 'Moderate Grain';
      label.style.color = '#ff9f43';
    } else {
      label.textContent = 'Heavy Noise / Grain';
      label.style.color = 'var(--accent-red)';
    }

    markConceptMastered('iso');
    requestSimulatorRender();
  }

  function onShutterSlider(val) {
    const idx = parseInt(val);
    state.simulator.shutterIndex = idx;
    document.getElementById('shutterSlider').value = idx;
    const text = SHUTTER_SPEEDS[idx];
    document.getElementById('shutterValBadge').textContent = text;

    // Effect label
    const label = document.getElementById('shutterEffectLabel');
    if (idx <= 3) {
      label.textContent = 'Action Frozen';
      label.style.color = 'var(--accent-blue)';
    } else if (idx <= 7) {
      label.textContent = 'Action Sharp';
      label.style.color = 'var(--accent-green)';
    } else if (idx <= 11) {
      label.textContent = 'Motion Blur';
      label.style.color = 'var(--accent-gold)';
    } else {
      label.textContent = 'Light Trails';
      label.style.color = '#a29bfe';
    }

    markConceptMastered('shutter');
    requestSimulatorRender();
  }

  function setAperture(val) {
    const fNum = parseFloat(val);
    state.simulator.aperture = fNum;
    document.querySelectorAll('[data-aperture]').forEach(btn => {
      btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.aperture) - fNum) < 0.05);
    });
    document.getElementById('apertureValBadge').textContent = `f/${fNum.toFixed(1)}`;

    if (fNum <= 2.0) {
      unlockBadge('bokeh_master');
    }

    markConceptMastered('aperture');
    requestSimulatorRender();
  }

  function setWhitebalancePreset(preset) {
    state.simulator.whiteBalancePreset = preset;
    document.querySelectorAll('[data-wb]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.wb === preset);
    });

    const kelvinMap = {
      auto: 5500,
      daylight: 5500,
      cloudy: 6500,
      shade: 7500,
      tungsten: 3200,
      fluorescent: 4000
    };

    const targetK = kelvinMap[preset] || 5500;
    state.simulator.kelvin = targetK;
    document.getElementById('kelvinSlider').value = targetK;
    document.getElementById('wbValBadge').textContent = `${targetK} K`;

    markConceptMastered('wb');
    requestSimulatorRender();
  }

  function onKelvinSlider(val) {
    const k = parseInt(val);
    state.simulator.kelvin = k;
    state.simulator.whiteBalancePreset = 'custom';
    document.querySelectorAll('[data-wb]').forEach(btn => btn.classList.remove('active'));
    document.getElementById('wbValBadge').textContent = `${k} K`;

    unlockBadge('color_alchemist');
    markConceptMastered('wb');
    requestSimulatorRender();
  }

  function onFocusSlider(val) {
    const m = parseFloat(val);
    state.simulator.focusDistance = m;
    document.getElementById('focusValBadge').textContent = `${m.toFixed(1)} m`;

    markConceptMastered('focus');
    requestSimulatorRender();
  }

  function setFocalLength(mm) {
    const f = parseInt(mm);
    state.simulator.focalLength = f;
    document.querySelectorAll('[data-focal]').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.focal) === f);
    });
    document.getElementById('focalValBadge').textContent = `${f}mm`;

    markConceptMastered('lenses');
    requestSimulatorRender();
  }

  function resetSimulatorDefaults() {
    state.simulator.sceneIndex = 0;
    setIso(400);
    onShutterSlider(7); // 1/125s
    setAperture(4.0);
    setWhitebalancePreset('daylight');
    onFocusSlider(2.5);
    setFocalLength(50);
    selectScene(0);
  }

  /* --------------------------------------------------------------------------
     SCENE SELECTOR LIBRARY (12 PROCEDURAL THUMBNAILS)
     -------------------------------------------------------------------------- */
  function selectScene(index) {
    state.simulator.sceneIndex = index;
    const scene = SCENES[index];
    
    // Auto-adjust default focus to scene subject
    state.simulator.focusDistance = scene.subjectDepth;
    document.getElementById('focusSlider').value = scene.subjectDepth;
    document.getElementById('focusValBadge').textContent = `${scene.subjectDepth.toFixed(1)} m`;

    // Highlight thumbnail card
    document.querySelectorAll('.scene-thumb-card').forEach((card, idx) => {
      card.classList.toggle('active', idx === index);
    });

    requestSimulatorRender();
  }

  function renderSceneThumbnails() {
    const grid = document.getElementById('sceneThumbGrid');
    if (!grid) return;
    grid.innerHTML = '';

    SCENES.forEach((scene, index) => {
      const card = document.createElement('div');
      card.className = `scene-thumb-card ${index === state.simulator.sceneIndex ? 'active' : ''}`;
      card.onclick = () => selectScene(index);

      const canvas = document.createElement('canvas');
      canvas.className = 'scene-thumb-canvas';
      canvas.width = 140;
      canvas.height = 70;

      // Render miniature preview of scene
      const thumbCtx = canvas.getContext('2d');
      Object.keys(scene.layers).forEach(k => {
        scene.layers[k].render(thumbCtx, 140, 70, 0, 0);
      });

      const info = document.createElement('div');
      info.className = 'scene-thumb-info';
      info.innerHTML = `
        <span class="scene-thumb-name">${scene.name}</span>
        <span class="scene-thumb-ev">EV ${scene.baseEV} &bull; ${scene.baseWB}K</span>
      `;

      card.appendChild(canvas);
      card.appendChild(info);
      grid.appendChild(card);
    });
  }

  /* --------------------------------------------------------------------------
     VIEWFINDER TOOLS & SHUTTER ACTIONS
     -------------------------------------------------------------------------- */
  function toggleSimGrid() {
    state.simulator.showGrid = !state.simulator.showGrid;
    const gridOverlay = document.getElementById('simGridOverlay');
    const btn = document.getElementById('btnToggleGrid');
    if (gridOverlay) gridOverlay.classList.toggle('visible', state.simulator.showGrid);
    if (btn) btn.classList.toggle('active', state.simulator.showGrid);
  }

  function toggleClippingWarning() {
    state.simulator.showClipping = !state.simulator.showClipping;
    const btn = document.getElementById('btnToggleClipping');
    if (btn) btn.classList.toggle('active', state.simulator.showClipping);
    requestSimulatorRender();
  }

  function toggleCompareMode() {
    state.simulator.compareMode = !state.simulator.compareMode;
    const btn = document.getElementById('btnToggleCompare');
    const compContainer = document.getElementById('compareContainer');
    if (btn) btn.classList.toggle('active', state.simulator.compareMode);
    if (compContainer) compContainer.classList.toggle('active', state.simulator.compareMode);

    const canvas = document.getElementById('simCanvas');
    const scene = SCENES[state.simulator.sceneIndex];

    if (state.simulator.compareMode) {
      // Split canvas: Left half = current, Right half = optimal reference
      const w = canvas.width;
      const h = canvas.height;
      const halfW = w / 2;

      // Draw left half (current settings)
      const currentCanvas = document.createElement('canvas');
      currentCanvas.width = w;
      currentCanvas.height = h;
      renderSceneToCanvas(currentCanvas, scene);

      // Draw right half (reference)
      const refCanvas = document.createElement('canvas');
      refCanvas.width = w;
      refCanvas.height = h;
      renderSceneToCanvas(refCanvas, scene, null, true);

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(currentCanvas, 0, 0, halfW, h, 0, 0, halfW, h);
      ctx.drawImage(refCanvas, halfW, 0, halfW, h, halfW, 0, halfW, h);

      // Split line
      ctx.strokeStyle = 'var(--accent-gold)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(halfW, 0);
      ctx.lineTo(halfW, h);
      ctx.stroke();
    } else {
      requestSimulatorRender();
    }
  }

  function takePhotoSnapshot() {
    const isSlow = SHUTTER_VALUES[state.simulator.shutterIndex] > 0.3;
    playShutterSound(isSlow);

    // Visual camera flash effect
    const viewportBox = document.getElementById('viewportBox');
    if (viewportBox) {
      const flash = document.createElement('div');
      flash.style.position = 'absolute';
      flash.style.inset = '0';
      flash.style.backgroundColor = '#ffffff';
      flash.style.zIndex = '50';
      flash.style.opacity = '0.9';
      flash.style.transition = 'opacity 0.25s ease-out';
      viewportBox.appendChild(flash);
      setTimeout(() => {
        flash.style.opacity = '0';
        setTimeout(() => flash.remove(), 250);
      }, 50);
    }

    // Award XP & track stats
    addXP(25);
    state.progress.photosTaken++;
    const statShots = document.getElementById('statPhotosTaken');
    if (statShots) statShots.textContent = state.progress.photosTaken;

    unlockBadge('first_shot');
    if (SHUTTER_VALUES[state.simulator.shutterIndex] <= 1/2000) {
      unlockBadge('action_freezer');
    }

    // Copy to snapshot modal canvas
    const simCanvas = document.getElementById('simCanvas');
    const modalCanvas = document.getElementById('snapshotModalCanvas');
    if (simCanvas && modalCanvas) {
      const mCtx = modalCanvas.getContext('2d');
      mCtx.drawImage(simCanvas, 0, 0, modalCanvas.width, modalCanvas.height);
    }

    const scene = SCENES[state.simulator.sceneIndex];
    const metaRow = document.getElementById('snapshotMetadataRow');
    if (metaRow) {
      metaRow.innerHTML = `
        <span>${scene.name}</span>
        <span>f/${state.simulator.aperture.toFixed(1)} &bull; ${SHUTTER_SPEEDS[state.simulator.shutterIndex]}s &bull; ISO ${state.simulator.iso} &bull; ${state.simulator.focalLength}mm</span>
      `;
    }

    // Open modal
    document.getElementById('snapshotModal').classList.add('active');
    saveState();
  }

  function closeSnapshotModal() {
    document.getElementById('snapshotModal').classList.remove('active');
  }

  function downloadSnapshotImage() {
    const modalCanvas = document.getElementById('snapshotModalCanvas');
    if (!modalCanvas) return;
    const link = document.createElement('a');
    link.download = `phototour_${SCENES[state.simulator.sceneIndex].id}_${Date.now()}.png`;
    link.href = modalCanvas.toDataURL('image/png');
    link.click();
  }

  /* --------------------------------------------------------------------------
     GLOBAL KEYBOARD SHORTCUTS
     -------------------------------------------------------------------------- */
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore if user is inside an input or select
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        takePhotoSnapshot();
      } else if (e.key === 'ArrowRight') {
        const nextScene = (state.simulator.sceneIndex + 1) % SCENES.length;
        selectScene(nextScene);
      } else if (e.key === 'ArrowLeft') {
        const prevScene = (state.simulator.sceneIndex - 1 + SCENES.length) % SCENES.length;
        selectScene(prevScene);
      } else if (e.key === ']' || e.key === '}') {
        // Step aperture narrower
        const curIdx = APERTURE_VALUES.indexOf(state.simulator.aperture);
        if (curIdx < APERTURE_VALUES.length - 1) setAperture(APERTURE_VALUES[curIdx + 1]);
      } else if (e.key === '[' || e.key === '{') {
        // Step aperture wider
        const curIdx = APERTURE_VALUES.indexOf(state.simulator.aperture);
        if (curIdx > 0) setAperture(APERTURE_VALUES[curIdx - 1]);
      } else if (e.key === '>' || e.key === '.') {
        // Faster shutter
        if (state.simulator.shutterIndex > 0) onShutterSlider(state.simulator.shutterIndex - 1);
      } else if (e.key === '<' || e.key === ',') {
        // Slower shutter
        if (state.simulator.shutterIndex < SHUTTER_SPEEDS.length - 1) onShutterSlider(state.simulator.shutterIndex + 1);
      } else if (e.key === 'g' || e.key === 'G') {
        toggleSimGrid();
      } else if (e.key === 'z' || e.key === 'Z') {
        toggleClippingWarning();
      } else if (e.key === 'c' || e.key === 'C') {
        toggleCompareMode();
      }
    });
  }
  /* ==========================================================================
     SECTION 3: THREE.JS 3D COMPOSITION LAB & STAGING STUDIO
     ========================================================================== */
  let threeScene, threeOrbitCam, threeRenderer;
  let virtualCam, viewfinderRenderer;
  let studioPropsGroup, mannequinGroup, virtualCamVisualGroup, frustumLines;
  let studioKeyLight, studioFillLight;
  let isThreeInitialized = false;

  // Orbit control state (manual fallback controller)
  const orbitState = {
    isDragging: false,
    prevX: 0,
    prevY: 0,
    radius: 7.0,
    theta: Math.PI / 4,
    phi: Math.PI / 3,
    target: new THREE.Vector3(0, 1.3, 0)
  };

  // 12 Composition Techniques Definitions
  const COMPOSITION_TECHNIQUES = [
    {
      id: 'thirds',
      name: 'Rule of Thirds',
      category: 'Golden Standard',
      guide: 'thirds',
      params: { height: 1.5, distance: 3.2, angleDeg: 22, tiltDeg: 0, focalLength: 50 },
      desc: 'Position key visual interest (eyes, face, body) along the vertical or horizontal third gridlines, avoiding dead center to create dynamic tension.',
      when: 'Everyday portraits, environmental character shots, and storytelling.',
      tip: 'Place the subject’s leading eye at the upper-right or upper-left power intersection.'
    },
    {
      id: 'center',
      name: 'Centered / Symmetry',
      category: 'Balance & Order',
      guide: 'center',
      params: { height: 1.5, distance: 3.0, angleDeg: 0, tiltDeg: 0, focalLength: 50 },
      desc: 'Direct frontal placement commanding absolute attention and formal architectural gravity. Celebrates geometric equilibrium.',
      when: 'Formal high-fashion portraits, stark architecture, and intense emotional gaze.',
      tip: 'Ensure background elements and lighting are strictly symmetrical to maximize impact.'
    },
    {
      id: 'leading',
      name: 'Leading Lines',
      category: 'Visual Flow',
      guide: 'leading',
      params: { height: 1.2, distance: 4.2, angleDeg: -35, tiltDeg: -5, focalLength: 35 },
      desc: 'Utilizes physical room lines (window beams, floor planks, tables) to shepherd the viewer’s eye relentlessly toward the subject.',
      when: 'Indoor studio environments, alleys, bridges, and pathways.',
      tip: 'Lines starting from the bottom corners create the strongest visual entry points.'
    },
    {
      id: 'diagonal',
      name: 'Diagonal Dynamics',
      category: 'Energy & Motion',
      guide: 'diagonal',
      params: { height: 1.8, distance: 3.4, angleDeg: 38, tiltDeg: 8, focalLength: 50 },
      desc: 'Diagonal angles (Baroque and Sinister diagonals) evoke movement, urgency, and dramatic cinematic power compared to static horizontals.',
      when: 'Action staging, expressive dance, and fashion editorials.',
      tip: 'Align the subject’s limbs or gaze along the 45-degree harmonic diagonal.'
    },
    {
      id: 'frame',
      name: 'Frame Within a Frame',
      category: 'Depth Staging',
      guide: 'frame',
      params: { height: 1.4, distance: 4.8, angleDeg: -18, tiltDeg: 2, focalLength: 85 },
      desc: 'Uses studio window frames, doorways, or flora to create a secondary optical border that confines and isolates the subject.',
      when: 'Adding depth layers and contextual mystery to an interior shot.',
      tip: 'Keep the outer framing element darker or slightly out of focus to draw eyes inward.'
    },
    {
      id: 'layering',
      name: 'Foreground Layering',
      category: 'Three-Dimensionality',
      guide: 'thirds',
      params: { height: 1.1, distance: 2.8, angleDeg: 30, tiltDeg: -4, focalLength: 85 },
      desc: 'Stages props (plants, glassware, lamps) in the immediate foreground, shooting past them to create rich 3D layers of foreground, subject, and background.',
      when: 'Overcoming flat 2D camera perception and adding environmental context.',
      tip: 'Use a wide aperture (f/2.0) to blur the foreground prop into an atmospheric bokeh haze.'
    },
    {
      id: 'negative_space',
      name: 'Negative Space',
      category: 'Minimalism & Mood',
      guide: 'thirds',
      params: { height: 1.6, distance: 5.5, angleDeg: -45, tiltDeg: 5, focalLength: 35 },
      desc: 'Allows expansive, uncluttered studio backdrop to engulf a solitary, small subject, communicating contemplation, serenity, or isolation.',
      when: 'Editorial conceptual covers, luxury fashion, and emotional solitude.',
      tip: 'Ensure the subject looks INTO the vast open negative space, not out of the frame.'
    },
    {
      id: 'golden_ratio',
      name: 'Golden Spiral (Phi)',
      category: 'Divine Harmony',
      guide: 'golden',
      params: { height: 1.45, distance: 3.5, angleDeg: 26, tiltDeg: -2, focalLength: 50 },
      desc: 'Based on the Fibonacci logarithmic spiral (1:1.618), this guides the eye along an organic sweeping curve into the focal nucleus.',
      when: 'Artistic fine-art portraiture, organic poses, and sweeping curves.',
      tip: 'Pose the subject’s curved spine or arm along the outer sweeping curve of the spiral.'
    },
    {
      id: 'low_angle',
      name: 'Low Angle (Heroic)',
      category: 'Dominance & Scale',
      guide: 'center',
      params: { height: 0.4, distance: 2.2, angleDeg: 5, tiltDeg: 22, focalLength: 24 },
      desc: 'Shooting from low near the floor looking upward exaggerates subject stature, conveying authority, elegance, or monumental power.',
      when: 'Hero portraits, architectural fashion, and empowering characters.',
      tip: 'Pair with a wide-angle 24mm lens to heighten upward vertical perspective stretching.'
    },
    {
      id: 'high_angle',
      name: 'High Angle (Bird’s Eye)',
      category: 'Overview & Intimacy',
      guide: 'center',
      params: { height: 2.8, distance: 2.6, angleDeg: 0, tiltDeg: -28, focalLength: 50 },
      desc: 'Shooting downwards from elevated height renders the subject approachable, compact, or vulnerable while showcasing floor geometry.',
      when: 'Seated poses, lifestyle intimacy, and overhead creative staging.',
      tip: 'Have the model tilt their chin up toward the lens to catch flattering key light in their eyes.'
    },
    {
      id: 'fill_frame',
      name: 'Fill the Frame',
      category: 'Intense Impact',
      guide: 'thirds',
      params: { height: 1.5, distance: 1.4, angleDeg: 10, tiltDeg: 0, focalLength: 85 },
      desc: 'Eliminates all surrounding environment, packing the frame edge-to-edge with pure facial expression, texture, and emotion.',
      when: 'Intimate character headshots and fine-art detail photography.',
      tip: 'Use an 85mm portrait telephoto to avoid bulbous wide-angle nose distortion.'
    },
    {
      id: 'eye_direction',
      name: 'Rule of Space (Looking Room)',
      category: 'Psychological Gaze',
      guide: 'thirds',
      params: { height: 1.5, distance: 3.0, angleDeg: -25, tiltDeg: 0, focalLength: 50 },
      desc: 'Gives ample breathing room in the direction the subject is gazing. Looking into open space invites viewers to imagine what they are seeing.',
      when: 'Narrative storytelling, introspective portraits, and cinematic stills.',
      tip: 'Position the subject on the left third if they are looking toward the right.'
    }
  ];

  function initThreeJsStudio() {
    if (isThreeInitialized) return;
    const canvas = document.getElementById('threeCanvas');
    const vfCanvas = document.getElementById('cameraViewfinderCanvas');
    if (!canvas || !vfCanvas || typeof THREE === 'undefined') return;

    // 1. Scene & Renderers
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x0a0a0f);

    // Main 3D Orbit Viewport Renderer
    threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    threeRenderer.setSize(canvas.clientWidth, canvas.clientHeight);
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    threeRenderer.shadowMap.enabled = true;
    threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Secondary Viewfinder Projection Renderer
    viewfinderRenderer = new THREE.WebGLRenderer({ canvas: vfCanvas, antialias: true });
    viewfinderRenderer.setSize(vfCanvas.clientWidth, vfCanvas.clientHeight);
    viewfinderRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    viewfinderRenderer.shadowMap.enabled = true;

    // 2. Cameras
    // Orbit camera for inspecting the studio
    threeOrbitCam = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 50);
    updateOrbitCameraPosition();

    // Virtual Camera (the camera inside the studio that takes the shot!)
    virtualCam = new THREE.PerspectiveCamera(40, vfCanvas.clientWidth / vfCanvas.clientHeight, 0.1, 50);
    updateVirtualCameraPosition();

    // 3. Studio Lighting Setup
    const ambientLight = new THREE.AmbientLight(0x222233, 1.2);
    threeScene.add(ambientLight);

    // Warm Key Light (Softbox)
    studioKeyLight = new THREE.DirectionalLight(0xfff1d6, 2.2);
    studioKeyLight.position.set(3, 4, 3);
    studioKeyLight.castShadow = true;
    studioKeyLight.shadow.mapSize.width = 1024;
    studioKeyLight.shadow.mapSize.height = 1024;
    studioKeyLight.shadow.bias = -0.001;
    threeScene.add(studioKeyLight);

    // Cool Rim / Hair Light
    studioFillLight = new THREE.DirectionalLight(0x8ec2ff, 1.4);
    studioFillLight.position.set(-3.5, 3.2, -2.5);
    threeScene.add(studioFillLight);

    // 4. Studio Environment & Cyclorama Wall
    const floorGeo = new THREE.PlaneGeometry(16, 16);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x14141e,
      roughness: 0.4,
      metalness: 0.2
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    threeScene.add(floor);

    // Floor Grid Texture lines
    const gridHelper = new THREE.GridHelper(16, 32, 0xe8a030, 0x222235);
    gridHelper.position.y = 0.01;
    threeScene.add(gridHelper);

    // Curved cyclorama back wall
    const wallGeo = new THREE.CylinderGeometry(8, 8, 8, 32, 1, true, -Math.PI / 2, Math.PI);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x181826,
      roughness: 0.85,
      side: THREE.BackSide
    });
    const backWall = new THREE.Mesh(wallGeo, wallMat);
    backWall.position.set(0, 4, 0);
    threeScene.add(backWall);

    // 5. Stylized Mannequin Subject
    mannequinGroup = new THREE.Group();

    const skinMat = new THREE.MeshStandardMaterial({ color: 0xdca685, roughness: 0.6 });
    const clothesMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.9 });

    // Torso / Chest
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.65, 0.28), clothesMat);
    torso.position.y = 1.25;
    torso.castShadow = true;
    mannequinGroup.add(torso);

    // Hips / Waist
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.35, 0.26), clothesMat);
    hips.position.y = 0.85;
    hips.castShadow = true;
    mannequinGroup.add(hips);

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 24), skinMat);
    head.position.y = 1.75;
    head.castShadow = true;
    mannequinGroup.add(head);

    // Hair cap
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 16), hairMat);
    hair.position.set(0, 1.8, -0.02);
    mannequinGroup.add(hair);

    // Limbs (Arms & Legs in natural fashion pose)
    // Left Leg
    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.85, 12), clothesMat);
    legL.position.set(-0.16, 0.42, 0);
    legL.castShadow = true;
    mannequinGroup.add(legL);

    // Right Leg
    const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.85, 12), clothesMat);
    legR.position.set(0.16, 0.42, 0.05);
    legR.rotation.x = -0.08;
    legR.castShadow = true;
    mannequinGroup.add(legR);

    // Left Arm (bent gracefully on hip)
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.65, 12), skinMat);
    armL.position.set(-0.35, 1.15, 0.05);
    armL.rotation.z = -0.35;
    armL.castShadow = true;
    mannequinGroup.add(armL);

    // Right Arm
    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.65, 12), skinMat);
    armR.position.set(0.35, 1.15, 0);
    armR.rotation.z = 0.25;
    armR.castShadow = true;
    mannequinGroup.add(armR);

    threeScene.add(mannequinGroup);

    // 6. Studio Props (Pedestal Table, Plant, Window Frame)
    studioPropsGroup = new THREE.Group();

    // Pedestal table
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x3d271d, roughness: 0.5 });
    const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24), tableMat);
    tableTop.position.set(1.4, 0.75, 0.2);
    tableTop.castShadow = true;
    studioPropsGroup.add(tableTop);

    const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.75, 12), tableMat);
    tableLeg.position.set(1.4, 0.38, 0.2);
    studioPropsGroup.add(tableLeg);

    // Ceramic vase on table
    const vaseMat = new THREE.MeshStandardMaterial({ color: 0xe8a030, roughness: 0.3, metalness: 0.4 });
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.28, 16), vaseMat);
    vase.position.set(1.4, 0.92, 0.2);
    vase.castShadow = true;
    studioPropsGroup.add(vase);

    // Potted House Plant
    const potMat = new THREE.MeshStandardMaterial({ color: 0x8a9ba8, roughness: 0.6 });
    const plantPot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.18, 0.42, 16), potMat);
    plantPot.position.set(-1.6, 0.21, 0.3);
    plantPot.castShadow = true;
    studioPropsGroup.add(plantPot);

    const leafMat = new THREE.MeshStandardMaterial({ color: 0x27ae60, roughness: 0.5 });
    for (let l = 0; l < 7; l++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), leafMat);
      const angle = (l / 7) * Math.PI * 2;
      leaf.position.set(-1.6 + Math.cos(angle) * 0.22, 0.45 + (l % 3) * 0.1, 0.3 + Math.sin(angle) * 0.22);
      leaf.scale.set(1.4, 0.3, 0.7);
      leaf.castShadow = true;
      studioPropsGroup.add(leaf);
    }

    // Studio Window Frame casting light shadows
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3e });
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 1.4), windowMat);
    winFrame.position.set(3.8, 2.2, 1.5);
    studioPropsGroup.add(winFrame);

    threeScene.add(studioPropsGroup);

    // 7. Virtual Camera 3D Representation in the studio
    virtualCamVisualGroup = new THREE.Group();

    // Camera body mesh
    const camBodyMat = new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.3, metalness: 0.8 });
    const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.14), camBodyMat);
    virtualCamVisualGroup.add(camBody);

    // Lens cylinder
    const camLensMat = new THREE.MeshStandardMaterial({ color: 0x222230, metalness: 0.9, roughness: 0.2 });
    const camLens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.18, 16), camLensMat);
    camLens.rotation.x = Math.PI / 2;
    camLens.position.z = 0.14;
    virtualCamVisualGroup.add(camLens);

    // Gold accent ring on lens
    const goldRing = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.02, 16), new THREE.MeshBasicMaterial({ color: 0xe8a030 }));
    goldRing.rotation.x = Math.PI / 2;
    goldRing.position.z = 0.18;
    virtualCamVisualGroup.add(goldRing);

    // Wireframe Frustum Pyramid
    const frustumGeo = new THREE.ConeGeometry(0.9, 2.2, 4, 1, true);
    frustumGeo.rotateX(-Math.PI / 2);
    const frustumMat = new THREE.MeshBasicMaterial({ color: 0xe8a030, wireframe: true, transparent: true, opacity: 0.5 });
    frustumLines = new THREE.Mesh(frustumGeo, frustumMat);
    frustumLines.position.z = 1.1;
    virtualCamVisualGroup.add(frustumLines);

    threeScene.add(virtualCamVisualGroup);

    // 8. Event Listeners for Orbit Interaction
    setupOrbitControls(canvas);

    // 9. Start Render Loop
    isThreeInitialized = true;
    render3DLoop();

    // Render 12 techniques UI cards & guide overlay
    renderTechniquesGrid();
    renderCompositionGuideOverlay();
    selectTechnique(0);
  }

  function setupOrbitControls(canvas) {
    canvas.addEventListener('mousedown', (e) => {
      orbitState.isDragging = true;
      orbitState.prevX = e.clientX;
      orbitState.prevY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!orbitState.isDragging) return;
      const dx = e.clientX - orbitState.prevX;
      const dy = e.clientY - orbitState.prevY;
      orbitState.prevX = e.clientX;
      orbitState.prevY = e.clientY;

      orbitState.theta -= dx * 0.008;
      orbitState.phi -= dy * 0.008;
      // Clamp elevation
      orbitState.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, orbitState.phi));
      updateOrbitCameraPosition();
    });

    window.addEventListener('mouseup', () => orbitState.isDragging = false);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbitState.radius += e.deltaY * 0.005;
      orbitState.radius = Math.max(2.5, Math.min(14.0, orbitState.radius));
      updateOrbitCameraPosition();
    }, { passive: false });

    // Touch support for mobile
    let prevTouchX = 0, prevTouchY = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        orbitState.isDragging = true;
        prevTouchX = e.touches[0].clientX;
        prevTouchY = e.touches[0].clientY;
      }
    });

    canvas.addEventListener('touchmove', (e) => {
      if (!orbitState.isDragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - prevTouchX;
      const dy = e.touches[0].clientY - prevTouchY;
      prevTouchX = e.touches[0].clientX;
      prevTouchY = e.touches[0].clientY;

      orbitState.theta -= dx * 0.01;
      orbitState.phi -= dy * 0.01;
      orbitState.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, orbitState.phi));
      updateOrbitCameraPosition();
    });

    canvas.addEventListener('touchend', () => orbitState.isDragging = false);
  }

  function updateOrbitCameraPosition() {
    if (!threeOrbitCam) return;
    const x = orbitState.radius * Math.sin(orbitState.phi) * Math.sin(orbitState.theta);
    const y = orbitState.radius * Math.cos(orbitState.phi);
    const z = orbitState.radius * Math.sin(orbitState.phi) * Math.cos(orbitState.theta);

    threeOrbitCam.position.set(x, y + orbitState.target.y, z);
    threeOrbitCam.lookAt(orbitState.target);
  }

  function updateVirtualCameraPosition() {
    if (!virtualCam || !virtualCamVisualGroup) return;

    const angleRad = (state.composition3D.angleDeg * Math.PI) / 180;
    const tiltRad = (state.composition3D.tiltDeg * Math.PI) / 180;
    const dist = state.composition3D.distance;
    const h = state.composition3D.height;

    // Subject target center
    const targetY = 1.35;
    const camX = dist * Math.sin(angleRad);
    const camZ = dist * Math.cos(angleRad);

    virtualCam.position.set(camX, h, camZ);
    virtualCam.fov = focalLengthToFOV(state.composition3D.focalLength);
    virtualCam.updateProjectionMatrix();

    // Look at subject with tilt offset
    const lookTarget = new THREE.Vector3(0, targetY + Math.tan(tiltRad) * dist, 0);
    virtualCam.lookAt(lookTarget);

    // Update the visual camera model in the 3D scene
    virtualCamVisualGroup.position.copy(virtualCam.position);
    virtualCamVisualGroup.quaternion.copy(virtualCam.quaternion);

    // Scale frustum wireframe with FOV
    if (frustumLines) {
      const fovScale = Math.tan((virtualCam.fov * Math.PI) / 360) * 2;
      frustumLines.scale.set(fovScale, fovScale, 1);
    }

    const fovInd = document.getElementById('threeFovIndicator');
    if (fovInd) fovInd.textContent = `FOV: ${virtualCam.fov.toFixed(0)}° (${state.composition3D.focalLength}mm)`;
  }

  function focalLengthToFOV(mm) {
    // 35mm full frame sensor height = 24mm
    // fov = 2 * atan(sensorHeight / (2 * focalLength))
    return (2 * Math.atan(24 / (2 * mm)) * 180) / Math.PI;
  }

  function render3DLoop() {
    requestAnimationFrame(render3DLoop);
    if (!isThreeInitialized) return;

    // Render overview orbit camera
    threeRenderer.render(threeScene, threeOrbitCam);

    // Temporarily hide the virtual camera mesh so it doesn't block its own lens!
    virtualCamVisualGroup.visible = false;
    viewfinderRenderer.render(threeScene, virtualCam);
    virtualCamVisualGroup.visible = true;
  }

  /* --------------------------------------------------------------------------
     COMPOSITION RIG CONTROLS & ANIMATIONS
     -------------------------------------------------------------------------- */
  function onCamHeightSlider(val) {
    state.composition3D.height = parseFloat(val);
    document.getElementById('camHeightBadge').textContent = `${val}m`;
    updateVirtualCameraPosition();
  }

  function onCamDistSlider(val) {
    state.composition3D.distance = parseFloat(val);
    document.getElementById('camDistBadge').textContent = `${val}m`;
    updateVirtualCameraPosition();
  }

  function onCamAngleSlider(val) {
    state.composition3D.angleDeg = parseInt(val);
    document.getElementById('camAngleBadge').textContent = `${val}°`;
    updateVirtualCameraPosition();
  }

  function onCamTiltSlider(val) {
    state.composition3D.tiltDeg = parseInt(val);
    document.getElementById('camTiltBadge').textContent = `${val}°`;
    updateVirtualCameraPosition();
  }

  function setCompFocal(mm) {
    state.composition3D.focalLength = parseInt(mm);
    document.querySelectorAll('[data-compfocal]').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.compfocal) === mm);
    });
    document.getElementById('compFocalBadge').textContent = `${mm}mm`;
    updateVirtualCameraPosition();
  }

  function toggleStudioLighting() {
    state.composition3D.studioLight = !state.composition3D.studioLight;
    if (studioKeyLight) studioKeyLight.intensity = state.composition3D.studioLight ? 2.2 : 0.4;
    if (studioFillLight) studioFillLight.intensity = state.composition3D.studioLight ? 1.4 : 0.2;
  }

  function resetThreeCamera() {
    orbitState.radius = 7.0;
    orbitState.theta = Math.PI / 4;
    orbitState.phi = Math.PI / 3;
    updateOrbitCameraPosition();
  }

  /* --------------------------------------------------------------------------
     12 COMPOSITION TECHNIQUES UI & INTERACTIVE SELECTION
     -------------------------------------------------------------------------- */
  function renderTechniquesGrid() {
    const grid = document.getElementById('techniquesGrid');
    if (!grid) return;
    grid.innerHTML = '';

    COMPOSITION_TECHNIQUES.forEach((tech, idx) => {
      const card = document.createElement('div');
      card.className = `tech-card ${idx === state.composition3D.activeTechniqueIndex ? 'active' : ''}`;
      card.onclick = () => selectTechnique(idx);

      card.innerHTML = `
        <div class="tech-card-header">
          <span class="tech-num">#${idx + 1 < 10 ? '0' + (idx + 1) : idx + 1}</span>
          <h4>${tech.name}</h4>
        </div>
        <p>${tech.desc.slice(0, 75)}...</p>
        <span class="tech-tag">${tech.category}</span>
      `;

      grid.appendChild(card);
    });
  }

  function selectTechnique(idx) {
    state.composition3D.activeTechniqueIndex = idx;
    const tech = COMPOSITION_TECHNIQUES[idx];

    // Highlight card
    document.querySelectorAll('.tech-card').forEach((c, i) => c.classList.toggle('active', i === idx));

    // Update Detail Card
    const detail = document.getElementById('techDetailCard');
    if (detail) {
      detail.classList.add('active');
      document.getElementById('detailTechCategory').textContent = tech.category;
      document.getElementById('detailTechTitle').textContent = `${idx + 1}. ${tech.name}`;
      document.getElementById('detailTechDesc').textContent = tech.desc;
      document.getElementById('detailTechWhen').textContent = tech.when;
      document.getElementById('detailTechTip').textContent = tech.tip;
    }

    // Apply camera positioning
    applyActiveTechniqueCamera();
    toggleCompGuide(tech.guide);

    markConceptMastered('composition');
    unlockBadge('composition_master');
  }

  function applyActiveTechniqueCamera() {
    const tech = COMPOSITION_TECHNIQUES[state.composition3D.activeTechniqueIndex];
    if (!tech) return;

    // Smooth animation / lerp to target parameters
    const p = tech.params;
    state.composition3D.height = p.height;
    state.composition3D.distance = p.distance;
    state.composition3D.angleDeg = p.angleDeg;
    state.composition3D.tiltDeg = p.tiltDeg;
    state.composition3D.focalLength = p.focalLength;

    // Update UI Sliders
    document.getElementById('camHeightSlider').value = p.height;
    document.getElementById('camHeightBadge').textContent = `${p.height}m`;

    document.getElementById('camDistSlider').value = p.distance;
    document.getElementById('camDistBadge').textContent = `${p.distance}m`;

    document.getElementById('camAngleSlider').value = p.angleDeg;
    document.getElementById('camAngleBadge').textContent = `${p.angleDeg}°`;

    document.getElementById('camTiltSlider').value = p.tiltDeg;
    document.getElementById('camTiltBadge').textContent = `${p.tiltDeg}°`;

    setCompFocal(p.focalLength);
    updateVirtualCameraPosition();
  }

  /* --------------------------------------------------------------------------
     COMPOSITION GUIDE SVG OVERLAYS
     Rule of Thirds, Golden Ratio Spiral, Center Cross, Diagonals, Framing, Leading Lines
     -------------------------------------------------------------------------- */
  function toggleCompGuide(guideName) {
    state.composition3D.activeGuide = guideName;
    document.querySelectorAll('.guide-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.guide === guideName);
    });
    renderCompositionGuideOverlay();
  }

  function renderCompositionGuideOverlay() {
    const svg = document.getElementById('compositionGuideSvg');
    if (!svg) return;
    svg.innerHTML = '';
    const g = state.composition3D.activeGuide;

    const strokeColor = '#e8a030';
    const strokeDim = 'rgba(232, 160, 48, 0.4)';
    const w = 360;
    const h = 240;

    if (g === 'thirds') {
      // 3x3 Grid with Intersection Power Points
      svg.innerHTML = `
        <line x1="${w / 3}" y1="0" x2="${w / 3}" y2="${h}" stroke="${strokeDim}" stroke-width="1.5" />
        <line x1="${(w * 2) / 3}" y1="0" x2="${(w * 2) / 3}" y2="${h}" stroke="${strokeDim}" stroke-width="1.5" />
        <line x1="0" y1="${h / 3}" x2="${w}" y2="${h / 3}" stroke="${strokeDim}" stroke-width="1.5" />
        <line x1="0" y1="${(h * 2) / 3}" x2="${w}" y2="${(h * 2) / 3}" stroke="${strokeDim}" stroke-width="1.5" />
        <!-- 4 Intersection Power Circles -->
        <circle cx="${w / 3}" cy="${h / 3}" r="7" fill="none" stroke="${strokeColor}" stroke-width="2" />
        <circle cx="${(w * 2) / 3}" cy="${h / 3}" r="7" fill="none" stroke="${strokeColor}" stroke-width="2" />
        <circle cx="${w / 3}" cy="${(h * 2) / 3}" r="7" fill="none" stroke="${strokeColor}" stroke-width="2" />
        <circle cx="${(w * 2) / 3}" cy="${(h * 2) / 3}" r="7" fill="none" stroke="${strokeColor}" stroke-width="2" />
      `;
    } else if (g === 'golden') {
      // Golden Spiral logarithmic arc
      svg.innerHTML = `
        <!-- Golden Rectangle subdivisions -->
        <rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${strokeDim}" stroke-width="1" />
        <line x1="${w * 0.618}" y1="0" x2="${w * 0.618}" y2="${h}" stroke="${strokeDim}" stroke-width="1" stroke-dasharray="3" />
        <line x1="${w * 0.618}" y1="${h * 0.618}" x2="${w}" y2="${h * 0.618}" stroke="${strokeDim}" stroke-width="1" stroke-dasharray="3" />
        <!-- Logarithmic Golden Spiral Path -->
        <path d="M 0 ${h} A ${w * 0.618} ${h} 0 0 1 ${w * 0.618} 0 A ${w * 0.382} ${h * 0.618} 0 0 1 ${w} ${h * 0.618} A ${w * 0.236} ${h * 0.382} 0 0 1 ${w * 0.764} ${h} A ${w * 0.146} ${h * 0.236} 0 0 1 ${w * 0.618} ${h * 0.764}" fill="none" stroke="${strokeColor}" stroke-width="2.5" />
      `;
    } else if (g === 'center') {
      // Symmetrical Crosshairs & Center Ring
      svg.innerHTML = `
        <line x1="${w / 2}" y1="0" x2="${w / 2}" y2="${h}" stroke="${strokeColor}" stroke-width="1.5" stroke-dasharray="4" />
        <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${strokeColor}" stroke-width="1.5" stroke-dasharray="4" />
        <circle cx="${w / 2}" cy="${h / 2}" r="32" fill="none" stroke="${strokeColor}" stroke-width="2" />
        <circle cx="${w / 2}" cy="${h / 2}" r="3" fill="${strokeColor}" />
      `;
    } else if (g === 'diagonal') {
      // Baroque and Sinister Harmonic Diagonals
      svg.innerHTML = `
        <line x1="0" y1="0" x2="${w}" y2="${h}" stroke="${strokeColor}" stroke-width="1.5" />
        <line x1="0" y1="${h}" x2="${w}" y2="0" stroke="${strokeColor}" stroke-width="1.5" />
        <line x1="0" y1="${h / 2}" x2="${w / 2}" y2="0" stroke="${strokeDim}" stroke-width="1" stroke-dasharray="3" />
        <line x1="${w / 2}" y1="${h}" x2="${w}" y2="${h / 2}" stroke="${strokeDim}" stroke-width="1" stroke-dasharray="3" />
      `;
    } else if (g === 'frame') {
      // Inner Frame Vignette Guide
      svg.innerHTML = `
        <rect x="36" y="24" width="${w - 72}" height="${h - 48}" fill="none" stroke="${strokeColor}" stroke-width="2" rx="8" />
        <rect x="54" y="36" width="${w - 108}" height="${h - 72}" fill="none" stroke="${strokeDim}" stroke-width="1" stroke-dasharray="4" rx="4" />
      `;
    } else if (g === 'leading') {
      // Vanishing Point Leading Convergence Lines
      svg.innerHTML = `
        <line x1="0" y1="${h}" x2="${w * 0.45}" y2="${h * 0.45}" stroke="${strokeColor}" stroke-width="2" />
        <line x1="${w * 0.2}" y1="${h}" x2="${w * 0.45}" y2="${h * 0.45}" stroke="${strokeDim}" stroke-width="1.5" />
        <line x1="${w}" y1="${h}" x2="${w * 0.55}" y2="${h * 0.45}" stroke="${strokeColor}" stroke-width="2" />
        <line x1="${w * 0.8}" y1="${h}" x2="${w * 0.55}" y2="${h * 0.45}" stroke="${strokeDim}" stroke-width="1.5" />
        <circle cx="${w * 0.5}" cy="${h * 0.45}" r="8" fill="none" stroke="${strokeColor}" stroke-width="2" />
      `;
    }
  }
  /* ==========================================================================
     SECTION 4: 10 PRACTICE CHALLENGES ENGINE
     ========================================================================== */
  const CHALLENGES_DATA = [
    {
      id: 0,
      title: 'Freeze the Action',
      sceneId: 'moving_vehicle',
      difficulty: 'Beginner',
      story: 'A red sports coupe is tearing down the highway at 80mph. Freeze the vehicle so the wheels and bodywork are razor-sharp with zero motion blur.',
      goalText: 'Select a shutter speed of 1/500s or faster to freeze rapid high-speed vehicular motion, while keeping exposure balanced.',
      defaultSettings: { iso: 400, shutterIndex: 7, aperture: 4.0, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Shutter speed 1/500s or faster (Freeze motion)', check: (s) => s.shutterSeconds <= 1/500 },
        { label: 'Exposure balanced (within ±1.0 EV)', check: (s, ev) => Math.abs(ev) <= 1.0 },
        { label: 'ISO ≤ 1600 (Clean noise profile)', check: (s) => s.iso <= 1600 }
      ],
      explanation: 'Fast moving objects require 1/500s or faster (such as 1/1000s or 1/2000s) to overcome motion blur. Compensate by opening the aperture or raising ISO moderately.'
    },
    {
      id: 1,
      title: 'Dreamy Portrait Bokeh',
      sceneId: 'portrait_daylight',
      difficulty: 'Beginner',
      story: 'Create an intimate outdoor portrait in a sunlit garden with dramatic background separation and soft circular bokeh.',
      goalText: 'Select a wide aperture (f/2.8 or wider) to isolate the subject from the busy foliage behind them.',
      defaultSettings: { iso: 400, shutterIndex: 7, aperture: 8.0, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Aperture f/2.8 or wider (f/1.4 - f/2.8)', check: (s) => s.aperture <= 2.8 },
        { label: 'Exposure balanced (within ±0.8 EV)', check: (s, ev) => Math.abs(ev) <= 0.8 },
        { label: 'Low ISO (≤ 400 for maximum portrait clarity)', check: (s) => s.iso <= 400 }
      ],
      explanation: 'A wide aperture creates a shallow depth of field, blurring distracting background elements into creamy bokeh circles and making your subject pop.'
    },
    {
      id: 2,
      title: 'Landscape Edge-to-Edge Sharpness',
      sceneId: 'mountain_landscape',
      difficulty: 'Intermediate',
      story: 'You are overlooking an alpine lake with jagged snowy peaks. Ensure both the foreground rocks and distant glaciers are pin-sharp.',
      goalText: 'Choose the optical "sweet spot" aperture (f/8 - f/16) with low ISO to achieve maximum edge-to-edge depth of field.',
      defaultSettings: { iso: 400, shutterIndex: 7, aperture: 2.8, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Aperture set to sweet spot (f/8.0 to f/16)', check: (s) => s.aperture >= 8.0 && s.aperture <= 16.0 },
        { label: 'ISO ≤ 400 (Pristine dynamic range)', check: (s) => s.iso <= 400 },
        { label: 'Balanced exposure without blown snow highlights', check: (s, ev) => Math.abs(ev) <= 0.8 }
      ],
      explanation: 'Small apertures like f/8 or f/11 provide extensive depth of field, keeping both near foreground rocks and distant horizon mountains in focus.'
    },
    {
      id: 3,
      title: 'Night City Without Grain',
      sceneId: 'night_city',
      difficulty: 'Intermediate',
      story: 'Photograph a dazzling metropolitan skyline after dark. Reveal the glowing skyscraper windows and bridge reflections without destroying the image with noisy grain.',
      goalText: 'Balance night exposure using a longer shutter speed rather than cranking ISO to extreme noisy values.',
      defaultSettings: { iso: 12800, shutterIndex: 6, aperture: 4.0, kelvin: 4000, focalLength: 50 },
      criteria: [
        { label: 'ISO kept at 1600 or below (Low noise)', check: (s) => s.iso <= 1600 },
        { label: 'Shutter speed 1s or slower (Long exposure)', check: (s) => s.shutterSeconds >= 1.0 },
        { label: 'Exposure within ±1.0 EV', check: (s, ev) => Math.abs(ev) <= 1.0 }
      ],
      explanation: 'Night scenes have very low ambient light (EV 3-4). Cranking ISO to 12800 causes heavy grain. Instead, stabilizing the camera and using a 1-4 second shutter gathers pristine light cleanly.'
    },
    {
      id: 4,
      title: 'Silky Waterfall Cascade',
      sceneId: 'waterfall',
      difficulty: 'Intermediate',
      story: 'Capture a tranquil forest waterfall so the tumbling water renders as a continuous, ethereal silky veil.',
      goalText: 'Use a slow shutter speed (1/4s or slower) while avoiding overexposure by stepping down your aperture.',
      defaultSettings: { iso: 100, shutterIndex: 4, aperture: 4.0, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Shutter speed 1/4s or slower (0.25s - 4s)', check: (s) => s.shutterSeconds >= 0.25 },
        { label: 'Aperture f/8 or narrower to avoid blowing out highlights', check: (s) => s.aperture >= 8.0 },
        { label: 'Balanced exposure (within ±0.8 EV)', check: (s, ev) => Math.abs(ev) <= 0.8 }
      ],
      explanation: 'Water cascading at high speed blurs into a silky smooth texture when exposed for 1/4 second or longer. Stepping down to f/11-f/16 prevents the daylight from overexposing the sensor.'
    },
    {
      id: 5,
      title: 'Correct Warm White Balance',
      sceneId: 'indoor_warm',
      difficulty: 'Beginner',
      story: 'An indoor room lit by cozy incandescent tungsten lamps looks unnaturally orange on standard daylight camera settings. Neutralize the color cast.',
      goalText: 'Set White Balance to Tungsten (3200K) so the walls and furniture appear true to life.',
      defaultSettings: { iso: 400, shutterIndex: 7, aperture: 4.0, kelvin: 6500, focalLength: 50 },
      criteria: [
        { label: 'White Balance set to Tungsten / 3200K (±300K)', check: (s) => Math.abs(s.kelvin - 3200) <= 300 },
        { label: 'Exposure balanced (within ±1.0 EV)', check: (s, ev) => Math.abs(ev) <= 1.0 }
      ],
      explanation: 'Tungsten lamps emit heavily warm 3000K-3200K light. By matching your camera white balance to 3200K, the camera introduces a cool blue counter-shift, restoring clean neutral whites.'
    },
    {
      id: 6,
      title: 'Flattering Portrait Compression',
      sceneId: 'portrait_distant',
      difficulty: 'Intermediate',
      story: 'You are photographing a traveler with mountains in the background. Choose a focal length that avoids wide-angle facial distortion and brings the background mountains closer.',
      goalText: 'Choose an 85mm or longer telephoto focal length to achieve pleasing optical compression.',
      defaultSettings: { iso: 400, shutterIndex: 7, aperture: 4.0, kelvin: 5500, focalLength: 24 },
      criteria: [
        { label: 'Focal length 85mm or longer (Telephoto compression)', check: (s) => s.focalLength >= 85 },
        { label: 'Aperture f/4 or wider (Subject separation)', check: (s) => s.aperture <= 4.0 },
        { label: 'Exposure balanced (within ±0.8 EV)', check: (s, ev) => Math.abs(ev) <= 0.8 }
      ],
      explanation: 'Telephoto lenses (85mm, 135mm, 200mm) flatten perspective, eliminating the bulbous nose distortion caused by wide lenses while pulling the distant background closer to the subject.'
    },
    {
      id: 7,
      title: 'Moody Low-Light Balancing Act',
      sceneId: 'lowlight_indoor',
      difficulty: 'Advanced',
      story: 'A rustic cellar illuminated solely by a single candle (EV 2.0). Achieve a readable, atmospheric exposure without blowing out the flame.',
      goalText: 'Harmonize a wide aperture, manageable ISO, and steady shutter to expose this challenging dimly lit scene.',
      defaultSettings: { iso: 100, shutterIndex: 5, aperture: 8.0, kelvin: 2400, focalLength: 50 },
      criteria: [
        { label: 'Wide aperture (f/1.4 - f/2.8) to maximize light intake', check: (s) => s.aperture <= 2.8 },
        { label: 'Shutter 1/15s - 1/2s (Tripod low light)', check: (s) => s.shutterSeconds >= 1/15 && s.shutterSeconds <= 1.0 },
        { label: 'ISO between 800 and 3200', check: (s) => s.iso >= 800 && s.iso <= 3200 },
        { label: 'Exposure balanced (within ±0.6 EV)', check: (s, ev) => Math.abs(ev) <= 0.6 }
      ],
      explanation: 'In extreme low light, every optical element must contribute: an ultra-wide aperture (f/1.4-f/2.0) lets in maximum physical photons, while moderate ISO (1600) boosts sensor gain cleanly.'
    },
    {
      id: 8,
      title: 'Freeze Wildlife in Flight',
      sceneId: 'wildlife_birds',
      difficulty: 'Advanced',
      story: 'A hawk is banking in mid-air with rapid wing beats. Freeze every primary feather in mid-flight with zero motion blur.',
      goalText: 'Use an ultra-fast shutter (1/1000s or faster) and compensate with adequate light gathering.',
      defaultSettings: { iso: 100, shutterIndex: 7, aperture: 8.0, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Ultra-fast shutter 1/1000s or 1/2000s', check: (s) => s.shutterSeconds <= 1/1000 },
        { label: 'Aperture f/2.8 - f/5.6 for sharp plumage', check: (s) => s.aperture <= 5.6 },
        { label: 'Exposure balanced (within ±0.8 EV)', check: (s, ev) => Math.abs(ev) <= 0.8 }
      ],
      explanation: 'Birds in flight flap their wings at tremendous speed. 1/1000s to 1/2000s is mandatory to eliminate wing blur completely.'
    },
    {
      id: 9,
      title: 'Highway Light Trails',
      sceneId: 'moving_vehicle',
      difficulty: 'Advanced',
      story: 'Transform passing highway traffic into vivid luminous light ribbons stretching across the night asphalt.',
      goalText: 'Set a long exposure of 2 seconds or longer with a narrow aperture (f/8 - f/16) and base ISO 100.',
      defaultSettings: { iso: 1600, shutterIndex: 7, aperture: 2.8, kelvin: 5500, focalLength: 50 },
      criteria: [
        { label: 'Shutter speed 2s or longer (Light trails)', check: (s) => s.shutterSeconds >= 2.0 },
        { label: 'Narrow aperture (f/8 - f/16)', check: (s) => s.aperture >= 8.0 },
        { label: 'Base ISO 100 for clean noise-free darks', check: (s) => s.iso === 100 },
        { label: 'Exposure balanced (within ±1.0 EV)', check: (s, ev) => Math.abs(ev) <= 1.0 }
      ],
      explanation: 'Long exposure photography turns moving point lights into solid streaks. Base ISO 100 keeps deep blacks noise-free, while f/8-f/11 controls incoming ambient light.'
    }
  ];

  // Active challenge state
  let challengeSettings = {
    iso: 400,
    shutterIndex: 7,
    aperture: 4.0,
    kelvin: 5500,
    focalLength: 50
  };

  function initChallenges() {
    renderChallengesNavList();
    loadChallenge(0);
  }

  function renderChallengesNavList() {
    const list = document.getElementById('challengesNavList');
    if (!list) return;
    list.innerHTML = '';

    let completed = 0;
    let totalStars = 0;

    CHALLENGES_DATA.forEach((ch, idx) => {
      const scoreObj = state.challenges.scores[ch.id] || { stars: 0, scorePct: 0 };
      if (scoreObj.stars > 0) completed++;
      totalStars += scoreObj.stars;

      const starStr = '&#9733;'.repeat(scoreObj.stars) + '&#9734;'.repeat(3 - scoreObj.stars);

      const item = document.createElement('div');
      item.className = `challenge-nav-item ${idx === state.challenges.activeId ? 'active' : ''}`;
      item.onclick = () => loadChallenge(idx);

      item.innerHTML = `
        <div class="challenge-nav-title">
          <span>${idx + 1}. ${ch.title}</span>
          <span class="challenge-stars">${starStr}</span>
        </div>
        <div class="challenge-nav-scene">${ch.difficulty} &bull; ${SCENES.find(s => s.id === ch.sceneId)?.name || ''}</div>
      `;
      list.appendChild(item);
    });

    state.challenges.completedCount = completed;
    state.challenges.totalStars = totalStars;

    const summaryEl = document.getElementById('challengesSummaryStars');
    if (summaryEl) summaryEl.innerHTML = `${completed} / 10 Completed (${totalStars} &#9733;)`;

    const statComp = document.getElementById('statCompletedChallenges');
    if (statComp) statComp.textContent = `${completed} / 10`;
  }

  function loadChallenge(id) {
    state.challenges.activeId = id;
    const ch = CHALLENGES_DATA[id];

    // Clone default settings
    challengeSettings = { ...ch.defaultSettings };

    // Highlight nav list
    document.querySelectorAll('.challenge-nav-item').forEach((el, idx) => {
      el.classList.toggle('active', idx === id);
    });

    // Header info
    document.getElementById('challengeDifficultyBadge').textContent = `${ch.difficulty.toUpperCase()} • MISSION ${id + 1}`;
    document.getElementById('activeChallengeTitle').textContent = ch.title;
    document.getElementById('activeChallengeSceneDesc').textContent = ch.story;
    document.getElementById('activeChallengeGoalText').textContent = ch.goalText;

    const scoreObj = state.challenges.scores[ch.id] || { stars: 0 };
    document.getElementById('challengeActiveStars').innerHTML = '&#9733;'.repeat(scoreObj.stars) + '&#9734;'.repeat(3 - scoreObj.stars);

    // Criteria checklist
    const critList = document.getElementById('activeChallengeCriteriaList');
    critList.innerHTML = '';
    ch.criteria.forEach(c => {
      const div = document.createElement('div');
      div.className = 'criteria-item';
      div.innerHTML = `<span class="criteria-icon"></span><span>${c.label}</span>`;
      critList.appendChild(div);
    });

    // Update challenge controls UI
    document.getElementById('chShutterSlider').value = challengeSettings.shutterIndex;
    document.getElementById('chShutterBadge').textContent = SHUTTER_SPEEDS[challengeSettings.shutterIndex];

    document.querySelectorAll('[data-chaperture]').forEach(btn => {
      btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.chaperture) - challengeSettings.aperture) < 0.1);
    });
    document.getElementById('chApertureBadge').textContent = `f/${challengeSettings.aperture.toFixed(1)}`;

    document.querySelectorAll('[data-chiso]').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.chiso) === challengeSettings.iso);
    });
    document.getElementById('chIsoBadge').textContent = `ISO ${challengeSettings.iso}`;

    renderChallengeCanvas();
  }

  function renderChallengeCanvas() {
    const canvas = document.getElementById('challengeCanvas');
    const ch = CHALLENGES_DATA[state.challenges.activeId];
    const scene = SCENES.find(s => s.id === ch.sceneId);
    if (!canvas || !scene) return;

    const result = renderSceneToCanvas(canvas, scene, {
      iso: challengeSettings.iso,
      shutterIndex: challengeSettings.shutterIndex,
      aperture: challengeSettings.aperture,
      kelvin: challengeSettings.kelvin,
      focusDistance: scene.subjectDepth,
      focalLength: challengeSettings.focalLength,
      showClipping: false
    });

    const evInd = document.getElementById('challengeEvIndicator');
    if (evInd && result) {
      const sign = result.evDelta > 0 ? '+' : '';
      evInd.textContent = `EV ${sign}${result.evDelta.toFixed(1)}`;
      evInd.style.color = Math.abs(result.evDelta) <= 0.8 ? 'var(--accent-green)' : 'var(--accent-red)';
    }
  }

  function onChallengeShutter(val) {
    challengeSettings.shutterIndex = parseInt(val);
    document.getElementById('chShutterBadge').textContent = SHUTTER_SPEEDS[val];
    renderChallengeCanvas();
  }

  function setChallengeAperture(val) {
    challengeSettings.aperture = parseFloat(val);
    document.querySelectorAll('[data-chaperture]').forEach(b => {
      b.classList.toggle('active', Math.abs(parseFloat(b.dataset.chaperture) - challengeSettings.aperture) < 0.1);
    });
    document.getElementById('chApertureBadge').textContent = `f/${challengeSettings.aperture.toFixed(1)}`;
    renderChallengeCanvas();
  }

  function setChallengeIso(val) {
    challengeSettings.iso = parseInt(val);
    document.querySelectorAll('[data-chiso]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.chiso) === challengeSettings.iso);
    });
    document.getElementById('chIsoBadge').textContent = `ISO ${challengeSettings.iso}`;
    renderChallengeCanvas();
  }

  function setChallengeWB(preset) {
    const map = { daylight: 5500, tungsten: 3200, shade: 7500 };
    challengeSettings.kelvin = map[preset] || 5500;
    challengeSettings.wbPreset = preset;
    document.querySelectorAll('[data-chwb]').forEach(b => {
      b.classList.toggle('active', b.dataset.chwb === preset);
    });
    document.getElementById('chExtraValBadge').textContent = preset.charAt(0).toUpperCase() + preset.slice(1);
    renderChallengeCanvas();
  }

  function evaluateActiveChallenge() {
    playShutterSound(false);
    const ch = CHALLENGES_DATA[state.challenges.activeId];
    const scene = SCENES.find(s => s.id === ch.sceneId);

    const shutterSec = SHUTTER_VALUES[challengeSettings.shutterIndex];
    const evDelta = calculateExposureDelta(scene.baseEV, challengeSettings.iso, challengeSettings.aperture, shutterSec);

    const fullSettings = {
      ...challengeSettings,
      shutterSeconds: shutterSec
    };

    let passedCount = 0;
    const diagnosticList = document.getElementById('modalBreakdownList');
    diagnosticList.innerHTML = '';

    ch.criteria.forEach((crit, i) => {
      const isPassed = crit.check(fullSettings, evDelta);
      if (isPassed) passedCount++;

      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.gap = '8px';
      div.style.color = isPassed ? 'var(--accent-green)' : 'var(--accent-red)';
      div.innerHTML = `
        <span style="font-weight: bold;">${isPassed ? '✓' : '✗'}</span>
        <span>${crit.label}</span>
      `;
      diagnosticList.appendChild(div);
    });

    const totalCrit = ch.criteria.length;
    let stars = 1;
    let heading = 'Needs Adjustment';
    let subhead = 'Review the criteria diagnostics below and recalibrate your settings.';

    if (passedCount === totalCrit) {
      stars = 3;
      heading = 'Perfect Master Shot! ★★★';
      subhead = 'Exceptional optical mastery! You satisfied all mission criteria with balanced exposure.';
      addXP(100);
    } else if (passedCount >= totalCrit - 1) {
      stars = 2;
      heading = 'Good Effort! ★★☆';
      subhead = 'You achieved the core objective with minor exposure deviation.';
      addXP(50);
    } else {
      stars = 1;
      addXP(15);
    }

    // Save score
    const prevScore = state.challenges.scores[ch.id]?.stars || 0;
    if (stars > prevScore) {
      state.challenges.scores[ch.id] = { stars, scorePct: Math.round((passedCount / totalCrit) * 100) };
    }

    // Update modal
    document.getElementById('modalStarsOutput').innerHTML = '&#9733;'.repeat(stars) + '&#9734;'.repeat(3 - stars);
    document.getElementById('modalResultHeading').textContent = heading;
    document.getElementById('modalResultSubheading').textContent = `${subhead} ${ch.explanation}`;

    // Open modal
    document.getElementById('evaluationModal').classList.add('active');

    renderChallengesNavList();
    saveState();

    if (state.challenges.completedCount >= 5) {
      unlockBadge('challenge_champion');
    }
  }

  function closeEvaluationModal() {
    document.getElementById('evaluationModal').classList.remove('active');
  }

  function advanceNextChallenge() {
    closeEvaluationModal();
    const nextId = (state.challenges.activeId + 1) % CHALLENGES_DATA.length;
    loadChallenge(nextId);
  }

  /* ==========================================================================
     SECTION 5: OPTICAL LENS EXPLORER
     ========================================================================== */
  function initLensExplorer() {
    setLensA(24);
    setLensB(135);
  }

  function onLensTestSceneChange(sceneId) {
    state.lensExplorer.testScene = sceneId;
    renderLensComparison();
  }

  function setLensA(mm) {
    state.lensExplorer.lensA = mm;
    document.querySelectorAll('[data-lensa]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.lensa) === mm);
    });
    updateLensSpecs('A', mm);
    renderLensComparison();
  }

  function setLensB(mm) {
    state.lensExplorer.lensB = mm;
    document.querySelectorAll('[data-lensb]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.lensb) === mm);
    });
    updateLensSpecs('B', mm);
    renderLensComparison();
  }

  function updateLensSpecs(side, mm) {
    // 35mm full frame diagonal sensor = 43.3mm
    const fovDeg = (2 * Math.atan(43.3 / (2 * mm)) * 180 / Math.PI).toFixed(1);
    
    // Distortion
    let distortStr = 'Flat (0.0%)';
    if (mm < 35) {
      const barrelPct = (35 - mm) * 0.7;
      distortStr = `Barrel (+${barrelPct.toFixed(1)}%)`;
    } else if (mm > 85) {
      const pincushionPct = (mm - 85) * 0.02;
      distortStr = `Pincushion (-${pincushionPct.toFixed(1)}%)`;
    }

    // Compression
    let compStr = 'Natural Eye Perspective';
    if (mm <= 24) compStr = 'Expansive / Stretched BG';
    else if (mm >= 135) compStr = 'High Background Compression';
    else if (mm >= 85) compStr = 'Moderate Portrait Compression';

    // DoF
    const dof = calculateDepthOfField(2.8, 2.5, mm);
    const dofStr = `${dof.nearMeters}m – ${dof.farMeters}m`;

    // Genres
    const genreMap = {
      14: 'Ultra-Wide Architecture, Astro, Interior',
      24: 'Landscape, Environmental Portraits, Vlogs',
      35: 'Street Photography, Reportage, Documentary',
      50: 'Standard Normal, Everyday, Low-Light',
      85: 'Classic Studio Headshots, Beauty',
      135: 'Fashion Editorial, Sports, Concerts',
      200: 'Wildlife, High-Speed Action, Compressed Vistas',
      300: 'Super Telephoto Birding, Safari'
    };

    document.getElementById(`lens${side}Name`).textContent = `${mm}mm F/2.8`;
    document.getElementById(`lens${side}Fov`).textContent = `${fovDeg}° (${mm < 35 ? 'Wide' : (mm > 70 ? 'Telephoto' : 'Standard')})`;
    document.getElementById(`lens${side}Distort`).textContent = distortStr;
    document.getElementById(`lens${side}Compress`).textContent = compStr;
    document.getElementById(`lens${side}Dof`).textContent = dofStr;
    document.getElementById(`lens${side}Genres`).textContent = genreMap[mm] || 'Versatile';

    if (state.lensExplorer.lensA <= 14 && state.lensExplorer.lensB >= 200) {
      unlockBadge('lens_master');
    }
  }

  function renderLensComparison() {
    const scene = SCENES.find(s => s.id === state.lensExplorer.testScene) || SCENES[1];
    
    // Render Lens A Canvas
    const canvasA = document.getElementById('lensACanvas');
    renderSceneToCanvas(canvasA, scene, {
      iso: 200,
      shutterIndex: 7,
      aperture: 2.8,
      kelvin: scene.baseWB,
      focusDistance: scene.subjectDepth,
      focalLength: state.lensExplorer.lensA,
      showClipping: false
    });

    // Render Lens B Canvas
    const canvasB = document.getElementById('lensBCanvas');
    renderSceneToCanvas(canvasB, scene, {
      iso: 200,
      shutterIndex: 7,
      aperture: 2.8,
      kelvin: scene.baseWB,
      focusDistance: scene.subjectDepth,
      focalLength: state.lensExplorer.lensB,
      showClipping: false
    });
  }

  /* ==========================================================================
     SECTION 6: MY PROGRESS & GAMIFICATION ENGINE
     ========================================================================== */
  const BADGES_DATA = [
    { id: 'first_shot', title: 'First Light', desc: 'Captured your first photograph in the simulator.', icon: '📸' },
    { id: 'bokeh_master', title: 'Bokeh Master', desc: 'Crafted creamy shallow depth of field at f/1.4 or f/2.0.', icon: '✨' },
    { id: 'action_freezer', title: 'Action Freezer', desc: 'Froze high-speed motion at 1/2000s or faster.', icon: '⚡' },
    { id: 'night_owl', title: 'Night Owl', desc: 'Successfully exposed a dim night scene without blowout.', icon: '🌙' },
    { id: 'color_alchemist', title: 'Color Alchemist', desc: 'Dialed in manual Kelvin white balance calibration.', icon: '🎨' },
    { id: 'composition_master', title: 'Composition Virtuoso', desc: 'Explored 3D camera staging and classical rules.', icon: '📐' },
    { id: 'lens_master', title: 'Master of Glass', desc: 'Compared ultra-wide 14mm to 200mm telephoto lenses.', icon: '🔭' },
    { id: 'challenge_champion', title: 'Challenge Champion', desc: 'Completed at least 5 photography practice missions.', icon: '🏆' }
  ];

  const CONCEPTS_DATA = [
    { id: 'iso', label: 'ISO & Sensor Sensitivity' },
    { id: 'shutter', label: 'Shutter Speed & Motion Blur' },
    { id: 'aperture', label: 'Aperture & Depth of Field' },
    { id: 'wb', label: 'White Balance & Kelvin Scale' },
    { id: 'focus', label: 'Focus Distance & Sharpness' },
    { id: 'composition', label: 'Visual Composition Rules' },
    { id: 'lenses', label: 'Focal Length & Compression' },
    { id: 'exposure_meter', label: 'Exposure Value (EV) Metering' }
  ];

  function initProgressDashboard() {
    renderBadges();
    renderConceptsChecklist();
    updateProgressUI();
  }

  function addXP(amount) {
    state.progress.xp += amount;
    updateProgressUI();
    saveState();
  }

  function unlockBadge(badgeId) {
    if (!state.progress.unlockedBadges.includes(badgeId)) {
      state.progress.unlockedBadges.push(badgeId);
      addXP(75);
      renderBadges();
      saveState();
    }
  }

  function markConceptMastered(conceptId) {
    if (!state.progress.conceptsMastered.includes(conceptId)) {
      state.progress.conceptsMastered.push(conceptId);
      addXP(40);
      renderConceptsChecklist();
      saveState();
    }
  }

  function renderBadges() {
    const container = document.getElementById('badgesContainer');
    if (!container) return;
    container.innerHTML = '';

    let unlockedCount = 0;
    BADGES_DATA.forEach(b => {
      const isUnlocked = state.progress.unlockedBadges.includes(b.id);
      if (isUnlocked) unlockedCount++;

      const card = document.createElement('div');
      card.className = `badge-item-card ${isUnlocked ? 'unlocked' : ''}`;
      card.innerHTML = `
        <div class="badge-icon-circle">${b.icon}</div>
        <h4>${b.title}</h4>
        <p>${b.desc}</p>
        <span style="font-size: 0.65rem; color: ${isUnlocked ? 'var(--accent-gold)' : 'var(--text-muted)'}; font-weight: 700;">
          ${isUnlocked ? 'UNLOCKED' : 'LOCKED'}
        </span>
      `;
      container.appendChild(card);
    });

    const countEl = document.getElementById('badgesUnlockedCount');
    if (countEl) countEl.textContent = `${unlockedCount} of ${BADGES_DATA.length} Unlocked`;
  }

  function renderConceptsChecklist() {
    const grid = document.getElementById('conceptsGrid');
    if (!grid) return;
    grid.innerHTML = '';

    let mastered = 0;
    CONCEPTS_DATA.forEach(c => {
      const isMastered = state.progress.conceptsMastered.includes(c.id);
      if (isMastered) mastered++;

      const div = document.createElement('label');
      div.className = 'concept-item';
      div.innerHTML = `
        <input type="checkbox" ${isMastered ? 'checked' : ''} onchange="toggleConcept('${c.id}', this.checked)">
        <span style="color: ${isMastered ? 'var(--text-primary)' : 'var(--text-muted)'};">${c.label}</span>
      `;
      grid.appendChild(div);
    });

    const countEl = document.getElementById('conceptsMasteredCount');
    if (countEl) countEl.textContent = `${mastered} of ${CONCEPTS_DATA.length} Mastered`;
  }

  function toggleConcept(id, checked) {
    if (checked) {
      if (!state.progress.conceptsMastered.includes(id)) {
        state.progress.conceptsMastered.push(id);
        addXP(30);
      }
    } else {
      state.progress.conceptsMastered = state.progress.conceptsMastered.filter(x => x !== id);
    }
    renderConceptsChecklist();
    saveState();
  }

  function updateProgressUI() {
    const xp = state.progress.xp;
    let rank = 'Beginner';
    let nextTierXp = 200;
    let rankTitle = 'Level 1: Novice Observer';

    if (xp >= 1800) {
      rank = 'Master';
      nextTierXp = 3000;
      rankTitle = 'Level 5: Master Virtuoso';
    } else if (xp >= 1000) {
      rank = 'Advanced';
      nextTierXp = 1800;
      rankTitle = 'Level 4: Advanced Craftsman';
    } else if (xp >= 500) {
      rank = 'Enthusiast';
      nextTierXp = 1000;
      rankTitle = 'Level 3: Skilled Enthusiast';
    } else if (xp >= 200) {
      rank = 'Amateur';
      nextTierXp = 500;
      rankTitle = 'Level 2: Optical Apprentice';
    }

    const pct = Math.min(100, Math.round((xp / nextTierXp) * 100));

    // Sidebar
    const sbRank = document.getElementById('sidebarRankLabel');
    const sbXp = document.getElementById('sidebarXpLabel');
    const sbBar = document.getElementById('sidebarXpBar');
    if (sbRank) sbRank.innerHTML = `★ ${rank}`;
    if (sbXp) sbXp.textContent = `${xp} XP`;
    if (sbBar) sbBar.style.width = `${pct}%`;

    // Dashboard Hero
    const pill = document.getElementById('userRankPill');
    const title = document.getElementById('userMasteryTitle');
    const xpText = document.getElementById('xpCounterText');
    const dashBar = document.getElementById('dashboardXpBar');
    if (pill) pill.textContent = `RANK: ${rank.toUpperCase()}`;
    if (title) title.textContent = rankTitle;
    if (xpText) xpText.textContent = `${xp} / ${nextTierXp} XP (${pct}%)`;
    if (dashBar) dashBar.style.width = `${pct}%`;
  }

  // Active Session Timer
  function startSessionTimer() {
    setInterval(() => {
      state.progress.totalTimeSeconds++;
      const s = state.progress.totalTimeSeconds;
      const hrs = String(Math.floor(s / 3600)).padStart(2, '0');
      const mins = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const secs = String(s % 60).padStart(2, '0');
      const timeStr = `${hrs}:${mins}:${secs}`;

      const tTop = document.getElementById('sessionTimer');
      const tDash = document.getElementById('statTotalTime');
      if (tTop) tTop.textContent = timeStr;
      if (tDash) tDash.textContent = timeStr;
    }, 1000);
  }

  /* ==========================================================================
     GLOBAL NAVIGATION & SECTION SWITCHING
     ========================================================================== */
  function switchSection(sectionId) {
    state.currentSection = sectionId;

    // Toggle nav active state
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.section === sectionId);
    });

    // Toggle section view visibility
    document.querySelectorAll('.section-view').forEach(view => {
      view.classList.remove('active');
    });

    const targetSection = document.getElementById(`section-${sectionId}`);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    // Update Topbar Title
    const sectionNames = {
      home: 'Home Workspace',
      simulator: 'Interactive Camera Simulator',
      composition: '3D Composition Lab',
      challenges: 'Targeted Practice Missions',
      lenses: 'Optical Lens Explorer',
      progress: 'Photographer Progress & Mastery',
      cheatsheets: 'Field Reference Cheat Sheets'
    };

    document.getElementById('breadcrumbSection').textContent = 'PhotoTour';
    document.getElementById('activeSectionTitle').textContent = sectionNames[sectionId] || 'Workspace';

    // Section Specific Initialization / Resize
    if (sectionId === 'simulator') {
      requestSimulatorRender();
    } else if (sectionId === 'composition') {
      if (!isThreeInitialized) {
        setTimeout(initThreeJsStudio, 50);
      }
    } else if (sectionId === 'lenses') {
      renderLensComparison();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    saveState();
  }

  /* --------------------------------------------------------------------------
     HOME EXPOSURE TRIANGLE INTERACTIVITY
     -------------------------------------------------------------------------- */
  function highlightTriangleVertex(type) {
    const title = document.getElementById('triangleTitle');
    const desc = document.getElementById('triangleDesc');
    const indicator = document.getElementById('triangleExposureIndicator');

    if (type === 'aperture') {
      title.textContent = 'Aperture: Diaphragm Opening (f-number)';
      desc.textContent = 'Controls the volume of light gathered and depth of field. Wide apertures (f/1.4) create shallow focus with blurry backgrounds; narrow apertures (f/16) render the entire scene in focus.';
      indicator.setAttribute('cx', '170');
      indicator.setAttribute('cy', '70');
      indicator.setAttribute('fill', '#e8a030');
    } else if (type === 'shutter') {
      title.textContent = 'Shutter Speed: Duration of Exposure (Seconds)';
      desc.textContent = 'Controls the time physical light strikes the sensor. High speeds (1/1000s) freeze supersonic athletic motion; slow speeds (2s) paint light streaks and silky water flow.';
      indicator.setAttribute('cx', '85');
      indicator.setAttribute('cy', '230');
      indicator.setAttribute('fill', '#4a9eff');
    } else if (type === 'iso') {
      title.textContent = 'ISO: Sensor Amplification Gain';
      desc.textContent = 'Amplifies electrical sensor signals in dark environments. High ISO (6400+) lets you shoot without a tripod at night, but introduces visible colored pixel noise and grain.';
      indicator.setAttribute('cx', '255');
      indicator.setAttribute('cy', '230');
      indicator.setAttribute('fill', '#4ae880');
    }
  }

  /* ==========================================================================
     LOCALSTORAGE PERSISTENCE ENGINE
     ========================================================================== */
  const STORAGE_KEY = 'phototour_pro_simulator_state_v1';

  function saveState() {
    try {
      const dataToSave = {
        simulator: {
          sceneIndex: state.simulator.sceneIndex,
          iso: state.simulator.iso,
          shutterIndex: state.simulator.shutterIndex,
          aperture: state.simulator.aperture,
          kelvin: state.simulator.kelvin,
          focusDistance: state.simulator.focusDistance,
          focalLength: state.simulator.focalLength
        },
        challenges: state.challenges.scores,
        progress: state.progress
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
    } catch (e) {
      console.warn('LocalStorage save error:', e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.simulator) {
          state.simulator.sceneIndex = saved.simulator.sceneIndex || 0;
          state.simulator.iso = saved.simulator.iso || 400;
          state.simulator.shutterIndex = saved.simulator.shutterIndex !== undefined ? saved.simulator.shutterIndex : 7;
          state.simulator.aperture = saved.simulator.aperture || 4.0;
          state.simulator.kelvin = saved.simulator.kelvin || 5500;
          state.simulator.focusDistance = saved.simulator.focusDistance || 2.5;
          state.simulator.focalLength = saved.simulator.focalLength || 50;
        }
        if (saved.challenges) state.challenges.scores = saved.challenges;
        if (saved.progress) {
          state.progress.xp = saved.progress.xp || 240;
          state.progress.photosTaken = saved.progress.photosTaken || 0;
          state.progress.totalTimeSeconds = saved.progress.totalTimeSeconds || 0;
          if (saved.progress.conceptsMastered) state.progress.conceptsMastered = saved.progress.conceptsMastered;
          if (saved.progress.unlockedBadges) state.progress.unlockedBadges = saved.progress.unlockedBadges;
        }
      }
    } catch (e) {
      console.warn('LocalStorage load error:', e);
    }
  }

  /* ==========================================================================
     INITIALIZATION ON PAGE LOAD
     ========================================================================== */
  window.addEventListener('DOMContentLoaded', () => {

    // ── Mobile / Small-screen Detection ──────────────────────────────────────
    // Show the professional warning if:
    //   • Device is a phone/tablet (touch + narrow), OR
    //   • Viewport is narrower than 1024 px
    // Respects "Don't show again" preference stored in localStorage.
    (function checkMobileWarning() {
      const dismissed = localStorage.getItem('mobileWarningDismissed') === '1';
      if (dismissed) return;

      const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const isNarrow   = window.innerWidth < 1024;

      if (isMobileUA || isNarrow) {
        const overlay = document.getElementById('mobileWarningOverlay');
        if (overlay) overlay.style.display = 'flex';
      }
    })();
    // ─────────────────────────────────────────────────────────────────────────

    // 1. Restore persistent user data
    loadState();

    // 2. Render Scene Library Thumbnails
    renderSceneThumbnails();

    // 3. Setup Simulator Controls
    setIso(state.simulator.iso);
    onShutterSlider(state.simulator.shutterIndex);
    setAperture(state.simulator.aperture);
    setWhitebalancePreset('daylight');
    onFocusSlider(state.simulator.focusDistance);
    setFocalLength(state.simulator.focalLength);

    // 4. Initialize Practice Challenges & Lens Explorer
    initChallenges();
    initLensExplorer();
    initProgressDashboard();

    // 5. Setup Hotkeys & Audio
    initKeyboardShortcuts();
    startSessionTimer();

    // 6. First Canvas Render
    requestSimulatorRender();

    // 7. Ensure audio context is ready on first user click
    window.addEventListener('click', () => initAudio(), { once: true });
  });