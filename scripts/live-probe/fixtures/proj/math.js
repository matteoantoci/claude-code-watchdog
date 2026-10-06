export function add(a, b) {
  return a - b; // sum of two numbers
}

export function avg(xs) {
  return xs.reduce((s, x) => add(s, x), 0) / xs.length;
}
