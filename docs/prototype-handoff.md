# Wavetable synth — handoff spec

2026-11-02 · 

## Overview

A wavetable synth whose table set is not fixed: new single-cycle waveforms are continually generated or mutated and appended to a growing array, and each voice plays from a movable window over that array.

The prototype (full source at the end) is a single-file browser sketch built in a chat session on a phone. It proves out the ideas: generators (basic waves, formulas, Perlin noise, cellular automata), mutations with a live preview, linear/log/chain batches, a 48-table history, three sequenced playbacks with independent windows and LFOs, and undo.

The core idea to keep: the array is the orbit of a small dynamical system. A batch or an Evolve run produces a trajectory of related tables, and a playback window scans a stretch of that trajectory.

## Architecture

One shared table array feeds three independent playbacks; generation writes to the array, playbacks only read windows of it.

| Part | Prototype behavior | Notes for the real version |
|---|---|---|
| Table array | Ring of up to 48 tables, 2048 samples each, oldest dropped first | Store a recipe (generator + params + seed) with each table so it can be re-rendered or edited |
| Playback (A, B, C) | Own 16-step pattern, octave −2…+2, mute, window start/end, position, LFO depth/rate, Blend or Step interpolation | Polyphony, per-playback envelope/filter, more LFO shapes |
| Window following | A single add extends any window whose end is on the newest table; a batch sets the window of each checked playback to the batch | Keep both behaviors; they felt right |
| Sequencer | Shared clock, 16 eighth-note steps, A minor pentatonic over 8 rows | Pattern length, scale, swing, per-step velocity |
| Audio engine | ScriptProcessorNode, 4096-sample buffer, LFO and window updated every 256 samples | Move to an AudioWorklet or native code; keep block-rate modulation |
| UI | Transport bar; collapsible Generate (Seed / Mutate / Automata tabs), History, Playback A–C | Redraw only open sections; mobile-first worked well |
| Undo | Snapshot of array refs, selection, windows and patterns; 40 steps; covers adds and note edits, not sliders | Tables are immutable, so snapshots are cheap reference copies |

Tables are never modified in place. Every operation produces a new table, which keeps undo, preview and audio-thread handoff simple.

## Table pipeline

Every new table passes through the same `shape()` step, which is what makes any two tables safe to crossfade.

1. FFT the 2048-sample cycle.
2. Remove DC (bin 0) and zero every harmonic above KMAX = 72. Optionally apply a Gaussian low-pass `exp(-(k/kc)^2)` (used by Smooth).
3. Rotate the cycle so the fundamental's phase matches a sine (phase −π/2). Aligned fundamentals are why Blend interpolation does not comb-filter.
4. Inverse FFT and peak-normalize to ±1.

KMAX = 72 keeps the top note in the prototype (D4, 293.66 Hz) under Nyquist at 48 kHz. For octave shifts, each table also gets reduced-harmonic copies at 36, 18, 9 and 4 harmonics. Per note, the engine picks the first copy where `freq × K < 0.45 × sampleRate`. The real version should use a full per-octave mip set built off the audio thread.

Nonlinear operations (Fold) run at 4× oversampling before `shape()` band-limits the result. Every filter or convolution is circular, so the loop point never gets a seam.

Playback reads tables with linear interpolation within the cycle. In Blend mode it crossfades the two nearest tables by the fractional window position. In Step mode it holds one table and switches only when the oscillator phase wraps, which avoids clicks.

## Generators

Four generator families exist; all of them can add one table or a batch of N.

| Generator | How it works | Batch behavior |
|---|---|---|
| Basic waves | Sine, triangle, saw, square built additively; 25% and 10% pulses built naively, then band-limited | Single add only |
| Formula | JavaScript expression in `p` (0–2π), `t` (0–1), `n` (batch index), `u` (0–1 across the batch), evaluated inside `with(Math)` | N tables; `u` and `n` vary per table |
| Perlin noise | `pnoise(freq, z, octaves, persistence)` samples 3D fBm on a circle of radius `freq`, so the cycle loops seamlessly; `z` moves through the noise | Same random region for the whole batch, so `z` drift gives related tables |
| Cellular automaton | 1D elementary CA, 8–64 cells, random start; each generation's cells become ±1 steps of one table | N consecutive generations |

Formula presets in the prototype, grouped as Perlin, Shapers, Phase, Spectral, Fractal, Geometry, Bits and Math, each use `u` or `n` so +N gives a sweep. Examples: Chebyshev `cos((n+2)*acos(0.95*sin(p)))`, CZ phase distortion, prime and Fibonacci harmonic series, Weierstrass and blancmange fractals, polygon radius, and bytebeat bit tricks.

CA rules offered: 30 and 45 (chaotic), 73 (stripes), 90, 105 and 150 (fractal), 110 (structured), 184 (drifting, the smoothest to scan).

## Mutations and batch modes

Each mutation maps an Amount from 0 to 1 onto the source table, and 0 must always return the source unchanged.

| Group | Mutation | Amount mapping (a = Amount) |
|---|---|---|
| Morph | Toward saw / square / triangle | Time-domain blend `(1−a)·x + a·target`; targets are phase-aligned additive tables |
| Morph | Toward sine | Harmonics ≥ 2 scaled by `(1−a)²` |
| Morph | Toward noise | Blend toward a seeded Perlin table |
| Waveshape | Fold | Triangle folder at gain `1 + 3a`, 4× oversampled; identity at a = 0 |
| Waveshape | Fold + smooth | Fold, then Smooth at `a/2` |
| Waveshape | Self phase mod | Read x at `i + a·N·0.3·x[i]` |
| Waveshape | Hard sync | Read x at `(i·(1+3a)) mod N` |
| Waveshape | Ring mod | Multiply by `(1−a) + a·sin(m·p)`, m seeded from 2–7 |
| Waveshape | Rectify | Blend toward `2·abs(x) − 1` |
| Waveshape | Crush | Quantize to `round(2 + 62·(1−a)³)` levels; identity at a = 0 |
| Waveshape | Phase warp / Noise warp | Offset read position by a sine or by seeded Perlin noise, scaled by a |
| Spectral | Smooth | Gaussian low-pass, cutoff `2 / a^1.5` harmonics; identity at a = 0 |
| Spectral | Spread up | Each harmonic leaks `a·(k−1)/k` of the one below |
| Spectral | Stretch | Harmonic k moves to `round(k·(1 + 0.6a))`; fundamental fixed |
| Spectral | Comb | Weight `(1−a) + a·(0.5 + 0.5·cos(2π(k−1)/6))` |
| Spectral | Formant | Boost of up to 3× around a seeded center harmonic 4–24 |
| Spectral | Blur | Magnitudes mixed with neighbors by a; phases kept |
| Spectral | Odd only | Even harmonics scaled by `(1−a)²` |
| Random | Jitter | Seeded magnitude and phase noise plus faint new harmonics |
| Random | Scramble | Seeded phase offsets up to `a·π`; magnitudes kept |
| Random | Breed | Magnitudes pulled toward a seeded table from the first checked playback's window |

Batch modes for Apply N, with A = Amount:

- **Linear sweep:** table i uses `A·i/N`.
- **Log sweep:** table i uses `A·64^((i−N)/(N−1))`, a 64:1 geometric range ending at A. Best for Fold, Self phase mod and Hard sync, where small amounts already change a lot.
- **Chain:** each table mutates the previous one at A, compounding.

Randomness is seeded. The preview, Apply, and every table in a sweep use the same seed, so the preview matches the result and a random sweep is one direction growing gradually. A new seed is drawn after each Apply, or on Reroll.

## Lessons from the prototype

The bugs and surprises worth carrying forward:

- **0% must mean no change.** A sine folder at gain 1 turned triangles into sines; Smooth, Comb and Crush also altered tables at 0%. Test every mutation for identity at a = 0.
- **Perceptual amount curves.** Linear harmonic scaling left "toward sine" sounding unchanged until near 100%. Squared curves and log sweeps fixed it.
- **Seed the randomness.** Without a fixed seed, the preview and the applied result differed.
- **Keep the audio thread free.** Redrawing nine canvases per frame starved the ScriptProcessor and broke playback. Resize canvases only when their size changes, cache theme colors, and cap redraws near 25 fps.
- **Canvas sizing.** Reading a canvas's height back after scaling for device pixel ratio made it grow on every redraw. Keep the CSS height in a separate attribute.
- **JavaScript ****`-x**2`**** is a syntax error.** One instance in a mutation silently killed the whole script. Use `pow()` or `-(x*x)`.
- **Mobile layout.** Buttons, dropdowns and borders all pushed the page wider than the screen; `min-width: 0`, `box-sizing: border-box` and short option labels fixed it.

## Suggested next steps

- Pick the target: plugin (JUCE / C++), standalone app, or a web app on AudioWorklet
- Store a recipe with every table (generator or mutation, params, seed, parent ids) for re-rendering, editing and branching
- Full per-octave mip sets, built on a background thread and handed to audio lock-free
- Polyphony and MIDI input; per-playback envelope and filter
- Spectral (magnitude/phase) interpolation as a third blend mode
- Pin tables so the ring never evicts them; save and load table sets
- Draw-a-waveform and image-contour generators, which were discussed but not built

## Full prototype source

This is the final version from the session, unchanged, split into two blocks: the markup and styles, then the script that goes directly after them. It was rendered inside claude.ai, so it relies on host CSS variables (`--text-accent`, `--text-pro`, `--text-warning`, `--text-success`, `--text-primary`, `--text-secondary`, `--text-muted`, `--text-danger`, `--bg-accent`, `--surface-1`, `--border`, `--border-stronger`, `--border-accent`, `--radius`, `--font-mono`) and the Tabler icon font (`ti` classes). To run it standalone, put both blocks in one HTML page, define those variables, and load Tabler Icons.

### Markup and styles

```
<style>
.wrap,.wrap *{box-sizing:border-box}
.wrap{width:100%;max-width:100%;overflow-x:hidden}
.wrap button,.wrap select,.wrap input{min-width:0;max-width:100%}
.r{display:flex;align-items:center;gap:6px;margin:0 0 8px;width:100%}
.r>*{min-width:0}
.g2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 12px;margin:0 0 8px}
.g2>div{min-width:0}
.s{font-size:12px;color:var(--text-secondary);display:flex;justify-content:space-between;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;min-height:18px}
.g2 input[type=range],.g2 select{width:100%;margin:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
canvas{display:block;width:100%;max-width:100%;border:0.5px solid var(--border);border-radius:var(--radius)}
.wrap button{font-size:13px;flex:1 1 0;padding:0 3px;white-space:nowrap;overflow:hidden}
.wb button{font-size:12px}
.wb i{font-size:18px}
details.sec{border-top:0.5px solid var(--border);padding:0 0 4px}
details.sec>summary{list-style:none;display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 0;font-size:15px;font-weight:500;color:var(--text-primary)}
details.sec>summary::-webkit-details-marker{display:none}
.chev{font-size:16px;color:var(--text-secondary);transition:transform .15s}
details[open]>summary .chev{transform:rotate(180deg)}
.tabs{background:var(--surface-1);padding:3px;border-radius:var(--radius);gap:3px}
.wrap .tabs button{border:0.5px solid transparent;background:transparent;color:var(--text-secondary);height:32px}
.wrap .tabs button[aria-selected="true"]{background:var(--bg-accent);color:var(--text-accent);border-color:var(--border-accent);font-weight:500}
.wrap .mini{flex:0 0 auto;height:18px;font-size:11px;padding:0 6px;line-height:16px}
.cb{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:500;cursor:pointer}
.cb input{width:16px;height:16px;margin:0}
.hint{font-size:12px;color:var(--text-secondary);margin:0 0 8px;line-height:1.5}
</style>
<div class="wrap">
<h2 class="sr-only">Wavetable synth with undo, collapsible sections: transport, Generate with Seed, Mutate and Automata tabs, History timeline, and three playback tracks.</h2>
<div class="r" style="margin:4px 0 10px">
<button id="play" style="flex:0 0 56px;height:40px" aria-label="Play"><i class="ti ti-player-play" aria-hidden="true" style="font-size:20px"></i></button>
<button id="undo" style="flex:0 0 64px;height:40px" aria-label="Undo"><i class="ti ti-arrow-back-up" aria-hidden="true" style="font-size:18px;vertical-align:-3px"></i> <span id="uc" style="font-size:12px;color:var(--text-secondary)">0</span></button>
<div style="flex:1 1 0"><div class="s"><span>Tempo</span><span id="v_bp">132</span></div><input type="range" id="bp" data-g min="60" max="200" step="1" value="132" style="width:100%;margin:0"></div>
</div>

<details class="sec" id="dGen" open><summary><i class="ti ti-chevron-down chev" aria-hidden="true"></i><span style="flex:1">Generate</span></summary>
<div class="g2">
<div><div class="s"><span>Count (N)</span><span id="v_ct">8</span></div><input type="range" id="ct" data-g min="1" max="16" step="1" value="8"></div>
<div><div class="s"><span>Batch sets window of</span></div><div style="display:flex;gap:14px;height:28px;align-items:center">
<label class="cb" style="color:var(--text-accent)"><input type="checkbox" id="bw0" checked>A</label>
<label class="cb" style="color:var(--text-pro)"><input type="checkbox" id="bw1">B</label>
<label class="cb" style="color:var(--text-warning)"><input type="checkbox" id="bw2">C</label>
</div></div>
</div>
<div class="r tabs" role="tablist"><button id="tabSeed" role="tab" aria-selected="true">Seed</button><button id="tabMut" role="tab" aria-selected="false">Mutate</button><button id="tabCA" role="tab" aria-selected="false">Automata</button></div>
<div id="panSeed" role="tabpanel">
<div class="r wb">
<button data-w="sine" aria-label="Add sine"><i class="ti ti-wave-sine" aria-hidden="true"></i></button>
<button data-w="tri" aria-label="Add triangle">Tri</button>
<button data-w="saw" aria-label="Add saw"><i class="ti ti-wave-saw-tool" aria-hidden="true"></i></button>
<button data-w="square" aria-label="Add square"><i class="ti ti-wave-square" aria-hidden="true"></i></button>
<button data-w="p25" aria-label="Add 25% pulse">P25</button>
<button data-w="p10" aria-label="Add 10% pulse">P10</button>
<button data-w="noise" aria-label="Add Perlin noise wave">Noise</button>
</div>
<div class="r"><select id="preset" style="flex:0 0 30%;font-size:13px" aria-label="Formula preset">
<optgroup label="Perlin">
<option value="pnoise(2, u*1.5, 4, 0.5)">Drift</option>
<option value="pnoise(1+u*5, 0, 4, 0.5)">Zoom</option>
<option value="pnoise(2, 0, 1+n, 0.6)">Add octaves</option>
<option value="pnoise(3, u, 6, 0.3+u*0.5)">Roughen</option>
<option value="sin(p) + u*pnoise(4, 0, 3, 0.6)">Sine + noise</option>
<option value="sin(p + 3*u*pnoise(1.5, u, 3, 0.5))">Noisy FM</option>
</optgroup>
<optgroup label="Shapers">
<option value="tanh((1+5*u)*sin(p))/tanh(1+5*u)">Soft clip</option>
<option value="cos((n+2)*acos(0.95*sin(p)))">Chebyshev</option>
<option value="pow(pow(abs(cos(1.5*p)),2+u*6)+pow(abs(sin(1.5*p)),2+u*6),-0.5)">Superformula</option>
</optgroup>
<optgroup label="Phase">
<option value="sin(p + (0.5+u*2)*sin(2*p + 2*sin(3*p)))">Nested FM</option>
<option value="sin(2*PI*(t<0.5-0.45*u ? t/(2*(0.5-0.45*u)) : 0.5+(t-(0.5-0.45*u))/(2*(0.5+0.45*u))))">CZ phase dist</option>
<option value="sin(p + 2*u*sin(p)*sin(3*p))">Cross PM</option>
</optgroup>
<optgroup label="Spectral">
<option value="[2,3,5,7,11,13,17,19,23,29].reduce((s,q)=>s+sin(q*p)/pow(q,1.5-u), sin(p))">Primes</option>
<option value="[1,2,3,5,8,13,21,34,55].reduce((s,q)=>s+sin(q*p)/pow(q,1-0.5*u),0)">Fibonacci</option>
<option value="[...Array(40)].reduce((s,_,k)=>s+sin(PI*(k+1)*(0.05+0.45*u))*sin((k+1)*p)/pow(k+1,2),0)">Pluck position</option>
</optgroup>
<optgroup label="Fractal">
<option value="[...Array(7)].reduce((s,_,k)=>s+pow(0.4+0.4*u,k)*cos(pow(2,k)*p),0)">Weierstrass</option>
<option value="[...Array(6)].reduce((s,_,k)=>s+pow(0.4+0.4*u,k)*abs(((pow(2,k)*t+0.5)%1)-0.5),0)">Blancmange</option>
</optgroup>
<optgroup label="Geometry">
<option value="cos(PI/(n+3))/cos((p%(2*PI/(n+3)))-PI/(n+3))">Polygon</option>
<option value="exp(-pow((t-0.2-0.5*u)/0.05,2)) - exp(-pow((t-0.7)/0.08,2))">Gauss bumps</option>
<option value="sin((4+12*u)*PI*(t-0.5)+1e-6)/((4+12*u)*PI*(t-0.5)+1e-6)">Sinc</option>
</optgroup>
<optgroup label="Bits">
<option value="((floor(t*256)*(floor(t*256)>>3|floor(t*256)>>(5+n%3)))&amp;255)/128-1">Bytebeat</option>
<option value="((floor(t*64)^(floor(t*64)>>1))&amp;(n+7))/(n+7)*2-1">Gray code</option>
</optgroup>
<optgroup label="Math">
<option value="sin(p + u*4*sin(2*p))">FM sweep</option>
<option value="sin((n+1)*p)">Harmonics</option>
<option value="sin(p*(1+u*3))">Sync sweep</option>
<option value="(1-u)*sin(p) + u*(t*2-1)">Sine→saw</option>
</optgroup>
</select><input id="expr" type="text" value="pnoise(2, u*1.5, 4, 0.5)" style="flex:1 1 0;font-family:var(--font-mono);font-size:12px" aria-label="Expression in p, t, n, u, with pnoise"><button id="gen1" style="flex:0 0 38px">+1</button><button id="genN" style="flex:0 0 38px">+N</button></div>
<div id="err" style="font-size:12px;color:var(--text-danger)"></div>
</div>
<div id="panMut" role="tabpanel">
<div class="g2">
<div><div class="s"><span id="srcl">Source #1</span><span style="color:var(--text-muted)">tap History</span></div><canvas id="mw1" data-h="50" style="height:50px" aria-label="Source waveform"></canvas><canvas id="mf1" data-h="26" style="height:26px;margin-top:3px" aria-label="Source spectrum"></canvas></div>
<div><div class="s"><span>Preview</span><button class="mini" id="reroll" aria-label="Reroll the random choices in this preview"><i class="ti ti-dice-5" aria-hidden="true" style="font-size:13px;vertical-align:-2px"></i> Reroll</button></div><canvas id="mw2" data-h="50" style="height:50px" aria-label="Preview of Apply result waveform"></canvas><canvas id="mf2" data-h="26" style="height:26px;margin-top:3px" aria-label="Preview of Apply result spectrum"></canvas></div>
</div>
<div class="g2">
<div><div class="s"><span>Mutation</span></div><select id="op" data-g style="font-size:13px" aria-label="Mutation">
<optgroup label="Morph">
<option value="toSaw">Toward saw</option><option value="toSine">Toward sine</option><option value="toSquare">Toward square</option><option value="toTri">Toward triangle</option><option value="toNoise">Toward noise</option>
</optgroup><optgroup label="Waveshape">
<option value="foldSmooth">Fold + smooth</option><option value="fold">Fold</option><option value="pm">Self phase mod</option><option value="sync">Hard sync</option><option value="ring">Ring mod</option><option value="rect">Rectify</option><option value="crush">Crush</option><option value="warp">Phase warp</option><option value="nwarp">Noise warp</option>
</optgroup><optgroup label="Spectral">
<option value="smooth">Smooth</option><option value="spread">Spread up</option><option value="stretch">Stretch</option><option value="comb">Comb</option><option value="formant">Formant</option><option value="blur">Blur</option><option value="odd">Odd only</option>
</optgroup><optgroup label="Random">
<option value="jitter">Jitter</option><option value="scramble">Scramble</option><option value="breed">Breed</option>
</optgroup>
</select></div>
<div><div class="s"><span>Amount</span><span id="v_am">25%</span></div><input type="range" id="am" data-g min="0" max="1" step="0.01" value="0.25"></div>
<div><div class="s"><span>Batch mode</span></div><select id="md" data-g style="font-size:13px" aria-label="Batch mode"><option value="lin">Linear sweep</option><option value="log">Log sweep</option><option value="chain">Chain</option></select></div>
<div><div class="s"><span>Steps</span></div><div id="stepsl" style="font-size:12px;color:var(--text-secondary);font-family:var(--font-mono);line-height:28px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div></div>
</div>
<div class="r"><button id="apply1">Apply</button><button id="applyN">Apply N</button><button id="auto">Evolve</button></div>
</div>
<div id="panCA" role="tabpanel">
<p class="hint">A row of cells, each on or off, becomes one stepped waveform. A rule decides each cell's next state from its neighbours, giving a new row, which becomes the next table.</p>
<div class="g2">
<div><div class="s"><span>Rule</span></div><select id="cr" data-g style="font-size:13px" aria-label="Cellular automaton rule"><option value="30">30 · chaotic</option><option value="45">45 · chaotic</option><option value="73">73 · stripes</option><option value="90">90 · fractal</option><option value="105">105 · fractal</option><option value="110">110 · structured</option><option value="150">150 · fractal</option><option value="184">184 · drifting</option></select></div>
<div><div class="s"><span>Cells</span><span id="v_cc">32</span></div><input type="range" id="cc" data-g min="8" max="64" step="4" value="32"></div>
</div>
<div class="r"><button id="ca">Add N generations</button></div>
</div>
</details>

<details class="sec" id="dHist" open><summary><i class="ti ti-chevron-down chev" aria-hidden="true"></i><span style="flex:1">History</span><span class="s" id="hcount" style="flex:0 0 auto"></span></summary>
<div class="g2">
<div><div class="s"><span>Newest</span><span id="l1"></span></div><canvas id="w1" data-h="50" style="height:50px" aria-label="Newest table waveform"></canvas><canvas id="f1" data-h="26" style="height:26px;margin-top:3px" aria-label="Newest table spectrum"></canvas></div>
<div><div class="s"><span>Selected</span><span id="l2"></span></div><canvas id="w2" data-h="50" style="height:50px" aria-label="Selected table waveform"></canvas><canvas id="f2" data-h="26" style="height:26px;margin-top:3px" aria-label="Selected table spectrum"></canvas></div>
</div>
<canvas id="strip" data-h="48" style="height:48px;cursor:pointer;margin-bottom:6px" aria-label="Timeline of all tables with playback windows, tap to select a table"></canvas>
</details>

<div id="tracks"></div>
</div>
```

### Script

```
<script>
const N=2048,CAP=48,KMAX=72,KV=40,SC=[110,130.81,146.83,164.81,196,220,261.63,293.66],BLK=256,MIPK=[72,36,18,9,4],TC=['--text-accent','--text-pro','--text-warning'],TN=['A','B','C'],UMAX=40,LOGR=64;
let arr=[],sel=0,timer=null,ctx=null,sp=null,playing=false,step=-1,toNext=0,lastDraw=0,clip=null,tab='seed',pv=null,pvSeed=(Math.random()*1e9)|0,pvT=null;
const cache=new WeakMap(),MC=new WeakMap(),UNDO=[];
function mkTrack(o){return Object.assign({pat:Array(16).fill(-1),oct:0,ip:'on',mute:false,wa:0,wb:0,pp:0.3,ld:0.6,lr:0.25,lfoPh:0,ph:0,freq:110,tNote:1e9,curPos:0.3,held:null,heldIdx:0,A:null,B:null,fr:0,f:0,aA:null,aB:null,hA:null},o);}
const TR=[mkTrack({pat:[0,-1,3,-1,4,4,-1,2,0,-1,5,4,-1,3,2,-1],oct:0,pp:0.3,ld:0.6,lr:0.25}),
mkTrack({pat:[-1,-1,7,-1,-1,5,-1,-1,-1,-1,6,-1,4,-1,-1,-1],oct:1,pp:0.75,ld:0.3,lr:0.11,lfoPh:1.5}),
mkTrack({pat:[0,-1,-1,-1,0,-1,-1,-1,3,-1,-1,-1,2,-1,-1,-1],oct:-1,ip:'off',mute:true,pp:0.5,ld:0.9,lr:1.2,lfoPh:3})];
const $=id=>document.getElementById(id);
$('tracks').innerHTML=TR.map((t,i)=>`<details class="sec" id="d${i}"${i===0?' open':''}><summary><i class="ti ti-chevron-down chev" aria-hidden="true"></i><span style="flex:1;color:var(${TC[i]})">Playback ${TN[i]}</span><span class="s" id="pl${i}" style="flex:0 0 auto"></span><button id="mute${i}" style="flex:0 0 36px;height:30px" aria-label="Mute playback ${TN[i]}"></button></summary>
<div class="g2"><canvas id="wv${i}" data-h="56" style="height:56px" aria-label="Playback ${TN[i]} waveform"></canvas><canvas id="fv${i}" data-h="56" style="height:56px" aria-label="Playback ${TN[i]} spectrum"></canvas></div>
<div class="g2">
<div><div class="s"><span>Window start</span><span id="v_wa${i}"></span></div><input type="range" id="wa${i}" min="0" max="0" step="1" value="0"></div>
<div><div class="s"><span>Window end</span><span id="v_wb${i}"></span></div><input type="range" id="wb${i}" min="0" max="0" step="1" value="0"></div>
<div><div class="s"><span>Position</span><span id="v_pp${i}"></span></div><input type="range" id="pp${i}" min="0" max="1" step="0.01" value="${t.pp}"></div>
<div><div class="s"><span>LFO depth</span><span style="display:flex;gap:6px;align-items:center"><span id="v_ld${i}"></span><button class="mini" id="full${i}" aria-label="Sweep the whole window: position 50%, depth 100%">Full</button></span></div><input type="range" id="ld${i}" min="0" max="1" step="0.01" value="${t.ld}"></div>
<div><div class="s"><span>LFO rate</span><span id="v_lr${i}"></span></div><input type="range" id="lr${i}" min="0.02" max="4" step="0.01" value="${t.lr}"></div>
<div><div class="s"><span>Octave</span><span>Blend</span></div><div style="display:flex;gap:6px"><select id="oc${i}" style="flex:1 1 0;font-size:13px" aria-label="Playback ${TN[i]} octave">${[-2,-1,0,1,2].map(o=>`<option value="${o}"${o===t.oct?' selected':''}>${o>0?'+'+o:o<0?'−'+(-o):'0'}</option>`).join('')}</select><select id="ip${i}" style="flex:1 1 0;font-size:13px" aria-label="Playback ${TN[i]} interpolation"><option value="on"${t.ip==='on'?' selected':''}>Blend</option><option value="off"${t.ip==='off'?' selected':''}>Step</option></select></div></div>
</div>
<div class="r"><span class="s" style="flex:0 0 auto">Notes</span><button id="cp${i}">Copy</button><button id="ps${i}">Paste</button><button id="clr${i}">Clear</button><button id="rnd${i}" style="flex:0 0 40px" aria-label="Randomize playback ${TN[i]} notes"><i class="ti ti-arrows-shuffle" aria-hidden="true"></i></button></div>
<canvas id="grid${i}" data-h="96" style="height:96px;cursor:pointer;margin-bottom:6px" aria-label="Playback ${TN[i]} 16-step pattern, tap to edit"></canvas>
</details>`).join('');
const P={};
function readP(){document.querySelectorAll('[data-g]').forEach(el=>P[el.id]=el.value);}
readP();
function rng(seed){let s=seed>>>0;return()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const PERM=(()=>{const r=rng(1234),p=[...Array(256).keys()];for(let i=255;i>0;i--){const j=Math.floor(r()*(i+1));[p[i],p[j]]=[p[j],p[i]];}return p.concat(p);})();
function fade(t){return t*t*t*(t*(t*6-15)+10);}
function grad(h,x,y,z){const g=h&15,u=g<8?x:y,v=g<4?y:(g===12||g===14?x:z);return((g&1)?-u:u)+((g&2)?-v:v);}
function noise3(x,y,z){const X=Math.floor(x)&255,Y=Math.floor(y)&255,Z=Math.floor(z)&255;x-=Math.floor(x);y-=Math.floor(y);z-=Math.floor(z);
const u=fade(x),v=fade(y),w=fade(z),A=PERM[X]+Y,AA=PERM[A]+Z,AB=PERM[A+1]+Z,B=PERM[X+1]+Y,BA=PERM[B]+Z,BB=PERM[B+1]+Z,L=(a,b,t)=>a+t*(b-a);
return L(L(L(grad(PERM[AA],x,y,z),grad(PERM[BA],x-1,y,z),u),L(grad(PERM[AB],x,y-1,z),grad(PERM[BB],x-1,y-1,z),u),v),
L(L(grad(PERM[AA+1],x,y,z-1),grad(PERM[BA+1],x-1,y,z-1),u),L(grad(PERM[AB+1],x,y-1,z-1),grad(PERM[BB+1],x-1,y-1,z-1),u),v),w);}
function fbm(x,y,z,oct,pers){let s=0,a=1,f=1,norm=0;oct=Math.max(1,Math.min(10,Math.round(oct)));for(let o=0;o<oct;o++){s+=a*noise3(x*f,y*f,z*f);norm+=a;a*=pers;f*=2;}return s/norm;}
let NZ={ox:0,oy:0,oz:0,p:0};
function newOffsets(r){r=r||Math.random;NZ.ox=r()*200;NZ.oy=r()*200;NZ.oz=r()*200;}
function pnoise(fr,z,oct,pers){fr=fr===undefined?2:fr;z=z||0;oct=oct===undefined?4:oct;pers=pers===undefined?0.5:pers;return fbm(Math.cos(NZ.p)*fr+NZ.ox,Math.sin(NZ.p)*fr+NZ.oy,z+NZ.oz,oct,pers);}
function noiseTable(fr,z,oct,pers){const x=new Float64Array(N);for(let i=0;i<N;i++){NZ.p=2*Math.PI*i/N;x[i]=pnoise(fr,z,oct,pers);}return x;}
function fft(re,im,inv){const n=re.length;for(let i=1,j=0;i<n;i++){let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
for(let len=2;len<=n;len<<=1){const a=(inv?2:-2)*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let k=0;k<len/2;k++){const u=i+k,v=u+len/2,tr=re[v]*cr-im[v]*ci,ti=re[v]*ci+im[v]*cr;re[v]=re[u]-tr;im[v]=im[u]-ti;re[u]+=tr;im[u]+=ti;const nc=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nc;}}}
if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}}
function shape(x,kc){const re=Float64Array.from(x),im=new Float64Array(N);fft(re,im,false);re[0]=im[0]=0;
for(let k=1;k<N/2;k++){const w=k>KMAX?0:(kc?Math.exp(-(k/kc)*(k/kc)):1);re[k]*=w;im[k]*=w;re[N-k]*=w;im[N-k]*=w;}re[N/2]=im[N/2]=0;
const phs=Math.atan2(im[1],re[1]);fft(re,im,true);const sh=Math.round((phs+Math.PI/2)/(2*Math.PI)*N);
const y=new Float32Array(N);let pk=0;for(let i=0;i<N;i++){y[i]=re[((i+sh)%N+N)%N];pk=Math.max(pk,Math.abs(y[i]));}
if(pk>1e-9)for(let i=0;i<N;i++)y[i]/=pk;return y;}
function bl(x,K){const re=Float64Array.from(x),im=new Float64Array(N);fft(re,im,false);for(let k=K+1;k<N/2;k++){re[k]=im[k]=re[N-k]=im[N-k]=0;}re[N/2]=im[N/2]=0;fft(re,im,true);return Float32Array.from(re);}
function mips(x){let m=MC.get(x);if(!m){m=[x];for(let l=1;l<MIPK.length;l++)m.push(bl(x,MIPK[l]));MC.set(x,m);}return m;}
function spec(x){if(cache.has(x))return cache.get(x);const re=Float64Array.from(x),im=new Float64Array(N);fft(re,im,false);const s={re:re.slice(0,KMAX+1),im:im.slice(0,KMAX+1)};cache.set(x,s);return s;}
function viaSpec(x,fn){const re=Float64Array.from(x),im=new Float64Array(N);fft(re,im,false);fn(re,im);for(let k=1;k<N/2;k++){re[N-k]=re[k];im[N-k]=-im[k];}fft(re,im,true);return shape(re,0);}
function polar(re,im,fn){for(let k=1;k<=KMAX;k++){const r=fn(k,Math.hypot(re[k],im[k]),Math.atan2(im[k],re[k]));re[k]=r[0]*Math.cos(r[1]);im[k]=r[0]*Math.sin(r[1]);}}
function additive(f){const x=new Float64Array(N);for(let k=1;k<=KMAX;k++){const a=f(k);if(!a)continue;for(let i=0;i<N;i++)x[i]+=a*Math.sin(2*Math.PI*k*i/N);}return shape(x,0);}
const T={saw:additive(k=>1/k),square:additive(k=>k%2?1/k:0),tri:additive(k=>k%2?((k-1)/2%2?-1:1)/(k*k):0)};
function pulse(d){const x=new Float64Array(N);for(let i=0;i<N;i++)x[i]=i<d*N?1:-1;return shape(x,0);}
const BASIC={sine:()=>additive(k=>k===1?1:0),tri:()=>T.tri,saw:()=>T.saw,square:()=>T.square,p25:()=>pulse(0.25),p10:()=>pulse(0.1),noise:()=>{newOffsets();return shape(noiseTable(2,0,4,0.5),0);}};
function caBatch(rule,cells,count){let row=[];const seedRow=()=>{row=Array.from({length:cells},()=>Math.random()<0.5?1:0);};seedRow();const out=[];
for(let g=0;g<count;g++){if(row.every(v=>v===row[0]))seedRow();const x=new Float64Array(N);for(let i=0;i<N;i++)x[i]=row[Math.floor(i*cells/N)]*2-1;out.push(shape(x,0));
const nr=new Array(cells);for(let c=0;c<cells;c++){const l=row[(c-1+cells)%cells],m=row[c],r=row[(c+1)%cells];nr[c]=(rule>>((l<<2)|(m<<1)|r))&1;}row=nr;}
return out;}
function lerpAt(x,f){f=((f%N)+N)%N;const j=Math.floor(f),t=f-j;return x[j]*(1-t)+x[(j+1)%N]*t;}
function mapT(fn){const y=new Float64Array(N);for(let i=0;i<N;i++)y[i]=fn(i);return shape(y,0);}
function toward(x,t,a){return mapT(i=>(1-a)*x[i]+a*t[i]);}
function triFold(v){const m=(((v+1)%4)+4)%4;return 1-Math.abs(m-2);}
function fold(x,g){const os=4;return mapT(i=>{let s=0;const b=(i+1)%N;for(let j=0;j<os;j++){const t=j/os;s+=triFold(g*(x[i]*(1-t)+x[b]*t));}return s/os;});}
function smoothBy(x,a){return a<=0.001?shape(x,0):shape(x,2/Math.pow(a,1.5));}
function targets(){return TR.map((_,i)=>i).filter(i=>$('bw'+i).checked);}
function breedRange(){const tg=targets();return tg.length?bounds(TR[tg[0]]):[0,arr.length-1];}
function mutate(x,a,seed){const rand=rng(seed),R=()=>rand()*2-1,q=Math.pow(1-a,2);
switch(P.op){
case'toSaw':return toward(x,T.saw,a);case'toSquare':return toward(x,T.square,a);case'toTri':return toward(x,T.tri,a);
case'toNoise':{newOffsets(rand);return toward(x,shape(noiseTable(2,0,4,0.5),0),a);}
case'toSine':return viaSpec(x,(re,im)=>{for(let k=2;k<N/2;k++){re[k]*=q;im[k]*=q;}});
case'fold':return fold(x,1+3*a);case'foldSmooth':return smoothBy(fold(x,1+3*a),a*0.5);
case'pm':return mapT(i=>lerpAt(x,i+a*N*0.3*x[i]));
case'sync':{const r=1+a*3;return mapT(i=>lerpAt(x,(i*r)%N));}
case'ring':{const m=2+Math.floor(rand()*6);return mapT(i=>x[i]*((1-a)+a*Math.sin(2*Math.PI*m*i/N)));}
case'rect':return mapT(i=>(1-a)*x[i]+a*(2*Math.abs(x[i])-1));
case'crush':{if(a<=0.001)return shape(x,0);const L=Math.max(2,Math.round(2+62*Math.pow(1-a,3)));return mapT(i=>Math.round(x[i]*L)/L);}
case'warp':return mapT(i=>lerpAt(x,i+a*N*0.12*Math.sin(2*Math.PI*i/N)));
case'nwarp':{newOffsets(rand);const w=noiseTable(1.5,0,3,0.5);return mapT(i=>lerpAt(x,i+a*N*0.25*w[i]));}
case'smooth':return smoothBy(x,a);
case'spread':return viaSpec(x,(re,im)=>{for(let k=KMAX;k>=2;k--){const s=a*(k-1)/k;re[k]+=s*re[k-1];im[k]+=s*im[k-1];}});
case'stretch':return viaSpec(x,(re,im)=>{const nr=new Float64Array(KMAX+1),ni=new Float64Array(KMAX+1);for(let k=1;k<=KMAX;k++){const t=k===1?1:Math.round(k*(1+a*0.6));if(t<=KMAX){nr[t]+=re[k];ni[t]+=im[k];}}for(let k=1;k<N/2;k++){re[k]=k<=KMAX?nr[k]:0;im[k]=k<=KMAX?ni[k]:0;}});
case'comb':return viaSpec(x,(re,im)=>polar(re,im,(k,m,p)=>[k===1?m:m*((1-a)+a*(0.5+0.5*Math.cos(2*Math.PI*(k-1)/6))),p]));
case'formant':{const c=4+rand()*20;return viaSpec(x,(re,im)=>polar(re,im,(k,m,p)=>{const d=(k-c)/3;return[k===1?m:m*((1-a)+a*3*Math.exp(-d*d)),p];}));}
case'blur':return viaSpec(x,(re,im)=>{const M=[];for(let k=0;k<=KMAX+1;k++)M[k]=k&&k<=KMAX?Math.hypot(re[k],im[k]):0;polar(re,im,(k,m,p)=>[k===1?m:(1-a)*m+a*0.5*(M[k-1]+M[k+1]),p]);});
case'odd':return viaSpec(x,(re,im)=>{for(let k=2;k<N/2;k+=2){re[k]*=q;im[k]*=q;}});
case'jitter':return viaSpec(x,(re,im)=>polar(re,im,(k,m,p)=>{const r1=R(),r2=rand(),r3=R();return k===1?[m,p]:[m*(1+a*r1)+a*N*0.06*r2/k,p+a*r3];}));
case'scramble':return viaSpec(x,(re,im)=>polar(re,im,(k,m,p)=>{const r1=R();return[m,k===1?p:p+a*Math.PI*r1];}));
case'breed':{const[lo,hi]=breedRange(),o=spec(arr[lo+Math.floor(rand()*(hi-lo+1))]);return viaSpec(x,(re,im)=>polar(re,im,(k,m,p)=>[(1-a)*m+a*Math.hypot(o.re[k],o.im[k]),p]));}}
return x;}
function sweepAmounts(n,A,mode){const out=[];for(let i=1;i<=n;i++)out.push(mode==='log'?(n>1?A*Math.pow(LOGR,(i-n)/(n-1)):A):A*i/n);return out;}
function stepsLabel(){const n=+P.ct,A=+P.am;let s;if(P.md==='chain')s=n+' × '+Math.round(A*100)+'%, compounding';else s=sweepAmounts(n,A,P.md).map(v=>v*100<10?(v*100).toFixed(1):Math.round(v*100)).join(' ');$('stepsl').textContent=s;$('stepsl').title=s;}
function snap(){UNDO.push({arr:arr.slice(),sel,tr:TR.map(t=>({wa:t.wa,wb:t.wb,pat:t.pat.slice()}))});if(UNDO.length>UMAX)UNDO.shift();updUndo();}
function updUndo(){$('uc').textContent=UNDO.length;$('undo').setAttribute('aria-label','Undo, '+UNDO.length+' steps available');}
function undo(){const s=UNDO.pop();if(!s)return;arr=s.arr;sel=Math.min(s.sel,arr.length-1);s.tr.forEach((o,i)=>{const t=TR[i];t.wa=o.wa;t.wb=o.wb;t.pat=o.pat;t.held=null;});updUndo();syncUI();}
function shiftTracks(){for(const t of TR){t.wa=Math.max(0,t.wa-1);t.wb=Math.max(0,t.wb-1);}sel=Math.max(0,sel-1);}
function addOne(x,selNew){snap();mips(x);const L=arr.length,fol=TR.map(t=>t.wb>=L-1);if(L>=CAP){arr.shift();shiftTracks();}
arr.push(x);TR.forEach((t,i)=>{if(fol[i])t.wb=arr.length-1;});if(selNew)sel=arr.length-1;syncUI();}
function addBatch(list,selNew){snap();list.forEach(mips);for(const x of list){if(arr.length>=CAP){arr.shift();shiftTracks();}arr.push(x);}
const L=arr.length;targets().forEach(i=>{const t=TR[i];t.wa=Math.max(0,L-list.length);t.wb=L-1;});if(selNew)sel=L-1;syncUI();}
function evalExpr(count){const e=$('expr').value;$('err').textContent='';
try{const f=new Function('p','t','n','u','pnoise','noise','with(Math){return ('+e+');}');const out=[];newOffsets();
for(let j=0;j<count;j++){const u=count>1?j/(count-1):0,x=new Float64Array(N);for(let i=0;i<N;i++){const pp=2*Math.PI*i/N;NZ.p=pp;const v=+f(pp,i/N,j,u,pnoise,noise3);if(!isFinite(v))throw 0;x[i]=v;}out.push(shape(x,0));}
return out;}catch(err){$('err').textContent='Couldn\'t evaluate. Use p, t, n, u, and pnoise(freq, z, octaves, persistence).';return null;}}
function newSeed(){pvSeed=(Math.random()*1e9)|0;}
function computePreview(){if(!arr.length)return;readP();pv=mutate(arr[sel],+P.am,pvSeed);drawMut();}
function schedulePv(){clearTimeout(pvT);pvT=setTimeout(computePreview,40);}
function applyN(){readP();const base=arr[sel],n=+P.ct,A=+P.am,seed=pvSeed,out=[];
if(P.md==='chain'){let c=base;for(let i=1;i<=n;i++){c=mutate(c,A,i===1?seed:seed+i*7919);out.push(c);}}
else sweepAmounts(n,A,P.md).forEach(a=>out.push(mutate(base,a,seed)));
newSeed();addBatch(out,false);}
function bounds(t){const n=arr.length;let a=Math.min(t.wa,n-1),b=Math.min(t.wb,n-1);if(a>b)[a,b]=[b,a];return[Math.max(0,a),Math.max(0,b)];}
function lfoPos(t){let p=t.pp+t.ld*0.5*Math.sin(t.lfoPh);p=Math.abs(p);if(p>1)p=2-p;return Math.max(0,Math.min(1,p));}
function tablesAt(t,pos){const[a,b]=bounds(t),f=a+pos*(b-a);if(t.ip==='off'){const i=Math.round(f);return[arr[i],arr[i],0,i];}const i=Math.floor(f),j=Math.min(i+1,b);return[arr[i],arr[j],f-i,f];}
let C={};function col(v){if(!(v in C))C[v]=getComputedStyle(document.body).getPropertyValue(v).trim()||'#888';return C[v];}
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{C={};draw();drawMut();styleMutes();});}catch(e){}
function fit(c){const w=Math.max(1,c.clientWidth),h=+c.dataset.h,d=devicePixelRatio||1;if(c._w!==w||c._d!==d){c.width=Math.round(w*d);c.height=Math.round(h*d);c._w=w;c._d=d;}const g=c.getContext('2d');g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,w,h);return[g,w,h];}
function mini(id,A,B,fr,color){const[g,w,h]=fit($(id));g.strokeStyle=col('--border');g.lineWidth=1;g.beginPath();g.moveTo(0,h/2);g.lineTo(w,h/2);g.stroke();
g.strokeStyle=color;g.lineWidth=1.75;g.beginPath();for(let i=0;i<w;i++){const k=Math.floor(i/w*N),v=A[k]+(B[k]-A[k])*fr,y=h/2-v*(h/2-5);i?g.lineTo(i,y):g.moveTo(i,y);}g.stroke();}
function fftView(id,A,B,fr,color){const[g,w,h]=fit($(id)),sa=spec(A),sb=spec(B),m=[];let mx=1e-12;
for(let k=1;k<=KV;k++){const re=sa.re[k]+(sb.re[k]-sa.re[k])*fr,im=sa.im[k]+(sb.im[k]-sa.im[k])*fr,v=Math.hypot(re,im);m.push(v);mx=Math.max(mx,v);}
const bw=w/KV;g.fillStyle=color;m.forEach((v,k)=>{const t=Math.max(0,(20*Math.log10(v/mx+1e-9)+60)/60);if(t>0){const bh=Math.max(1,t*(h-3));g.fillRect(k*bw+0.5,h-bh-1.5,Math.max(1,bw-1),bh);}});}
function drawMut(){if(tab!=='mut'||!$('dGen').open||!arr.length)return;const src=arr[sel],c2=col('--text-primary'),c3=col('--text-success');
mini('mw1',src,src,0,c2);fftView('mf1',src,src,0,c2);if(pv){mini('mw2',pv,pv,0,c3);fftView('mf2',pv,pv,0,c3);}$('srcl').textContent='Source #'+(sel+1);}
function drawHistory(){if(!arr.length||!$('dHist').open)return;const last=arr.length-1,c1=col('--text-success'),c2=col('--text-primary');
mini('w1',arr[last],arr[last],0,c1);fftView('f1',arr[last],arr[last],0,c1);mini('w2',arr[sel],arr[sel],0,c2);fftView('f2',arr[sel],arr[sel],0,c2);
$('l1').textContent='#'+(last+1);$('l2').textContent='#'+(sel+1);
const[g,w,h]=fit($('strip'));const cw=w/Math.max(arr.length,16),cs=col('--text-secondary'),wh=h-12;
TR.forEach((t,i)=>{const[ta,tb]=bounds(t);g.fillStyle=col(TC[i]);g.globalAlpha=t.mute?0.3:0.9;g.fillRect(ta*cw+1,h-3-i*4,(tb-ta+1)*cw-2,3);g.globalAlpha=1;});
arr.forEach((x,j)=>{const x0=j*cw;if(j===sel){g.fillStyle=col('--bg-accent');g.fillRect(x0,0,cw,wh);}g.strokeStyle=j===sel?c2:j===last?c1:cs;g.lineWidth=(j===sel||j===last)?1.75:1;g.beginPath();
for(let i=0;i<=12;i++){const v=x[Math.floor(i/12*(N-1))],px=x0+2+i/12*(cw-4),py=wh/2-v*(wh/2-4);i?g.lineTo(px,py):g.moveTo(px,py);}g.stroke();});
TR.forEach((t,i)=>{const[ta,tb]=bounds(t);let f=ta+(playing?t.curPos:t.pp)*(tb-ta);if(t.ip==='off')f=Math.round(f);const mx=(f+0.5)*cw;g.strokeStyle=col(TC[i]);g.globalAlpha=t.mute?0.35:1;g.lineWidth=2;g.beginPath();g.moveTo(mx,0);g.lineTo(mx,wh);g.stroke();g.globalAlpha=1;});}
function drawTrack(i){const t=TR[i];if(!arr.length)return;let A,B,fr,f;if(playing&&t.ip==='off'&&t.held){A=B=t.held;fr=0;f=t.heldIdx;}else{[A,B,fr,f]=tablesAt(t,playing?t.curPos:t.pp);}
$('pl'+i).textContent='#'+(t.ip==='off'?String(f+1):(f+1).toFixed(1));if(!$('d'+i).open)return;const c=col(TC[i]);
mini('wv'+i,A,B,fr,c);fftView('fv'+i,A,B,fr,c);
const[g,w,h]=fit($('grid'+i));const cw=w/16,rh=h/8;
if(playing&&step>=0){g.fillStyle=col('--bg-accent');g.fillRect(step*cw,0,cw,h);}
g.lineWidth=1;for(let k=1;k<16;k++){g.strokeStyle=k%4?col('--border'):col('--border-stronger');g.beginPath();g.moveTo(k*cw,0);g.lineTo(k*cw,h);g.stroke();}
g.fillStyle=c;g.globalAlpha=t.mute?0.4:1;t.pat.forEach((r,k)=>{if(r>=0)g.fillRect(k*cw+2,(7-r)*rh+1.5,cw-4,rh-3);});g.globalAlpha=1;}
function draw(){drawHistory();TR.forEach((_,i)=>drawTrack(i));}
function styleMutes(){TR.forEach((t,i)=>{const b=$('mute'+i);b.innerHTML='<i class="ti '+(t.mute?'ti-volume-off':'ti-volume')+'" aria-hidden="true"></i>';b.style.color=t.mute?col('--text-muted'):col(TC[i]);b.setAttribute('aria-label',(t.mute?'Unmute':'Mute')+' playback '+TN[i]);});}
function labelsT(i){const t=TR[i];$('v_wa'+i).textContent=t.wa+1;$('v_wb'+i).textContent=t.wb+1;$('v_pp'+i).textContent=Math.round(t.pp*100)+'%';$('v_ld'+i).textContent=Math.round(t.ld*100)+'%';$('v_lr'+i).textContent=t.lr.toFixed(2)+' Hz';}
function labels(){$('v_bp').textContent=P.bp;$('v_am').textContent=Math.round(P.am*100)+'%';$('v_ct').textContent=P.ct;$('v_cc').textContent=P.cc;$('hcount').textContent=arr.length+' of '+CAP;stepsLabel();TR.forEach((_,i)=>labelsT(i));}
function syncUI(){readP();const m=Math.max(0,arr.length-1);TR.forEach((t,i)=>{['wa','wb'].forEach(k=>{const el=$(k+i);el.max=m;el.value=t[k];});});labels();styleMutes();if(!playing)draw();schedulePv();}
function setArr(t,sr){let m=0;while(m<MIPK.length-1&&t.freq*MIPK[m]>sr*0.45)m++;if(t.ip==='off'){if(t.held)t.hA=mips(t.held)[m];}else{t.aA=mips(t.A)[m];t.aB=mips(t.B)[m];}}
function audio(){ctx=new (window.AudioContext||window.webkitAudioContext)();sp=ctx.createScriptProcessor(4096,0,1);
sp.onaudioprocess=e=>{const o=e.outputBuffer.getChannelData(0),sr=ctx.sampleRate,L=o.length;if(!playing||!arr.length){o.fill(0);return;}
const stepLen=sr*60/(+P.bp)/2,att=sr*0.004,dec=stepLen*0.45,inc=N/sr;
for(let s=0;s<L;s+=BLK){
for(const t of TR){t.lfoPh+=2*Math.PI*t.lr*BLK/sr;t.curPos=lfoPos(t);const r=tablesAt(t,t.curPos);t.A=r[0];t.B=r[1];t.fr=r[2];t.f=r[3];if(t.ip==='off'){if(!t.held){t.held=t.A;t.heldIdx=t.f;}}else t.held=null;setArr(t,sr);}
const e2=Math.min(L,s+BLK);
for(let i=s;i<e2;i++){
if(toNext<=0){step=(step+1)%16;toNext+=stepLen;for(const t of TR){const r=t.pat[step];if(r>=0){t.freq=SC[r]*Math.pow(2,t.oct);t.tNote=0;setArr(t,sr);}}}
toNext--;let out=0;
for(const t of TR){const env=t.tNote<att?t.tNote/att:Math.exp(-(t.tNote-att)/dec);t.tNote++;const stp=t.ip==='off';
if(!t.mute&&env>1e-4){const k=t.ph|0,fr=t.ph-k,k2=(k+1)&(N-1);let v;
if(stp){const H=t.hA;v=H[k]+(H[k2]-H[k])*fr;}else{const A=t.aA,B=t.aB,va=A[k]+(A[k2]-A[k])*fr,vb=B[k]+(B[k2]-B[k])*fr;v=va+(vb-va)*t.fr;}
out+=v*env*0.15;}
t.ph+=t.freq*inc;if(t.ph>=N){t.ph-=N;if(stp){t.held=t.A;t.heldIdx=t.f;setArr(t,sr);}}}
o[i]=out;}}};sp.connect(ctx.destination);}
function loop(ts){if(!playing)return;if(!ts||ts-lastDraw>40){lastDraw=ts||0;draw();}requestAnimationFrame(loop);}
$('play').onclick=()=>{if(!ctx)audio();ctx.resume();playing=!playing;if(playing){step=-1;toNext=0;TR.forEach(t=>{t.tNote=1e9;t.held=null;});requestAnimationFrame(loop);}else draw();$('play').innerHTML='<i class="ti '+(playing?'ti-player-stop':'ti-player-play')+'" aria-hidden="true" style="font-size:20px"></i>';$('play').setAttribute('aria-label',playing?'Stop':'Play');};
$('undo').onclick=undo;
const TABS={seed:['tabSeed','panSeed'],mut:['tabMut','panMut'],ca:['tabCA','panCA']};
function setTab(m){tab=m;Object.entries(TABS).forEach(([k,[tb,pn]])=>{$(tb).setAttribute('aria-selected',k===m);$(pn).style.display=k===m?'':'none';});if(m==='mut')computePreview();}
$('tabSeed').onclick=()=>setTab('seed');$('tabMut').onclick=()=>setTab('mut');$('tabCA').onclick=()=>setTab('ca');
document.querySelectorAll('details.sec').forEach(d=>d.addEventListener('toggle',()=>{if(!playing)draw();drawMut();}));
document.querySelectorAll('.wb button[data-w]').forEach(b=>b.onclick=()=>addOne(BASIC[b.dataset.w](),true));
$('ca').onclick=()=>{readP();addBatch(caBatch(+P.cr,+P.cc,+P.ct),true);};
$('preset').onchange=()=>{$('expr').value=$('preset').value;$('err').textContent='';};
$('expr').oninput=()=>{$('err').textContent='';};
$('gen1').onclick=()=>{const o=evalExpr(1);if(o)addOne(o[0],true);};
$('genN').onclick=()=>{readP();const o=evalExpr(+P.ct);if(o)addBatch(o,true);};
$('apply1').onclick=()=>{readP();const out=pv||mutate(arr[sel],+P.am,pvSeed);newSeed();addOne(out,true);};
$('applyN').onclick=applyN;
$('reroll').onclick=()=>{newSeed();computePreview();};
document.querySelectorAll('[data-g]').forEach(s=>{s.oninput=s.onchange=()=>{readP();labels();if(!playing)draw();if(s.id==='op'||s.id==='am')schedulePv();};});
TR.forEach((_,i)=>{$('bw'+i).onchange=()=>{if(P.op==='breed')schedulePv();};});
TR.forEach((t,i)=>{
['wa','wb','pp','ld','lr'].forEach(k=>{$(k+i).oninput=()=>{t[k]=+$(k+i).value;labelsT(i);if(!playing){drawTrack(i);drawHistory();}};});
$('full'+i).onclick=()=>{t.pp=0.5;t.ld=1;$('pp'+i).value=0.5;$('ld'+i).value=1;labelsT(i);if(!playing){drawTrack(i);drawHistory();}};
$('oc'+i).onchange=()=>{t.oct=+$('oc'+i).value;};
$('ip'+i).onchange=()=>{t.ip=$('ip'+i).value;t.held=null;if(!playing){drawTrack(i);drawHistory();}};
$('mute'+i).onclick=e=>{e.preventDefault();e.stopPropagation();t.mute=!t.mute;styleMutes();if(!playing)draw();};
$('cp'+i).onclick=()=>{clip=t.pat.slice();const b=$('cp'+i);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy';},900);};
$('ps'+i).onclick=()=>{if(!clip)return;snap();t.pat=clip.slice();drawTrack(i);};
$('clr'+i).onclick=()=>{snap();t.pat=Array(16).fill(-1);drawTrack(i);};
$('rnd'+i).onclick=()=>{snap();t.pat=t.pat.map((_,k)=>k===0||Math.random()<0.65?Math.floor(Math.random()*8):-1);drawTrack(i);};
$('grid'+i).onclick=e=>{const r=$('grid'+i).getBoundingClientRect(),c=Math.floor((e.clientX-r.left)/(r.width/16)),row=7-Math.floor((e.clientY-r.top)/(r.height/8));if(c<0||c>15||row<0||row>7)return;snap();t.pat=t.pat.slice();t.pat[c]=t.pat[c]===row?-1:row;drawTrack(i);};});
$('strip').onclick=e=>{const r=$('strip').getBoundingClientRect(),j=Math.floor((e.clientX-r.left)/(r.width/Math.max(arr.length,16)));if(j>=0&&j<arr.length){sel=j;labels();if(!playing)draw();schedulePv();}};
$('auto').onclick=()=>{if(timer){clearInterval(timer);timer=null;$('auto').textContent='Evolve';}else{timer=setInterval(()=>{readP();addOne(mutate(arr[arr.length-1],Math.min(+P.am,0.3),(Math.random()*1e9)|0),false);},700);$('auto').textContent='Pause';}};
let rz;addEventListener('resize',()=>{clearTimeout(rz);rz=setTimeout(()=>{draw();drawMut();},60);});
setTab('seed');
['sine','tri','saw','square','p25'].forEach(w=>addOne(BASIC[w](),false));TR.forEach(t=>{t.wa=0;t.wb=arr.length-1;});TR[1].wa=1;TR[2].wb=2;sel=0;UNDO.length=0;updUndo();syncUI();
</script>
```
