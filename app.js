/*****************************************************
 * BeatForge AI Pro – Full audio engine
 * No samples needed – everything is synthesised.
 *****************************************************/
window.addEventListener('load', async () => {
  // Wait for user click to start AudioContext
  const startAudio = async () => {
    await Tone.start();
    console.log('Audio ready');
    await initApp();
  };
  document.body.addEventListener('click', startAudio, { once: true });

  // ---------- GLOBAL VARIABLES ----------
  let melodyNotes = [];           // AI generated melody
  let musicVAE = null;           // Magenta model (if loaded)

  // Master output chain: EQ -> Compressor -> Limiter -> Destination
  const masterGain = new Tone.Gain(1).toDestination();
  const lowShelf = new Tone.Filter(60, "lowshelf").connect(masterGain);
  const midPeak = new Tone.Filter(1000, "peaking").connect(masterGain);
  const highShelf = new Tone.Filter(8000, "highshelf").connect(masterGain);
  const comp = new Tone.Compressor(-24, 4).connect(masterGain);
  // Limiter to prevent clipping
  const limiter = new Tone.Limiter(-0.5).toDestination();
  masterGain.connect(lowShelf).connect(midPeak).connect(highShelf).connect(comp).connect(limiter);

  // Send effects
  const reverb = new Tone.Reverb({ decay: 1.5, wet: 1 }).connect(masterGain);
  const delay = new Tone.FeedbackDelay("8n", 0.4).connect(masterGain);

  // Channel definitions (each drum + melody)
  const channels = {
    kick:  { vol: new Tone.Gain(0.9).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), mute: false, solo: false },
    snare: { vol: new Tone.Gain(0.9).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), mute: false, solo: false },
    hihat: { vol: new Tone.Gain(0.7).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), mute: false, solo: false },
    clap:  { vol: new Tone.Gain(0.8).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), mute: false, solo: false },
    melody:{ vol: new Tone.Gain(0.8).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), mute: false, solo: false }
  };

  // Route all channels through their volume -> pan -> master (and send to effects via separate connections)
  // We'll add send amounts dynamically later.

  // Drum synthesizers
  const kickSynth = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 4, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 } }).connect(channels.kick.vol);
  const snareSynth = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 } }).connect(channels.snare.vol);
  const hihatSynth = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.01 } }).connect(channels.hihat.vol);
  hihatSynth.filterEnvelope = { attack: 0.001, decay: 0.02 };
  // clap: layered noise
  const clapSynth = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 } }).connect(channels.clap.vol);

  // Melody synth
  const melodySynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.5 } }).connect(channels.melody.vol);

  // DJ deck players – we'll create offline buffers
  let deckAPlayer, deckBPlayer;
  const deckAGain = new Tone.Gain(0.5).connect(masterGain);
  const deckBGain = new Tone.Gain(0.5).connect(masterGain);

  // Beat sequencer state
  const steps = { kick: Array(16).fill(false), snare: Array(16).fill(false), hihat: Array(16).fill(false), clap: Array(16).fill(false) };
  let beatPart = null;
  let beatPlaying = false;

  // ========== INITIALISATION ==========
  async function initApp() {
    // Generate DJ deck loops offline (so they work without any external files)
    await generateDJLoops();
    // Build step buttons
    buildSequencerUI();
    // Setup all event listeners
    setupUI();
    // Load Magenta model (optional)
    try {
      musicVAE = new music_vae.MusicVAE('https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_2bar_small');
      await musicVAE.initialize();
      document.getElementById('generate-melody').disabled = false;
    } catch (e) {
      console.warn('Magenta could not load – using built‑in melody generator instead.');
      document.getElementById('generate-melody').disabled = false; // still available, fallback
    }
    // Start oscilloscope
    drawScope('scope-dj');
  }

  // ========== OFFLINE LOOP GENERATION ==========
  async function generateDJLoops() {
    // Create a 4-bar bass loop (C minor)
    const bassNotes = [
      { note: "C2", time: 0, dur: 0.5 },
      { note: "C2", time: 0.5, dur: 0.25 },
      { note: "Eb2", time: 1.5, dur: 0.5 },
      { note: "G2", time: 2.5, dur: 0.75 },
      { note: "F2", time: 3.5, dur: 0.5 }
    ];
    // Create a 4-bar pad loop (Cm7, Fm7, etc.)
    const chordProg = [
      { notes: ["C4","Eb4","G4","Bb4"], time: 0, dur: 2 },
      { notes: ["F4","Ab4","C5","Eb5"], time: 2, dur: 2 },
      { notes: ["G4","Bb4","D5","F5"], time: 4, dur: 2 },
      { notes: ["C4","Eb4","G4","Bb4"], time: 6, dur: 2 }
    ];
    deckAPlayer = await renderOfflineBuffer(bassNotes, "square", 0.6);
    deckBPlayer = await renderOfflineBuffer(chordProg, "triangle", 0.4, true);
    deckAPlayer.connect(deckAGain);
    deckBPlayer.connect(deckBGain);
  }

  async function renderOfflineBuffer(noteEvents, oscType, vol, isPoly = false) {
    const duration = 8; // 8 seconds (4 bars at 120bpm)
    const ctx = Tone.getContext().rawContext;
    const offlineCtx = new OfflineAudioContext(2, ctx.sampleRate * duration, ctx.sampleRate);
    const gainNode = offlineCtx.createGain();
    gainNode.gain.value = vol;
    gainNode.connect(offlineCtx.destination);

    if (isPoly) {
      // Polyphonic: create an oscillator for each note
      noteEvents.forEach(ev => {
        ev.notes.forEach(noteName => {
          const osc = offlineCtx.createOscillator();
          osc.type = oscType;
          osc.frequency.value = Tone.Frequency(noteName).toFrequency();
          const env = offlineCtx.createGain();
          env.gain.setValueAtTime(0.8, ev.time);
          env.gain.exponentialRampToValueAtTime(0.001, ev.time + ev.dur);
          osc.connect(env);
          env.connect(gainNode);
          osc.start(ev.time);
          osc.stop(ev.time + ev.dur);
        });
      });
    } else {
      // Monophonic: one oscillator at a time
      noteEvents.forEach(ev => {
        const osc = offlineCtx.createOscillator();
        osc.type = oscType;
        osc.frequency.value = Tone.Frequency(ev.note).toFrequency();
        const env = offlineCtx.createGain();
        env.gain.setValueAtTime(0.8, ev.time);
        env.gain.exponentialRampToValueAtTime(0.001, ev.time + ev.dur);
        osc.connect(env);
        env.connect(gainNode);
        osc.start(ev.time);
        osc.stop(ev.time + ev.dur);
      });
    }

    const renderedBuffer = await offlineCtx.startRendering();
    // Convert to a Tone.Player
    const player = new Tone.Player(renderedBuffer);
    await Tone.loaded();
    return player;
  }

  // ========== UI SETUP ==========
  function setupUI() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(btn.dataset.view).classList.add('active');
      });
    });

    // DJ Play buttons
    document.querySelectorAll('.play-deck').forEach(btn => {
      btn.addEventListener('click', () => {
        const deck = btn.dataset.deck === 'a' ? deckAPlayer : deckBPlayer;
        const gain = btn.dataset.deck === 'a' ? deckAGain : deckBGain;
        if (deck.state === 'started') {
          deck.stop();
          btn.textContent = '▶ Play';
        } else {
          deck.start();
          btn.textContent = '⏸ Pause';
        }
      });
    });

    // Pitch sliders
    document.querySelectorAll('.pitch').forEach(slider => {
      slider.addEventListener('input', e => {
        const deck = e.target.dataset.deck === 'a' ? deckAPlayer : deckBPlayer;
        deck.playbackRate = parseFloat(e.target.value);
      });
    });

    // Crossfader
    document.getElementById('crossfader').addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      deckAGain.gain.value = 1 - val;
      deckBGain.gain.value = val;
    });

    // Beat sequencer
    document.getElementById('play-beat').addEventListener('click', startBeat);
    document.getElementById('stop-beat').addEventListener('click', stopBeat);
    document.getElementById('bpm').addEventListener('change', e => {
      Tone.Transport.bpm.value = parseInt(e.target.value);
    });
    document.getElementById('random-beat').addEventListener('click', randomizeBeat);

    // Mixer channel strips (volume, pan, mute, solo, send effects)
    document.querySelectorAll('.channel').forEach(ch => {
      const chName = ch.dataset.chan;
      if (!channels[chName]) return;
      const volSlider = ch.querySelector('.vol');
      const panSlider = ch.querySelector('.pan');
      const muteBtn = ch.querySelector('.mute-btn');
      const soloBtn = ch.querySelector('.solo-btn');
      const revSend = ch.querySelector('.send-reverb');
      const delSend = ch.querySelector('.send-delay');

      volSlider.addEventListener('input', e => {
        channels[chName].vol.gain.value = parseFloat(e.target.value);
      });
      panSlider.addEventListener('input', e => {
        channels[chName].pan.pan.value = parseFloat(e.target.value);
      });
      muteBtn.addEventListener('click', () => {
        channels[chName].mute = !channels[chName].mute;
        muteBtn.classList.toggle('active', channels[chName].mute);
        updateChannelRouting();
      });
      soloBtn.addEventListener('click', () => {
        channels[chName].solo = !channels[chName].solo;
        soloBtn.classList.toggle('active', channels[chName].solo);
        updateChannelRouting();
      });
      if (revSend) {
        revSend.addEventListener('input', e => {
          const sendGain = channels[chName].vol.context.createGain();
          // We need to create send connections if not already existing. Simplify: adjust reverb send directly?
          // To keep it simple, we'll manage sends using Tone.Gain nodes. We'll create them once.
          if (!channels[chName].reverbSend) {
            channels[chName].reverbSend = new Tone.Gain(0).connect(reverb);
            channels[chName].vol.connect(channels[chName].reverbSend);
          }
          channels[chName].reverbSend.gain.value = parseFloat(e.target.value);
        });
      }
      if (delSend) {
        delSend.addEventListener('input', e => {
          if (!channels[chName].delaySend) {
            channels[chName].delaySend = new Tone.Gain(0).connect(delay);
            channels[chName].vol.connect(channels[chName].delaySend);
          }
          channels[chName].delaySend.gain.value = parseFloat(e.target.value);
        });
      }
    });

    // Master volume
    document.getElementById('master-vol').addEventListener('input', e => {
      masterGain.gain.value = parseFloat(e.target.value);
    });

    // Mastering EQ
    document.querySelectorAll('.eq-gain').forEach(slider => {
      slider.addEventListener('input', e => {
        const freq = e.target.dataset.freq;
        const gain = parseFloat(e.target.value);
        if (freq == 60) lowShelf.gain.value = gain;
        else if (freq == 1000) midPeak.gain.value = gain;
        else if (freq == 8000) highShelf.gain.value = gain;
      });
    });
    document.getElementById('comp-threshold').addEventListener('input', e => comp.threshold.value = parseFloat(e.target.value));
    document.getElementById('comp-ratio').addEventListener('input', e => comp.ratio.value = parseFloat(e.target.value));

    // Export
    document.getElementById('export-audio').addEventListener('click', exportTrack);

    // AI Composer
    document.getElementById('generate-melody').addEventListener('click', generateMelody);
    document.getElementById('play-melody').addEventListener('click', playMelody);
    document.getElementById('stop-melody').addEventListener('click', stopMelody);
  }

  // ========== CHANNEL ROUTING (MUTE/SOLO) ==========
  function updateChannelRouting() {
    const anySolo = Object.values(channels).some(ch => ch.solo);
    for (const [name, ch] of Object.entries(channels)) {
      ch.vol.mute = anySolo ? !ch.solo : ch.mute;
    }
  }

  // ========== SEQUENCER ==========
  function buildSequencerUI() {
    const sampleNames = ['kick', 'snare', 'hihat', 'clap'];
    sampleNames.forEach(sample => {
      const container = document.getElementById(`steps-${sample}`);
      for (let i = 0; i < 16; i++) {
        const step = document.createElement('div');
        step.className = 'step';
        step.dataset.index = i;
        step.addEventListener('click', () => {
          step.classList.toggle('active');
          steps[sample][i] = step.classList.contains('active');
        });
        container.appendChild(step);
      }
    });
  }

  function startBeat() {
    if (beatPlaying) return;
    beatPlaying = true;
    Tone.Transport.bpm.value = parseInt(document.getElementById('bpm').value) || 120;
    const events = [];
    for (let i = 0; i < 16; i++) {
      const time = `0:${i}:0`;
      ['kick','snare','hihat','clap'].forEach(sample => {
        if (steps[sample][i]) {
          events.push({ time, sample });
        }
      });
    }
    beatPart = new Tone.Part((time, evt) => {
      if (evt.sample === 'kick') kickSynth.triggerAttackRelease('C1', '8n', time);
      else if (evt.sample === 'snare') snareSynth.triggerAttackRelease('8n', time);
      else if (evt.sample === 'hihat') hihatSynth.triggerAttackRelease('16n', time);
      else if (evt.sample === 'clap') clapSynth.triggerAttackRelease('8n', time);
      // Highlight current step
      const idx = parseInt(Tone.Transport.position.split(':')[1]);
      document.querySelectorAll('.step').forEach(s => s.classList.remove('current'));
      if (!isNaN(idx)) {
        document.querySelectorAll(`#steps-${evt.sample} .step`)[idx]?.classList.add('current');
      }
    }, events).start(0);
    beatPart.loop = 16;
    beatPart.loopEnd = '1:0:0';
    Tone.Transport.start();
  }

  function stopBeat() {
    beatPlaying = false;
    Tone.Transport.stop();
    if (beatPart) beatPart.dispose();
    document.querySelectorAll('.step').forEach(s => s.classList.remove('current'));
  }

  function randomizeBeat() {
    ['kick','snare','hihat','clap'].forEach(sample => {
      for (let i = 0; i < 16; i++) {
        steps[sample][i] = Math.random() < (sample === 'kick' ? 0.35 : sample === 'snare' ? 0.25 : 0.2);
      }
    });
    // Update UI
    updateStepUI();
  }

  function updateStepUI() {
    ['kick','snare','hihat','clap'].forEach(sample => {
      const container = document.getElementById(`steps-${sample}`);
      Array.from(container.children).forEach((step, i) => {
        step.classList.toggle('active', steps[sample][i]);
      });
    });
  }

  // ========== AI MELODY GENERATION ==========
  async function generateMelody() {
    document.getElementById('generate-melody').disabled = true;
    document.getElementById('generate-melody').textContent = 'Generating...';
    let notes;
    if (musicVAE) {
      try {
        const sample = await musicVAE.sample(1);
        notes = sample[0].notes.map(n => ({
          pitch: Tone.Frequency(n.pitch, "midi").toNote(),
          time: n.startTime,
          dur: n.endTime - n.startTime
        }));
      } catch (e) {
        notes = fallbackMelody();
      }
    } else {
      notes = fallbackMelody();
    }
    melodyNotes = notes;
    displayMelody(notes);
    drawPianoRoll(notes);
    document.getElementById('generate-melody').disabled = false;
    document.getElementById('generate-melody').textContent = '✨ Generate Melody';
    document.getElementById('play-melody').disabled = false;
  }

  function fallbackMelody() {
    // Generate a musical pentatonic melody (C minor pentatonic)
    const scale = ["C4","Eb4","F4","G4","Bb4"];
    const rhythm = [0.25,0.5,0.75,0.25,0.5];
    const notes = [];
    let t = 0;
    for (let i = 0; i < 8; i++) {
      const pitch = scale[Math.floor(Math.random() * scale.length)];
      const dur = rhythm[Math.floor(Math.random() * rhythm.length)];
      notes.push({ pitch, time: t, dur });
      t += dur;
    }
    return notes;
  }

  function displayMelody(notes) {
    const el = document.getElementById('melody-display');
    el.textContent = notes.map(n => `${n.pitch} (${n.time.toFixed(1)}s)`).join(' | ');
  }

  function playMelody() {
    stopMelody(); // stop previous
    const part = new Tone.Part((time, n) => {
      melodySynth.triggerAttackRelease(n.pitch, n.dur, time);
    }, melodyNotes).start(0);
    // loop the 2-bar melody
    part.loop = true;
    part.loopEnd = melodyNotes.reduce((max, n) => Math.max(max, n.time + n.dur), 0);
    Tone.Transport.start();
    window._melodyPart = part;
  }

  function stopMelody() {
    if (window._melodyPart) {
      window._melodyPart.dispose();
      melodySynth.releaseAll();
    }
  }

  function drawPianoRoll(notes) {
    const canvas = document.getElementById('piano-roll');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const noteMap = { C:0,D:1,E:2,F:3,G:4,A:5,B:6 };
    notes.forEach(n => {
      const x = n.time * 75;
      const y = 80 - (noteMap[n.pitch[0]] + (parseInt(n.pitch[1])-4)*7) * 8;
      ctx.fillStyle = '#58cc02';
      ctx.fillRect(x, y, n.dur * 75, 6);
    });
  }

  // ========== VISUALIZER ==========
  function drawScope(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const analyser = Tone.Destination.context.createAnalyser();
    analyser.fftSize = 256;
    masterGain.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    function draw() {
      requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.fillStyle = '#1f1f1f';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#58cc02';
      ctx.beginPath();
      const sliceWidth = canvas.width / dataArray.length;
      let x = 0;
      for (let i=0; i<dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height/2;
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
        x += sliceWidth;
      }
      ctx.stroke();
    }
    draw();
  }

  // ========== EXPORT ==========
  async function exportTrack() {
    const dest = Tone.Destination.context.createMediaStreamDestination();
    masterGain.connect(dest);
    const mediaRecorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' });
    const chunks = [];
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'beatforge-export.webm';
      a.click();
      URL.revokeObjectURL(url);
      masterGain.disconnect(dest);
    };
    mediaRecorder.start();
    setTimeout(() => mediaRecorder.stop(), 8000);
  }
});
