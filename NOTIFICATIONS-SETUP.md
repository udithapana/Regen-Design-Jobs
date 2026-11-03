# Design Jobs — phone notifications setup (about 10 minutes, free)

The app sends its own notifications through **Google Firebase Cloud Messaging** (free, no card needed).
You do this **once**, as the Design Head. After that, each person just taps the 🔔 bell in the app.

---

## Part A — Firebase (in a browser, best on a computer)

1. Go to **https://console.firebase.google.com** and sign in with the Google account that owns the Design Jobs Sheet.
2. **Create a project** → name it `regen-design-jobs` → you can turn **Google Analytics off** → **Create project**.
3. On the project home page, click the **Web** icon **`</>`** ("Add an app to get started").
   - App nickname: `Design Jobs` → **Register app** (leave "Firebase Hosting" unticked).
   - You'll see a code box with `const firebaseConfig = { apiKey: "...", ... };`
   - **Copy the whole `firebaseConfig = { ... }` part** → keep it for step B2. Click **Continue to console**.
4. Click the ⚙ gear (top left) → **Project settings** → **Cloud Messaging** tab.
   - Scroll to **Web configuration → Web Push certificates** → **Generate key pair**.
   - **Copy the long key** that appears (starts with `B…`) → keep it for step B3.
   - On the same tab, check that **Firebase Cloud Messaging API (V1)** says **Enabled**.
5. Still in Project settings → **Service accounts** tab → **Generate new private key** → **Generate key**.
   A `.json` file downloads. **Open it with Notepad** and copy **everything** → keep it for step B4.
   > This file is a password for sending notifications. Don't share it or put it on GitHub.

## Part B — Apps Script (Script properties)

Open the Sheet → **Extensions → Apps Script** → ⚙ **Project Settings** → scroll to **Script properties** → **Add script property** for each:

| # | Property | Value |
|---|---|---|
| B1 | `APP_URL` | `https://udithapana.github.io/Regen-Design-Jobs/` (probably already set) |
| B2 | `FCM_CONFIG` | the `firebaseConfig` part from step A3 (paste it as it is) |
| B3 | `FCM_VAPID` | the key from step A4 |
| B4 | `FCM_SERVICE_ACCOUNT` | the whole JSON file from step A5 |

**Save script properties.**

## Part C — Update the code

1. **Apps Script:** replace `Code.gs` with the new one → **Save**.
2. In the toolbar choose **`pushStatus`** → **Run** → allow the permissions if asked.
   The log should say: `App notifications set up: YES` and `Google sign-in for notifications: OK`.
3. **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.**
4. **GitHub (Regen-Design-Jobs repo):** upload `index.html`, `sw.js` and the new `badge-96.png`.

## Part D — Turn it on (each person, on their own phone)

1. Open the **installed Design Jobs app** (not a Chrome tab — so the badge shows on the Design Jobs icon).
2. Tap the **🔔 bell** (top bar) → **Turn on notifications** → **Allow**.
3. Tap **Send me a test**, then close the app — the notification pops up and the icon gets a badge.

A small orange dot on the 🔔 means notifications are still off on that phone.
In the **Team** panel you can see who has 🔔 on and who has 🔕 off.

---

## Who gets what

| What happens | Who is notified |
|---|---|
| New request | Design Head + designers (Very Urgent: also Management) |
| Job assigned | That designer |
| Deadline / priority changed, On hold, Cancelled | Assigned designer + Design Head |
| Info needed, Design completed | The sales person who raised it |
| Ready for review | Design Head |
| Comment | The other people on that job (never the person who wrote it) |
| Due within 48 h / 24 h / overdue | Sales person, assigned designer, Design Head |
| 8 am summary | Everyone |

Tapping a notification opens that job in the app. Opening the app clears the badge.

## Good to know
- **Badge:** Android shows the badge while there are unread Design Jobs notifications. Google's Android shows a dot; Xiaomi/HyperOS usually shows the count like Outlook. The phone decides the style.
- **Xiaomi phones:** if notifications arrive late, open *Settings → Apps → Design Jobs* (or Chrome) → **Autostart: on**, **Battery saver: No restrictions**, and allow **Notifications → Badges/Lock screen**.
- **iPhone:** works on iOS 16.4+ after *Share → Add to Home Screen*, then turn on from the 🔔 in the Home Screen app.
- The ntfy alerts keep working as before. Once everyone has app notifications, you can stop using ntfy.
