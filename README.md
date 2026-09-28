# Clean Plate

A free, original 4-or-5-player online Bhabhi (Thulla) card game. Create a private room, share
the 6-digit code, and race to empty your hand before your friends do - whoever's left holding
cards is stuck with "the Leftovers". Server-authoritative dealing, turns, plays and coin economy
- the browser is never trusted with anything that matters. No ads, no purchases, no ad SDKs.

This is a sister project to Tidewalk, built the same way: same coin rules, same room system, same
free-hosting path - just a different game (cards instead of a token race), with an original food
market visual identity and a "thulla splat" animation when someone gets stuck picking up the pile.

## What's inside
- `server.js` - Node + Socket.IO backend. Deals the cards, and owns turn order, legal plays,
  suit-following, the thulla pickup rule, trick resolution, the free-coins cooldown (server clock
  only), entry fees and the prize payout. Hands are private: the server never sends your cards to
  anyone else, only card *counts*. Every coin change is written to an append-only ledger
  (`PLAYER_ENTRY`, `GAME_PRIZE`, `FREE_CLAIM`, `REFUND`, `ADMIN_ADJUSTMENT`).
- `public/index.html` - the whole browser client (table, hand, lobby, room, results). One file,
  original art drawn with CSS/HTML (playing cards, food-stall avatars, the splat animation), no
  external image or audio assets, no copied card-game artwork.
- `data.json` - created automatically at runtime to persist player balances between restarts
  (swap for Postgres/Supabase later if you want it to survive a host wipe - see below).

Like Tidewalk, this needs a real server rather than static files, because dice... well, cards this
time, coin balances and the 5-minute cooldown all have to be decided by the server, not the
browser. GitHub still holds the code; a free Node host runs it.

## Run it yourself first (optional)
```
npm install
npm start
```
Then open `http://localhost:3000`. Four browser tabs (or a mix of normal and private windows)
will act as four different players.

## Put it online for free

### 1. Push the code to GitHub
1. Create a free account at github.com if you don't have one.
2. Create a new **public** repository, e.g. `cleanplate`.
3. In this folder, run:
   ```
   git init
   git add .
   git commit -m "Clean Plate"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/cleanplate.git
   git push -u origin main
   ```
   (If you'd rather drag-and-drop the files through GitHub's web uploader instead of using git,
   that works too - just make sure `server.js`, `package.json`, and the whole `public` folder
   (as an actual folder, not its contents spilled out at the top level) all end up committed.)

### 2. Host the server for free on Render
1. Sign up at render.com (you can sign in with your GitHub account).
2. Click **New → Web Service** and pick your `cleanplate` GitHub repo.
3. Settings: Build command `npm install`, Start command `npm start`, Instance type **Free**.
4. Click **Create Web Service**. After a minute or two you'll get a live URL like
   `https://cleanplate-xxxx.onrender.com` - that's your game link. Send it to friends.

Notes on the free tier: the free instance sleeps after 15 minutes with no traffic and takes about
30-60 seconds to wake up on the next visit - fine for playing with friends, just expect that
first-load pause. Player balances are stored in a file on the server; a free Render instance's
disk isn't permanent across redeploys, so balances can reset if you redeploy. If you want balances
to survive that, the easiest upgrade is a free Supabase Postgres database (ask me and I'll wire it
in).

### 3. Get it showing up in search results
Same story as any brand-new site: nothing makes it appear instantly, since search engines only
index a page after crawling it (days to weeks either way). What actually helps, for free:
1. Once deployed, edit `public/sitemap.xml`, replace `REPLACE-WITH-YOUR-URL.onrender.com` with
   your real Render URL, commit and push - Render redeploys automatically.
2. Add your URL to Google Search Console (search.google.com/search-console) and Bing Webmaster
   Tools (bing.com/webmasters), verify it, and submit `https://your-url.onrender.com/sitemap.xml`
   as a sitemap under each.
3. The page already has a descriptive title and meta description built in for the search result
   itself.
4. The best lever for actually ranking is other pages linking to yours - sharing the link
   anywhere public helps more than anything configured on the page.

A custom domain isn't required for any of this - it works fine on the free `onrender.com` address.

## The rules, briefly
- 4 or 5 players, a standard 52-card deck dealt out completely (13 each for 4 players; 10 or 11
  each for 5). No trump suit.
- Whoever holds the 2 of clubs opens the very first trick with it. After that, the trick winner
  (or whoever gets thulla'd) leads next, with any card they like.
- Follow the suit that was led if you can. If you can't, you throw any card and immediately have
  to pick up every card played in that trick so far, including your own - a "thulla" - and you
  lead the next trick.
- If everyone follows suit all the way around, the highest card of the led suit wins the trick and
  every card in it is discarded for good (nobody keeps them). The winner leads next.
- Empty your hand and you're done for the game; the order everyone empties their hand in is the
  finishing order. Whoever's left holding cards alone at the end takes last place automatically.
- Entry fee is charged to everyone when the host starts the game. Winner gets 2x entry, last place
  gets 0, everyone in between splits the rest evenly (any leftover coin is shown as the game's
  remainder, never silently dropped or invented) - identical prize math to Tidewalk.
- 25-second turn timer; if you don't act in time the server plays a reasonable card for you.
  Disconnect and you have 60 seconds to reconnect into the same seat, with your hand exactly as
  you left it, before the server starts auto-playing it for you.

## Explicitly not included, on purpose
No advertisements of any kind, no real-money purchases, no coin shop, no premium currency. The
only ways to get coins are the 2,500-coin starting balance and the 100-coin claim every 5 minutes
(cooldown enforced by the server's clock, not the device's).
