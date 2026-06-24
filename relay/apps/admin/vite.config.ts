import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
  preview: {
    // Read the port here (JS, so the env var is actually expanded) rather than
    // passing --port $PORT on the command line — Railway exec's the start
    // command without a shell, so $PORT wouldn't expand there. Bind all
    // interfaces for the container.
    port: Number(process.env.PORT) || 3000,
    host: true,
    // Served via `vite preview` behind a Railway *.railway.app domain; allow it
    // (plus localhost for local preview). The app is NIP-07 auth-gated regardless.
    allowedHosts: [".railway.app", "localhost"],
  },
});

export default config;
