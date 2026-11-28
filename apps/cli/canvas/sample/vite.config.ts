import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import drayCanvas from "./.dray/canvas/vite-plugin.mjs";

export default defineConfig({
  plugins: [drayCanvas(), react(), tailwindcss()],
});
