import { mean, stdDev } from './percentiles';

export interface TTestResult {
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  significant: boolean;
  confidenceInterval: [number, number];
}

function lnGamma(z: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coefficients[0];
  for (let i = 1; i < g + 2; i++) {
    x += coefficients[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaCf(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1.0;
  let d = 1.0 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1.0 / d;
  let h = d;

  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;

    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1.0 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1.0 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1.0 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1.0 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1.0) < 1e-14) break;
  }

  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  if (x > (a + 1) / (a + b + 2)) {
    return 1.0 - regularizedIncompleteBeta(1.0 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta);

  return (front * betaCf(x, a, b)) / a;
}

function tDistCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const ibeta = regularizedIncompleteBeta(x, df / 2, 0.5);
  return 0.5 * (1 + Math.sign(t) * (1 - ibeta));
}

function tDistQuantile(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  let lo = -100;
  let hi = 100;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tDistCdf(mid, df) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

export function pairedTTest(samplesA: number[], samplesB: number[]): TTestResult {
  if (samplesA.length !== samplesB.length) {
    throw new Error('Sample arrays must have equal length');
  }
  if (samplesA.length < 2) {
    throw new Error('Need at least 2 paired samples');
  }

  const n = samplesA.length;
  const diffs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    diffs[i] = samplesA[i] - samplesB[i];
  }

  const meanD = mean(diffs);
  const sdD = stdDev(diffs);
  const df = n - 1;

  if (sdD === 0) {
    return {
      tStatistic: meanD === 0 ? 0 : Infinity,
      degreesOfFreedom: df,
      pValue: meanD === 0 ? 1 : 0,
      significant: meanD !== 0,
      confidenceInterval: [meanD, meanD],
    };
  }

  const se = sdD / Math.sqrt(n);
  const tStat = meanD / se;

  const cdfVal = tDistCdf(Math.abs(tStat), df);
  const pValue = 2 * (1 - cdfVal);

  const tCritical = tDistQuantile(0.975, df);
  const ci: [number, number] = [meanD - tCritical * se, meanD + tCritical * se];

  return {
    tStatistic: tStat,
    degreesOfFreedom: df,
    pValue,
    significant: pValue < 0.05,
    confidenceInterval: ci,
  };
}
