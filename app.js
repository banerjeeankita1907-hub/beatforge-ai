/*************************************************
 * BeatForge AI Pro – Full audio engine
 * ALL SOUNDS ARE SYNTHESISED – NO EXTERNAL FILES
 *************************************************/
let audioReady = false;

// Wait for user to click the unlock button
document.getElementById('unlock-btn').addEventListener('click', async () => {
  document.getElementById('unlock-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await Tone.start();
  audioReady = true;
  initStudio();
});

// All globals will be set after init
let masterGain, lowShelf, midPeak, highShelf, comp, limiter;
let reverb, delay;
let channels = {};
// Drum synths
let kickSynth, snareSynth, hihatSynth, clapSynth;
let melodySynth;
// DJ decks – we'll create loop sequences
let deckASeq, deckBSeq, deckAGain, deckBGain;
// Beat sequencer
let steps = { kick: Array(16).fill(false), snare: Array(16).fill(false), hihat: Array(16).fill(false), clap: Array(16).fill(false) };
let beatPart = null;
let beatPlaying = false;
// AI melody
let melodyNotes = [];
let musicVAE = null;
let melodyPart = null;

function initStudio() {
  if (!audioReady) return;

  // Master chain
  masterGain = new Tone.Gain(1).toDestination();
  lowShelf = new Tone.Filter(60, "lowshelf").connect(masterGain);
  midPeak = new Tone.Filter(1000, "peaking").connect(masterGain);
  highShelf = new Tone.Filter(8000, "highshelf").connect(masterGain);
  comp = new Tone.Compressor(-24, 4).connect(masterGain);
  limiter = new Tone.Limiter(-0.3).toDestination();
  // Connect final master chain: masterGain -> EQ -> comp -> limiter
  masterGain.chain(lowShelf, midPeak, highShelf, comp, limiter);

  // Send effects
  reverb = new Tone.Reverb({ decay: 1.5, wet: 1 }).connect(masterGain);
  delay = new Tone.FeedbackDelay("8n", 0.4).connect(masterGain);

  // Create channel strips
  const channelNames = ['kick','snare','hihat','clap','melody'];
  channelNames.forEach(name => {
    channels[name] = {
      vol: new Tone.Gain(0.9).connect(masterGain),
      pan: new Tone.Panner(0).connect(masterGain),
      reverbSend: new Tone.Gain(0).connect(reverb),
      delaySend: new Tone.Gain(0).connect(delay),
      mute: false,
      solo: false
    };
    // Connect volume -> pan -> reverb send & delay send & masterGain
    // Actually we need to route: Instrument -> vol -> pan -> (connect to sends and master)
    channels[name].vol.connect(channels[name].pan);
    channels[name].pan.connect(channels[name].reverbSend);
    channels[name].pan.connect(channels[name].delaySend);
    channels[name].pan.connect(masterGain);
  });

  // Synths for drums
  kickSynth = new Tone.MembraneSynth({ pitchDecay:0.05, octaves:4, envelope:{attack:0.001,decay:0.3,sustain:0,release:0.1} }).connect(channels.kick.vol);
  snareSynth = new Tone.NoiseSynth({ noise:{type:"white"}, envelope:{attack:0.001,decay:0.15,sustain:0,release:0.05} }).connect(channels.snare.vol);
  hihatSynth = new Tone.NoiseSynth({ noise:{type:"white"}, envelope:{attack:0.001,decay:0.05,sustain:0,release:0.01} }).connect(channels.hihat.vol);
  clapSynth = new Tone.NoiseSynth({ noise:{type:"white"}, envelope:{attack:0.001,decay:0.2,sustain:0,release:0.1} }).connect(channels.clap.vol);
  melodySynth = new Tone.PolySynth(Tone.Synth, { oscillator:{type:"triangle"}, envelope:{attack:0.02,decay:0.1,sustain:0.3,release:0.5} }).connect(channels.melody.vol);

  // DJ decks – create looping sequences with synths
  createDJDecks();
  buildSequencerUI();
  setupUI();
  tryLoadMagenta();
  drawScope('scope-dj');
}

function createDJDecks() {
  // Deck A: a simple bassline (monophonic)
  const bassSynthA = new Tone.Synth({ oscillator:{type:"square"}, envelope:{attack:0.01,decay:0.2,sustain:0.3,release:0.2} }).toDestination();
  deckAGain = new Tone.Gain(0.5).connect(masterGain);
  bassSynthA.connect(deckAGain);
  const bassNotesA = ["C2","C2","Eb2","G2","F2","C2","G2","C2"];
  let indexA = 0;
  deckASeq = new Tone.Sequence((time, note) => {
    bassSynthA.triggerAttackRelease(note, "8n", time);
  }, bassNotesA, "8n").start(0);
  // Deck B: chord stabs (polyphonic via multiple synths)
  const chordSynthB = new Tone.PolySynth(Tone.Synth, { oscillator:{type:"triangle"}, envelope:{attack:0.05,decay:0.3,sustain:0.1,release:0.4} }).toDestination();
  deckBGain = new Tone.Gain(0.5).connect(masterGain);
  chordSynthB.connect(deckBGain);
  const chordProg = [
    ["C4","Eb4","G4","Bb4"], ["F4","Ab4","C5","Eb5"],
    ["G4","Bb4","D5","F5"], ["C4","Eb4","G4","Bb4"]
  ];
  let chordIndex = 0;
  deckBSeq = new Tone.Sequence((time, notes) => {
    chordSynthB.triggerAttackRelease(notes, "2n", time);
  }, chordProg, "2n").start(0);
  // Transport is running by default when we start DJ? We'll start/stop later.
}

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

  // DJ Play buttons (start/stop transport)
  document.querySelectorAll('.play-deck').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!audioReady) return;
      if (Tone.Transport.state !== 'started') {
        Tone.Transport.start();
        btn.textContent = '⏸ Pause';
      } else {
        Tone.Transport.stop();
        btn.textContent = '▶ Play';
      }
    });
  });

  // Pitch sliders (adjust Transport.bpm? No, we'll control playback rate of the sequences themselves if possible, but simpler: adjust the synth detune? Not ideal. We'll keep pitch as a display and instead let the user adjust deck gain? We'll just store it for now; actual pitch shifting would require buffer playback. We'll skip true pitch for now.)
  document.querySelectorAll('.pitch').forEach(slider => {
    slider.addEventListener('input', e => {
      // We'll just visually show the value, not actually change pitch (limitation of sequence-based)
      e.target.nextElementSibling.textContent = `Pitch: ${e.target.value}`;
    });
  });

  // Crossfader
  document.getElementById('crossfader').addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    if (deckAGain && deckBGain) {
      deckAGain.gain.value = 1 - val;
      deckBGain.gain.value = val;
    }
  });

  // Beat sequencer
  document.getElementById('play-beat').addEventListener('click', startBeat);
  document.getElementById('stop-beat').addEventListener('click', stopBeat);
  document.getElementById('bpm').addEventListener('change', e => {
    Tone.Transport.bpm.value = parseInt(e.target.value);
  });
  document.getElementById('random-beat').addEventListener('click', randomizeBeat);

  // Mixer controls
  document.querySelectorAll('.channel').forEach(ch => {
    const chan = ch.dataset.chan;
    if (!channels[chan] && chan !== 'master') return;
    const volSlider = ch.querySelector('.vol');
    const panSlider = ch.querySelector('.pan');
    const muteBtn = ch.querySelector('.mute-btn');
    const soloBtn = ch.querySelector('.solo-btn');
    const revSlider = ch.querySelector('.rev-send');
    const delSlider = ch.querySelector('.del-send');

    if (volSlider) {
      volSlider.addEventListener('input', e => {
        if (chan === 'master') masterGain.gain.value = parseFloat(e.target.value);
        else channels[chan].vol.gain.value = parseFloat(e.target.value);
      });
    }
    if (panSlider) {
      panSlider.addEventListener('input', e => {
        if (channels[chan]) channels[chan].pan.pan.value = parseFloat(e.target.value);
      });
    }
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        channels[chan].mute = !channels[chan].mute;
        muteBtn.classList.toggle('active', channels[chan].mute);
        updateChannelRouting();
      });
    }
    if (soloBtn) {
      soloBtn.addEventListener('click', () => {
        channels[chan].solo = !channels[chan].solo;
        soloBtn.classList.toggle('active', channels[chan].solo);
        updateChannelRouting();
      });
    }
    if (revSlider && channels[chan]) {
      revSlider.addEventListener('input', e => {
        channels[chan].reverbSend.gain.value = parseFloat(e.target.value);
      });
    }
    if (delSlider && channels[chan]) {
      delSlider.addEventListener('input', e => {
        channels[chan].delaySend.gain.value = parseFloat(e.target.value);
      });
    }
  });

  // Master EQ
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

function updateChannelRouting() {
  const anySolo = Object.values(channels).some(ch => ch.solo);
  for (const name in channels) {
    channels[name].vol.mute = anySolo ? !channels[name].solo : channels[name].mute;
  }
}

function buildSequencerUI() {
  ['kick','snare','hihat','clap'].forEach(sample => {
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
  if (!audioReady || beatPlaying) return;
  beatPlaying = true;
  Tone.Transport.bpm.value = parseInt(document.getElementById('bpm').value) || 120;
  if (!Tone.Transport.state === 'started') Tone.Transport.start();
  const events = [];
  for (let i = 0; i < 16; i++) {
    const time = `0:${i}:0`;
    ['kick','snare','hihat','clap'].forEach(sample => {
      if (steps[sample][i]) events.push({ time, sample });
    });
  }
  beatPart = new Tone.Part((time, evt) => {
    if (evt.sample === 'kick') kickSynth.triggerAttackRelease('C1', '8n', time);
    else if (evt.sample === 'snare') snareSynth.triggerAttackRelease('8n', time);
    else if (evt.sample === 'hihat') hihatSynth.triggerAttackRelease('16n', time);
    else if (evt.sample === 'clap') clapSynth.triggerAttackRelease('8n', time);
    // highlight step
    const idx = Math.floor(Tone.Transport.position.split(':')[1]) || 0;
    document.querySelectorAll('.step').forEach(s => s.classList.remove('current'));
    document.querySelectorAll(`#steps-${evt.sample} .step`)[idx]?.classList.add('current');
  }, events).start(0);
  beatPart.loop = 16;
  beatPart.loopEnd = '1:0:0';
}

function stopBeat() {
  beatPlaying = false;
  if (beatPart) beatPart.dispose();
  document.querySelectorAll('.step').forEach(s => s.classList.remove('current'));
}

function randomizeBeat() {
  ['kick','snare','hihat','clap'].forEach(sample => {
    for (let i = 0; i < 16; i++) {
      steps[sample][i] = Math.random() < (sample==='kick'?0.35:sample==='snare'?0.25:0.2);
    }
  });
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

// ---------- AI MELODY ----------
async function tryLoadMagenta() {
  try {
    musicVAE = new music_vae.MusicVAE('https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_2bar_small');
    await musicVAE.initialize();
    console.log('Magenta loaded');
  } catch (e) {
    console.warn('Magenta not loaded – using fallback composer');
  }
  document.getElementById('generate-melody').disabled = false;
}

function fallbackMelody() {
  const scale = ["C4","Eb4","F4","G4","Bb4"];
  const rhythm = [0.25,0.5,0.75,0.25,0.5];
  const notes = [];
  let t = 0;
  for (let i = 0; i < 8; i++) {
    const pitch = scale[Math.floor(Math.random()*scale.length)];
    const dur = rhythm[Math.floor(Math.random()*rhythm.length)];
    notes.push({ pitch, time: t, dur });
    t += dur;
  }
  return notes;
}

async function generateMelody() {
  document.getElementById('generate-melody').disabled = true;
  let notes;
  if (musicVAE) {
    try {
      const sample = await musicVAE.sample(1);
      notes = sample[0].notes.map(n => ({
        pitch: Tone.Frequency(n.pitch, "midi").toNote(),
        time: n.startTime,
        dur: n.endTime - n.startTime
      }));
    } catch (e) { notes = fallbackMelody(); }
  } else {
    notes = fallbackMelody();
  }
  melodyNotes = notes;
  document.getElementById('melody-display').textContent = notes.map(n => `${n.pitch} (${n.time.toFixed(1)}s)`).join(' | ');
  drawPianoRoll(notes);
  document.getElementById('generate-melody').disabled = false;
  document.getElementById('play-melody').disabled = false;
}

function playMelody() {
  stopMelody();
  if (!audioReady || !melodyNotes.length) return;
  if (Tone.Transport.state !== 'started') Tone.Transport.start();
  melodyPart = new Tone.Part((time, n) => {
    melodySynth.triggerAttackRelease(n.pitch, n.dur, time);
  }, melodyNotes).start(0);
  const totalDur = melodyNotes.reduce((max, n) => Math.max(max, n.time + n.dur), 0);
  melodyPart.loop = true;
  melodyPart.loopEnd = totalDur;
}

function stopMelody() {
  if (melodyPart) {
    melodyPart.dispose();
    melodySynth.releaseAll();
    melodyPart = null;
  }
}

function drawPianoRoll(notes) {
  const canvas = document.getElementById('piano-roll');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const noteMap = {C:0,D:1,E:2,F:3,G:4,A:5,B:6};
  notes.forEach(n => {
    const x = n.time * 75;
    const y = 80 - (noteMap[n.pitch[0]] + (parseInt(n.pitch[1])-4)*7) * 8;
    ctx.fillStyle = '#58cc02';
    ctx.fillRect(x, y, n.dur*75, 6);
  });
}

// ---------- VISUALIZER ----------
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
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#58cc02';
    ctx.beginPath();
    const sliceWidth = canvas.width / dataArray.length;
    let x = 0;
    for (let i=0; i<dataArray.length; i++) {
      const v = dataArray[i]/128.0;
      const y = v * canvas.height/2;
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      x += sliceWidth;
    }
    ctx.stroke();
  }
  draw();
}

// ---------- EXPORT ----------
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
    a.download = 'beatforge-pro-export.webm';
    a.click();
    URL.revokeObjectURL(url);
    masterGain.disconnect(dest);
  };
  mediaRecorder.start();
  setTimeout(() => mediaRecorder.stop(), 8000);
}
