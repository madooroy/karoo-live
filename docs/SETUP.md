# Karoo Live setup guide

About 20–30 minutes the first time. You'll need:

- A Hammerhead **Karoo 2** or **Karoo 3**
- A Google account (for a free Firebase project)
- A computer with a USB cable for the Karoo (Karoo 2; optional on Karoo 3)
- Internet on the Karoo during rides: a SIM card or your phone's hotspot on a Karoo 2. On a Karoo 3 it may also work through the Companion App (see [Limitations](../README.md#limitations)).

There are three parts: **A.** create your free database, **B.** install the app on the Karoo, **C.** load your settings and share the link.

---

## A. Create your Firebase database (10 minutes, free)

Firebase is Google's app backend. The free "Spark" plan is far more than one rider needs, and you never enter a credit card.

1. **Create a project.** Go to [console.firebase.google.com](https://console.firebase.google.com), click **Create a project**, and name it something like `karoo-live-yourname`. You can turn Google Analytics off.

2. **Create the database.** In the left menu open **Databases & Storage → Realtime Database** (older consoles: **Build → Realtime Database**) and click **Create database**.
   - Location: pick the one nearest you (United States is fine for North America).
   - Security rules: choose **Start in locked mode**.

3. **Paste the rules.** The database page has tabs across the top: **Data, Rules, Backups, Usage**. Open **Rules**: it's a text editor showing a few lines of JSON. Click inside it, select everything (Ctrl+A / Cmd+A), delete it, paste the the contents of [`firebase/database.rules.json`](../firebase/database.rules.json) (also shown below), and click **Publish**.

   ```json
   {
     "rules": {
       "owner": {
         ".read": "auth != null",
         ".write": "auth != null && !data.exists() && newData.val() === auth.uid"
       },
       "live": {
         "$shareId": {
           ".read": true,
           ".write": "auth != null && root.child('owner').val() === auth.uid"
         }
       }
     }
   }
   ```

   What these rules do: anyone with your share link can **read** that ride, nobody can list your rides, and only your Karoo's login can **write**. The first time your Karoo connects, it records itself as the owner, and after that no other account can write.

4. **Copy the database URL.** Back on the **Data** tab, copy the URL at the top. It looks like `https://karoo-live-yourname-default-rtdb.firebaseio.com`.

5. **Turn on email login.** Open **Security → Authentication** (older consoles: **Build → Authentication**), click **Get started**, choose **Email/Password**, switch on the first toggle, and click **Save**.

6. **Add a login for your Karoo.** Still in Authentication, open the **Users** tab, click **Add user**, and enter an email and a **new password used only for this**. The email doesn't need to be real, for example `karoo@yourname.example`.

7. **Block sign-ups (recommended).** In Authentication open **Settings → User actions** and untick **Enable create (sign-up)**. Then nobody else can make accounts in your project.

8. **Copy the Web API key.** Click the gear next to *Project Overview* → **Project settings** → **General**, and copy the **Web API key**.
   - If it says there's no key yet: on *Project Overview* click the **`</>`** (Web) icon, register an app with any nickname (no hosting needed), and the key will appear.
   - The Web API key isn't a secret. It only identifies your project, and the rules above do the protecting.

You now have four things: **database URL, Web API key, login email, login password.**

---

## B. Install the app on the Karoo

Download **`karoo-live.apk`** from the [latest release](https://github.com/madooroy/karoo-live/releases/latest).

### Karoo 2 (USB)

1. **Install adb** on your computer. It's Google's free [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools); unzip it somewhere handy.
2. **Turn on developer mode on the Karoo.** DC Rainmaker's [sideloading guide](https://www.dcrainmaker.com/2021/02/how-to-sideload-android-apps-on-your-hammerhead-karoo-1-karoo-2.html) walks through it with pictures.
3. **Connect** the Karoo by USB, run `adb devices`, and accept the prompt on the Karoo. You should see one device listed.
4. **Install:** `adb install -r karoo-live.apk`

### Karoo 3

On your phone, share this link to the Hammerhead **Companion App** and it installs on the Karoo:

```
https://github.com/madooroy/karoo-live/releases/latest/download/karoo-live.apk
```

You can also use the Karoo 2 USB steps.

After installing, **restart the Karoo** so it starts the extension.

---

## C. Load your settings and share

### Easiest: the setup page (computer + USB)

Open **[mybikeride.live/setup.html](https://mybikeride.live/setup.html)** and fill in the four values from part A plus your name. **Reinstalling or changing settings later?** Paste your current share link into the "Already set up?" box so your link stays the same. It gives you:

- **Your share link.** Send it to people; it's the same for every ride.
- **Two adb commands.** Run them with the Karoo plugged in. The second one opens Karoo Live with everything filled in.

Nothing typed on that page leaves your browser.

### Or type it on the Karoo

Open **Karoo Live** from the Karoo's app list, fill in the fields, and tap **Save & test**. The share link appears as a QR code you can scan with your phone.

### Test it

1. In Karoo Live, tap **Save & test**. You should see *"Connected!"*.
2. Open your share link on your phone. It should show your name and *"No ride data yet"*.
3. Start a ride on the Karoo, with internet on (SIM or hotspot). Within about 15 seconds the page should switch to **LIVE** and show the map and your numbers.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| *Sign-in failed: wrong email or password* | Check the user in Firebase → Authentication → Users. Reset the password there if unsure. |
| *permission denied (check database rules)* | Make sure the rules from step A3 were **published**. |
| *This database is owned by a different Firebase account* | You changed the login email. In Firebase → Realtime Database → Data, delete the `owner` entry, then tap **Save & test** again. |
| Page stays on *Waiting* during a ride | The Karoo has no internet. Check the SIM or hotspot. Karoo Live's screen shows the last upload time and any error. |
| Page says *Signal lost* | Normal in dead zones. The Karoo keeps up to about 100 minutes of missed points and sends them when the signal returns. |
| Nothing at all after install | Restart the Karoo so it starts the extension, then open Karoo Live once. |

## Changing or revoking the link

In Karoo Live tap **Make a new link**. The old link stops updating. You can delete old rides any time in Firebase → Realtime Database → Data → `live`.
