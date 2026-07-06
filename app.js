/*********************************************
 * BeatForge AI – All audio logic & UI
 *********************************************/
window.addEventListener('load', async () => {
  // --- Wait for user interaction to start audio context ---
  const startAudio = async () => {
    await Tone.start();
    console.log('Audio ready');
    initApp();
  };
  document.body.addEventListener('click', startAudio, { once: true });

  // ========== GLOBAL STATE ==========
  let melodyNotes = []; // AI generated notes
  let musicVAE;         // Magenta model

  // ========== AUDIO NODES & PLAYERS ==========
  const masterGain = new Tone.Gain(0.9).toDestination();
  const comp = new Tone.Compressor(-24, 4); // mastering compressor
  const lowShelf = new Tone.Filter(60, "lowshelf");
  const midPeak = new Tone.Filter(1000, "peaking");
  const highShelf = new Tone.Filter(8000, "highshelf");
  // Connect mastering chain: masterGain -> EQ -> comp -> destination
  masterGain.chain(lowShelf, midPeak, highShelf, comp, Tone.Destination);

  // Channel strips
  const channels = {
    kick:  { vol: new Tone.Volume(0).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), solo: false, mute: false },
    snare: { vol: new Tone.Volume(0).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), solo: false, mute: false },
    hihat: { vol: new Tone.Volume(0).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), solo: false, mute: false },
    clap:  { vol: new Tone.Volume(0).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), solo: false, mute: false },
    melody:{ vol: new Tone.Volume(0).connect(masterGain), pan: new Tone.Panner(0).connect(masterGain), solo: false, mute: false },
  };

  // Players for DJ decks
  const deckA = { player: null, gain: new Tone.Gain(0.5).connect(masterGain), speed: 1 };
  const deckB = { player: null, gain: new Tone.Gain(0.5).connect(masterGain), speed: 1 };

  // Beat sequencer
  const beatPlayers = {
    kick:  new Tone.Player("https://tonejs.github.io/audio/505/kick.mp3").connect(channels.kick.vol),
    snare: new Tone.Player("https://tonejs.github.io/audio/505/snare.mp3").connect(channels.snare.vol),
    hihat: new Tone.Player("https://tonejs.github.io/audio/505/hihat.mp3").connect(channels.hihat.vol),
    clap:  new Tone.Player("https://tonejs.github.io/audio/505/clap.mp3").connect(channels.clap.vol),
  };
  // Sequencer steps (16 steps, 4 tracks)
  const steps = { kick: [], snare: [], hihat: [], clap: [] };
  let beatPlaying = false;
  let beatPart;

  // Synth for melody
  const melodySynth = new Tone.PolySynth(Tone.Synth).connect(channels.melody.vol);
  const melodyPart = new Tone.Part((time, note) => {
    melodySynth.triggerAttackRelease(note.pitch, note.dur, time);
  }, []).start(0);

  // ========== INITIALIZATION ==========
  async function initApp() {
    // Load DJ samples (royalty-free loops)
    deckA.player = new Tone.Player("https://tonejs.github.io/audio/505/loopA.mp3").connect(deckA.gain);
    deckB.player = new Tone.Player("https://tonejs.github.io/audio/505/loopB.mp3").connect(deckB.gain);
    await Tone.loaded();

    // Build step UI
    buildSequencerUI();
    setupUI();

    // Load Magenta model once
    try {
      musicVAE = new music_vae.MusicVAE('https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_2bar_small');
      await musicVAE.initialize();
      document.getElementById('generate-melody').disabled = false;
    } catch(e) {
      console.warn('AI model not loaded, using fallback random melody');
    }
  }

  // ========== UI SETUP ==========
  function setupUI() {
    // Tabs
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(btn.dataset.view).classList.add('active');
      });
    });

    // DJ controls
    document.querySelectorAll('.play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const deck = btn.dataset.deck === 'a' ? deckA : deckB;
        if (deck.player.state === 'started') {
          deck.player.stop();
          btn.textContent = '▶ Play';
        } else {
          deck.player.start();
          btn.textContent = '⏸ Pause';
        }
      });
    });
    document.querySelectorAll('.speed').forEach(slider => {
      slider.addEventListener('input', e => {
        const deck = e.target.dataset.deck === 'a' ? deckA : deckB;
        deck.speed = parseFloat(e.target.value);
        if (deck.player) deck.player.playbackRate = deck.speed;
      });
    });
    document.getElementById('crossfader').addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      deckA.gain.gain.value = 1 - val;
      deckB.gain.gain.value = val;
    });

    // Beat sequencer
    document.getElementById('play-beat').addEventListener('click', startBeat);
    document.getElementById('stop-beat').addEventListener('click', stopBeat);
    document.getElementById('bpm').addEventListener('change', e => {
      Tone.Transport.bpm.value = parseFloat(e.target.value);
    });

    // Mixer channel strips
    document.querySelectorAll('.channel').forEach(chan => {
      const chName = chan.dataset.chan;
      if (!channels[chName]) return;
      const volSlider = chan.querySelector('.vol');
      const panSlider = chan.querySelector('.pan');
      const soloBtn = chan.querySelector('.solo-btn');
      const muteBtn = chan.querySelector('.mute-btn');

      volSlider.addEventListener('input', e => {
        channels[chName].vol.volume.value = Tone.gainToDb(parseFloat(e.target.value));
      });
      panSlider.addEventListener('input', e => {
        channels[chName].pan.pan.value = parseFloat(e.target.value);
      });
      soloBtn.addEventListener('click', () => {
        channels[chName].solo = !channels[chName].solo;
        soloBtn.classList.toggle('active', channels[chName].solo);
        updateChannelRouting();
      });
      muteBtn.addEventListener('click', () => {
        channels[chName].mute = !channels[chName].mute;
        muteBtn.classList.toggle('active', channels[chName].mute);
        updateChannelRouting();
      });
    });

    // Master volume
    document.getElementById('master-vol').addEventListener('input', e => {
      masterGain.gain.value = parseFloat(e.target.value);
    });

    // Mastering
    document.querySelectorAll('.eq-gain').forEach(slider => {
      slider.addEventListener('input', e => {
        const freq = e.target.dataset.freq;
        const gain = parseFloat(e.target.value);
        if (freq == 60) lowShelf.gain.value = gain;
        else if (freq == 1000) midPeak.gain.value = gain;
        else if (freq == 8000) highShelf.gain.value = gain;
      });
    });
    document.getElementById('comp-threshold').addEventListener('input', e => {
      comp.threshold.value = parseFloat(e.target.value);
    });
    document.getElementById('comp-ratio').addEventListener('input', e => {
      comp.ratio.value = parseFloat(e.target.value);
    });

    // Export
    document.getElementById('export-audio').addEventListener('click', exportTrack);

    // AI Composer
    document.getElementById('generate-melody').addEventListener('click', generateMelody);
    document.getElementById('play-melody').addEventListener('click', playMelody);

    // Oscilloscope (DJ view)
    drawScope('scope-dj');
  }

  // ========== CHANNEL ROUTING (SOLO/MUTE) ==========
  function updateChannelRouting() {
    const anySolo = Object.values(channels).some(ch => ch.solo);
    for (const [name, ch] of Object.entries(channels)) {
      let shouldMute = ch.mute;
      if (anySolo) {
        shouldMute = !ch.solo;
      }
      ch.vol.mute = shouldMute;
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
        steps[sample][i] = false;
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
      beatPlayers[evt.sample].start(time);
      // Highlight step
      const idx = Tone.Transport.position.split(':')[1];
      document.querySelectorAll('.step').forEach(s => s.classList.remove('current'));
      if (idx) document.querySelectorAll(`#steps-${evt.sample} .step`)[idx]?.classList.add('current');
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

  // ========== AI MELODY GENERATION ==========
  async function generateMelody() {
    document.getElementById('generate-melody').disabled = true;
    document.getElementById('generate-melody').textContent = 'Generating...';
    let notes;
    if (musicVAE) {
      const sample = await musicVAE.sample(1);
      notes = sample[0].notes.map(n => ({
        pitch: Tone.Frequency(n.pitch, "midi").toNote(),
        time: n.startTime,
        dur: n.endTime - n.startTime
      }));
    } else {
      // Fallback random pentatonic
      const scale = ['C4','D4','E4','G4','A4'];
      notes = [];
      for (let i = 0; i < 8; i++) {
        notes.push({
          pitch: scale[Math.floor(Math.random()*scale.length)],
          time: i * 0.5,
          dur: 0.5
        });
      }
    }
    melodyNotes = notes;
    displayMelody(notes);
    document.getElementById('generate-melody').disabled = false;
    document.getElementById('generate-melody').textContent = '✨ Generate Melody';
    document.getElementById('play-melody').disabled = false;
  }

  function displayMelody(notes) {
    const container = document.getElementById('melody-notes');
    container.innerHTML = notes.map(n => `${n.pitch} (${n.time.toFixed(1)}s)`).join(', ');
    drawPianoRoll(notes);
  }

  function playMelody() {
    melodyPart.clear();
    melodyNotes.forEach(n => {
      melodyPart.add(n.time, { pitch: n.pitch, dur: n.dur });
    });
    Tone.Transport.start();
    // Stop after last note
    const maxEnd = Math.max(...melodyNotes.map(n => n.time + n.dur));
    setTimeout(() => {
      melodyPart.clear();
      melodySynth.releaseAll();
    }, maxEnd * 1000 + 500);
  }

  function drawPianoRoll(notes) {
    const canvas = document.getElementById('piano-roll');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const noteMap = { 'C':0,'D':1,'E':2,'F':3,'G':4,'A':5,'B':6 };
    notes.forEach(n => {
      const x = n.time * 150;
      const y = 100 - (noteMap[n.pitch[0]] + (parseInt(n.pitch[1])-4)*7) * 10;
      ctx.fillStyle = '#58cc02';
      ctx.fillRect(x, y, n.dur*150, 10);
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
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    function draw() {
      requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.fillStyle = '#222';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#58cc02';
      ctx.beginPath();
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i=0; i<bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height/2;
        if(i===0) ctx.moveTo(x,y);
        else ctx.lineTo(x,y);
        x += sliceWidth;
      }
      ctx.stroke();
    }
    draw();
  }

  // ========== EXPORT ==========
  async function exportTrack() {
    // Simple 8‑second recording from master output
    const dest = Tone.Destination.context.createMediaStreamDestination();
    masterGain.connect(dest);
    const mediaRecorder = new MediaRecorder(dest.stream);
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
