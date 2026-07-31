export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total;
}

export function average(values: number[]): number {
  return sum(values) / values.length;
}
