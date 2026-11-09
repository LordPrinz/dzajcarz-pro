// Bun's text loader: `import content from "x.sql" with { type: "text" }` gives the file as a string.
declare module "*.sql" {
  const content: string;
  export default content;
}
