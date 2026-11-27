# AI Photo Studio

A mobile-first photo editing web app built with React and Vite.

## Included in this MVP
- 10 editing modes: product, portrait, couple, selfie, background, mascot, age, vintage, face swap, and enhance.
- Local image upload, preview, browser-side filters, brightness, contrast, and saturation controls.
- PNG export and responsive desktop/mobile layout.

## Run locally
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run dev`.

## Deploy to Vercel
Import this repository in Vercel. Use framework preset **Vite**, build command `npm run build`, and output directory `dist`.

## AI integration status
This is a functioning front-end MVP. Generative AI features such as new background generation, product photoshoot generation, face swap, age transformation, and multiple generated variations require a secure server-side AI provider integration and API credentials. Never put provider API keys in browser code.