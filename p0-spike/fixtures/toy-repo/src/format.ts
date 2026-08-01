export function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max + 1) + "…";
}
