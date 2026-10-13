import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` emits both pages to dist/.
// `SINGLE=world npm run build` (or SINGLE=index) emits one self-contained HTML file to dist-single/.
const single = process.env.SINGLE;
const page = (name: string) => new URL(`./${name}.html`, import.meta.url).pathname;

export default defineConfig({
  base: "./",
  plugins: single ? [viteSingleFile()] : [],
  build: {
    outDir: single ? `dist-single/${single}` : "dist",
    rollupOptions: {
      input: single ? { [single]: page(single) } : { index: page("index"), world: page("world") },
    },
  },
});
