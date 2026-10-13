import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // ABIs live in ../abi (shared with the backend)
  server: { port: 5173, fs: { allow: [".."] } },
});
