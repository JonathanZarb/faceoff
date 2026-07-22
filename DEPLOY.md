# Deploying Face Off to a public URL (Render.com, free tier)

This gets you a public link like `https://faceoff-yourname.onrender.com` that you and your friend can both open, from anywhere.

## 1. Put the code on GitHub

Render deploys from a GitHub repo.

1. Go to https://github.com and sign in (or create a free account).
2. Click the **+** in the top right → **New repository**. Name it `faceoff`, keep it public or private (either works), don't add a README (we already have one). Click **Create repository**.
3. On the new repo's page, click **uploading an existing file** (or **Add file → Upload files**).
4. Unzip the `faceoff.zip` I sent you, and drag the *contents* of that folder (not the folder itself — `server.js`, `rooms.js`, `gameLogic.js`, `package.json`, `README.md`, the `public/` folder, the `test/` folder) into the upload area.
5. Scroll down, click **Commit changes**.

## 2. Create the Render web service

1. Go to https://render.com and sign in — you can sign up free with your GitHub account, which also makes step 3 easier.
2. From the dashboard, click **New +** → **Web Service**.
3. Connect your GitHub account if prompted, then select the `faceoff` repo you just created.
4. Fill in the settings:
   - **Name**: anything, e.g. `faceoff` (this becomes part of your URL)
   - **Region**: whichever is closest to you
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: leave blank (no dependencies to install)
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
5. Click **Create Web Service**.

Render will build and deploy — takes about a minute or two. When it's done, you'll see a URL at the top of the page like `https://faceoff-xxxx.onrender.com`. That's the link to send your friend.

## Notes on the free tier

Render's free web services spin down after a period of no traffic and take ~30-60 seconds to wake back up on the next visit — so if you haven't played in a while, the first page load might feel slow before it springs to life. Everything after that is normal speed. This doesn't affect gameplay once you're both connected, only the very first load after idling.

If you'd rather use a different host (Railway, Fly.io, etc.), the steps are the same shape: point it at this GitHub repo, no build command, start command `node server.js`, free/hobby tier.
