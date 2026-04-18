import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, "out/main"),
      rollupOptions: {
        external: ["koffi", "steamworks.js", "electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, "out/preload"),
      rollupOptions: {
        input: resolve(__dirname, "src/main/preload.js"),
      },
    },
  },
  renderer: {
    plugins: [react()],
    root: resolve(__dirname, "src/renderer"),
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
