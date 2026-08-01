export function slugify(input: string): string {
  return input.trim().split(/\s+/).join("-");
}
