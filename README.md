# AgriVision

Photo of any crop or leaf -> crop detected -> diagnosis -> cure, with live weather. Built for Bihar and Jharkhand crops. English and Hindi.

## Structure
- docs/        frontend (host on GitHub Pages, folder /docs)
- server.js    backend API (host on Render)
- knowledge.json  vetted practices (edit and verify with a KVK or agronomy faculty)

## Run locally
1. cp .env.example .env   and set GROQ_API_KEY (models: see console.groq.com/docs/models)
2. npm install
3. node --env-file=.env server.js
4. open http://localhost:3000  (camera on phones needs HTTPS, use ngrok or deploy)

## Deploy
1. Push to GitHub (.env is git-ignored; never commit your key).
2. Render: New Web Service from the repo. Set GROQ_API_KEY and ALLOWED_ORIGIN=https://YOUR-USERNAME.github.io
3. Put the Render URL in docs/config.js (window.AGRI_API) and push.
4. GitHub Settings > Pages > branch main, folder /docs.
