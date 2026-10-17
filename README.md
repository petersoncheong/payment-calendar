# Payment Calendar

A single-page app (iPhone, iPad, Mac) for scheduled payments: payees → payments (payee + invoice no. + amount + date), shown on a calendar.

- **Calendar** – each day shows the total; tap a day for payee / invoice / amount detail. "+ Add" schedules a payment.
- **Look up** – by payee (upcoming payments; tick "Show past payments" for history) or by invoice number.
- **Payees** – add / rename / delete payees; currency symbol; export / import a JSON backup; sign out.

## Files
`index.html`, `app.js` (the app) · `config.js` (your Supabase keys) · `supabase-setup.sql` (database tables + security) · `vendor/supabase.js` (supabase-js 2.45.4, self-hosted so it works offline) · `sw.js`, `manifest.webmanifest`, icons (installable / offline) · `supabase-push-setup.sql` + `supabase/functions/send-due-alerts/index.ts` (daily alerts).

## Turn on sync across devices (Supabase, free tier)
1. Create an account at supabase.com → **New project** (any name/region, save the database password somewhere).
2. **SQL Editor → New query**, paste all of `supabase-setup.sql`, **Run**. This creates the tables, restricts every row to its owner, and enables live updates.
3. **Project Settings → API**: copy the **Project URL** and the **anon** (or *publishable*) key into `config.js`:
   ```js
   window.PAYMENT_CALENDAR_CONFIG = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: 'eyJ...' };
   ```
   The anon key is meant to be public — what protects your data is the login + the row-level security in the SQL file. **Never put the `service_role` key here.**
4. **Authentication → Sign In / Providers → Email**: for a quick start turn off *Confirm email*. (If you leave it on, set **Authentication → URL Configuration → Site URL** to your hosted address so the confirmation link works.)
5. Open the app, tap **Create account**, then sign in. Do the same login on every device.
6. **Then lock it down:** Authentication → Sign In / Providers → turn off **Allow new users to sign up**, so nobody else can register against your database.
7. Existing data from the local-only version: on that device use **Payees → Export backup**, sign in to the cloud version, then **Import backup**.

Changes appear on your other devices within a second or two (and whenever you switch back to the app). If the connection drops the app shows the last copy it saw with an "Offline" banner and refuses edits until you're back online (a change that can't be saved is undone and you get a message).

## Daily alerts (push notifications)
Each morning every device that has alerts turned on gets one notification for the day, e.g. **"3 payments due today · ₱35,681.25"** with the top payees listed. Nothing is sent on days with no payments. A server job checks hourly and sends at the hour you choose (in that device's own time zone).

One-time setup in the Supabase dashboard (private keys are in `../_secrets/`, outside this folder so they never get published):
1. **SQL Editor** → run `supabase-push-setup.sql` (creates the device table).
2. **Edge Functions → Deploy a new function → Via Editor**, name it exactly `send-due-alerts`, paste in all of `supabase/functions/send-due-alerts/index.ts`, **Deploy**. Leave *Verify JWT* on.
3. **Edge Functions → Secrets → Add new secrets**: paste the contents of `_secrets/function-secrets.env`. Before saving, change `VAPID_SUBJECT` to `mailto:your-own-email` (or your site's `https://…` address).
4. **SQL Editor** → run `_secrets/push-cron.sql` (schedules the hourly check). If it complains about an extension, enable **pg_cron** and **pg_net** under Database → Extensions and run it again.
5. In the app: **Payees → Daily payment alert → Enable alerts on this device**, pick a time, allow notifications, then tap **Send test**.

Per device:
- **iPhone / iPad (iOS 16.4+):** alerts only work after **Share → Add to Home Screen** — open the app from that icon, then enable alerts there.
- **Mac:** works in Safari/Chrome; most reliable if installed (Safari: File → Add to Dock; Chrome: Install).
- Every device turns alerts on for itself. Signing out removes that device's alerts.
- The currency symbol in the message is the one set on that device.
- Keep `_secrets/` private. The `VAPID_PRIVATE_KEY` and `CRON_SECRET` must never go into `config.js` or the repo.

## Try it on the Mac
    python3 -m http.server 8080      # then open http://localhost:8080
(With `config.js` left empty the app runs in local-only mode, data stays in that browser.)

## Put it on iPhone / iPad
Host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages), open the address in **Safari → Share → Add to Home Screen**.
`config.js` ships to the browser, so the repo/site will contain your project URL and anon key — that's fine by design (see step 3).

## Caveats
- Last write wins if two devices edit the same payment at the same moment.
- Backup: Supabase's free tier pauses projects after about a week of inactivity and doesn't include automatic backups — use **Export backup** now and then.
- The currency symbol is a per-device setting.
