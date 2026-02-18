/** Returns a random value in [base*(1-variance), base*(1+variance)] */
export function jitter(base: number, variance = 0.2): number {
  const min = base * (1 - variance);
  const max = base * (1 + variance);
  return min + Math.random() * (max - min);
}

export function jitterInt(base: number, variance = 0.2): number {
  return Math.round(jitter(base, variance));
}
