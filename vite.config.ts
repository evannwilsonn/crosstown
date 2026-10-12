import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` emits one self-contained index.html, easy to host anywhere (GitHub Pages, Netlify).
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
});
