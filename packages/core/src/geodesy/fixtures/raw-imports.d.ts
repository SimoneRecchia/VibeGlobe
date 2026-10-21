// Text fixtures are imported with Vite's `?raw` suffix, which Vitest resolves to the file's contents as a string.
declare module '*.txt?raw' {
  const text: string;
  export default text;
}
declare module '*.json?raw' {
  const text: string;
  export default text;
}
