/**
 * Formula presets from the prototype. Expressions are JavaScript (Math functions in
 * scope). Each uses `u` or `n` so a batch (+N) gives a sweep.
 *
 * Retuned presets (stored recipes keep their own expression, so they re-render as made):
 * Chebyshev sweeps odd orders (even Tₖ of a sine has even harmonics only: an octave up),
 * Superformula reads the shape off-centre (its 6-fold symmetry otherwise sounds 31
 * semitones up), Logistic map starts asymmetrically (its symmetry about ½ otherwise
 * leaves even harmonics only).
 */
export interface FormulaPreset {
  readonly group: string;
  readonly name: string;
  readonly expr: string;
}

export const FORMULA_PRESETS: readonly FormulaPreset[] = [
  { group: 'Perlin', name: 'Drift', expr: 'pnoise(2, u*1.5, 4, 0.5)' },
  { group: 'Perlin', name: 'Zoom', expr: 'pnoise(1+u*5, 0, 4, 0.5)' },
  { group: 'Perlin', name: 'Add octaves', expr: 'pnoise(2, 0, 1+n, 0.6)' },
  { group: 'Perlin', name: 'Roughen', expr: 'pnoise(3, u, 6, 0.3+u*0.5)' },
  { group: 'Perlin', name: 'Sine + noise', expr: 'sin(p) + u*pnoise(4, 0, 3, 0.6)' },
  { group: 'Perlin', name: 'Noisy FM', expr: 'sin(p + 3*u*pnoise(1.5, u, 3, 0.5))' },
  { group: 'Shapers', name: 'Soft clip', expr: 'tanh((1+5*u)*sin(p))/tanh(1+5*u)' },
  { group: 'Shapers', name: 'Chebyshev', expr: 'cos((2*n+3)*acos(0.95*sin(p)))' },
  {
    group: 'Shapers',
    name: 'Superformula',
    expr: 'superformula(p, 6, 2, 2+(8-2)*u, 2+(8-2)*u, 0.25)',
  },
  { group: 'Shapers', name: 'Superellipse', expr: 'sign(sin(p))*pow(abs(sin(p)),0.05+0.95*u)' },
  { group: 'Shapers', name: 'Shaped PWM', expr: 'tanh((3+20*u)*(sin(p)-0.8+1.6*u))' },
  { group: 'Phase', name: 'Nested FM', expr: 'sin(p + (0.5+u*2)*sin(2*p + 2*sin(3*p)))' },
  {
    group: 'Phase',
    name: 'CZ phase dist',
    expr: 'sin(2*PI*(t<0.5-0.45*u ? t/(2*(0.5-0.45*u)) : 0.5+(t-(0.5-0.45*u))/(2*(0.5+0.45*u))))',
  },
  { group: 'Phase', name: 'Cross PM', expr: 'sin(p + 2*u*sin(p)*sin(3*p))' },
  {
    group: 'Spectral',
    name: 'Primes',
    expr: '[2,3,5,7,11,13,17,19,23,29].reduce((s,q)=>s+sin(q*p)/pow(q,1.5-u), sin(p))',
  },
  {
    group: 'Spectral',
    name: 'Fibonacci',
    expr: '[1,2,3,5,8,13,21,34,55].reduce((s,q)=>s+sin(q*p)/pow(q,1-0.5*u),0)',
  },
  {
    group: 'Spectral',
    name: 'Pluck position',
    expr: '[...Array(40)].reduce((s,_,k)=>s+sin(PI*(k+1)*(0.05+0.45*u))*sin((k+1)*p)/pow(k+1,2),0)',
  },
  {
    group: 'Spectral',
    name: 'Schroeder phases',
    expr: '[...Array(24)].reduce((s,_,k)=>s+sin((k+1)*p+PI*(k+1)*(k+1)/24)/pow(k+1,0.5+u),0)',
  },
  {
    group: 'Spectral',
    name: 'Rounded bell partials',
    expr: '[1,2.76,5.4,8.93].reduce((s,f,i)=>s+sin((i?round(f*(1+u)):1)*p)/(i+1),0)',
  },
  {
    group: 'Fractal',
    name: 'Weierstrass',
    expr: '[...Array(7)].reduce((s,_,k)=>s+pow(0.4+0.4*u,k)*cos(pow(2,k)*p),0)',
  },
  {
    group: 'Fractal',
    name: 'Blancmange',
    expr: '[...Array(6)].reduce((s,_,k)=>s+pow(0.4+0.4*u,k)*abs(((pow(2,k)*t+0.5)%1)-0.5),0)',
  },
  {
    group: 'Geometry',
    name: 'Gauss bumps',
    expr: 'exp(-pow((t-0.2-0.5*u)/0.05,2)) - exp(-pow((t-0.7)/0.08,2))',
  },
  {
    group: 'Geometry',
    name: 'Sinc',
    expr: 'sin((4+12*u)*PI*(t-0.5)+1e-6)/((4+12*u)*PI*(t-0.5)+1e-6)',
  },
  {
    group: 'Bits',
    name: 'Bytebeat',
    expr: '((floor(t*256)*(floor(t*256)>>3|floor(t*256)>>(5+n%3)))&255)/128-1',
  },
  { group: 'Bits', name: 'Gray code', expr: '((floor(t*64)^(floor(t*64)>>1))&(n+7))/(n+7)*2-1' },
  { group: 'Math', name: 'FM sweep', expr: 'sin(p + u*4*sin(2*p))' },
  { group: 'Math', name: 'Harmonics', expr: 'sin((n+1)*p)' },
  { group: 'Math', name: 'Sync sweep', expr: 'sin(p*(1+u*3))' },
  { group: 'Math', name: 'Sine→saw', expr: '(1-u)*sin(p) + u*(t*2-1)' },
  { group: 'Chaos', name: 'Logistic map', expr: '[...Array(20)].reduce(x=>(3.5+0.5*u)*x*(1-x), 0.5+0.4*(sin(p)+0.2*sin(2*p))/1.1)*2-1' },
  { group: 'Chaos', name: 'Iterated sine map', expr: '[...Array(3+n)].reduce(x=>sin(PI*(1+u)*x), sin(p))' },
  {
    group: 'Voice',
    name: 'Vowel formants',
    expr: '[...Array(40)].reduce((s,_,i)=>s+sin((i+1)*p)*(exp(-pow((i+1-7+4*u)/1.5,2))+0.7*exp(-pow((i+1-11-10*u)/2,2))+0.05/(i+1)),0)',
  },
  { group: 'Voice', name: 'CZ resonance (sine window)', expr: 'sin((2+10*u)*p)*(0.5-0.5*cos(p))' },
  { group: 'Voice', name: 'CZ resonance (saw window)', expr: 'sin((2+10*u)*p)*(1-t)' },
  {
    group: 'Sequence',
    name: 'Euclidean pulses',
    expr: '(floor(floor(t*16)*(1+(4+n)%15)/16)-floor((floor(t*16)-1)*(1+(4+n)%15)/16))*2-1',
  },
  { group: 'Sequence', name: 'Digits of π', expr: '[3,1,4,1,5,9,2,6,5,3,5,8,9,7,9,3][(floor(t*16)+n)%16]/4.5-1' },
];
