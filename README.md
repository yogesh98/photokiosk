# Still · Photo kiosk studio

A local photo booth with green-screen background replacement and a USB camera. Built with Next.js 16, React, and TypeScript.

- **Admin:** [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin) (also available at `/`). Manage backgrounds, background replacement, camera settings, Backblaze B2 sharing, Gmail, and the gallery with recipients and delivery history.
- **Kiosk:** [http://127.0.0.1:3000/kiosk](http://127.0.0.1:3000/kiosk). Camera preview with background replacement, a five-second countdown, three photos with three-second intervals, review/retake, and optional QR sharing and email delivery after capture.

## Run

Use Node.js 22 or later. Run the app on the **same computer** as the camera.

```bash
npm install
npm run dev
```

For an event, use the production build:

```bash
npm run build
npm start
```

Dev, production, and the background service bind to `0.0.0.0` on port 3000. For a manual session, open the kiosk in a second browser window and use its fullscreen button. For automatic startup and full-screen display on macOS, use the installer below. Keep the studio server running throughout the event. The app needs a writable local disk; it is designed for one Node process and one booth, rather than static or serverless hosting.

### Access Admin from another computer or phone

Connect both devices to the same trusted local network, then open `http://<booth-computer-ip>:3000/admin` on the other device. Use the booth computer's IPv4 address from macOS **System Settings → Network → the connected interface → Details → TCP/IP**, for example `http://192.168.1.50:3000/admin`. Include `http://` and `:3000`. Admin settings, uploads, and gallery access work through that address; the server and attached Canon camera continue running on the booth computer. Continue opening the booth's webcam kiosk at `http://127.0.0.1:3000/kiosk`, since browser webcam access requires localhost or HTTPS.

If the connection fails, allow incoming connections for the server's Node executable in the macOS firewall and check that Wi-Fi client isolation is disabled. The IP can change when the computer reconnects; a DHCP reservation on your router keeps it stable. Development mode needs a restart after the IP changes to refresh its allowed asset origins. This address is for local-network access; access from a different internet connection requires a VPN or a separate authenticated HTTPS setup. Admin has no login, so use a trusted network and do not forward port 3000 to the internet.

### Run in the background and redeploy after pulling (macOS)

From this checkout, with Node.js 22 or later, npm, and Google Chrome installed in `/Applications`, run once:

```bash
npm run deploy:install
```

This installs two per-user macOS LaunchAgents: the app server (`com.still.photokiosk`) and the display (`com.still.photokiosk.display`). It builds the app, serves Admin at `http://127.0.0.1:3000/admin`, and opens `http://127.0.0.1:3000/kiosk` on the display in Chrome's full-screen kiosk mode. The display waits for the server to be ready before opening Chrome. Both services stay running after closing the terminal, restart after a crash, and start when this macOS user logs in. Closing the kiosk browser also causes it to reopen. The display service keeps the screen and computer awake while running. Stop any separately running dev/production server on port 3000 first.

After a reboot, log in to this macOS user to start the booth automatically; the services do not bypass the macOS login screen. Leave this user logged in during an event. Chrome uses a dedicated profile in ignored `.deploy/chrome-profile/`, preserving the booth's camera permission across restarts. If using a webcam, allow camera access in this Chrome profile the first time, and allow macOS camera access if requested. Regular browser windows can still be used for Admin.

If the server service is already installed, enable just the automatic display without rebuilding:

```bash
npm run kiosk:install
```

The installer sets this checkout's local `core.hooksPath` to `.githooks`. After a successful merge or fast-forward pull, `post-merge` installs locked dependencies, builds a standalone release, and restarts the service. `post-rewrite` does the same after a rebase, including `git pull --rebase`. These hooks also run after manual merges/rebases; a pull reporting “Already up to date” does not rebuild. Other clones must run the installer separately. Commit the hook and deployment files so future checkouts have them.

The existing release keeps serving while the next build runs. A failed install/build leaves it running; a failed server health check restores the previous release. Successful redeployment briefly interrupts the booth and restarts the installed kiosk display to load the new app, so pull between guest sessions. Manually opened browser windows still need a reload. The two most recent builds are kept in ignored `.deploy/releases/`; that folder also contains local service configuration and logs. An interrupted deployment can leave `.deploy/lock`; remove that directory only after confirming no deployment is running.

**Saved settings survive rebuilds.** Backblaze and Gmail credentials entered in Admin, booth preferences, backgrounds, and photos remain in the checkout's `.data/` folder (or `PHOTO_KIOSK_DATA_DIR` if configured). Rebuilding never deletes that folder. Runtime `.env` files are loaded from the checkout, so `.env.local` is preserved too; relative data-directory overrides are resolved against the checkout. Back up the data folder separately.

```bash
npm run deploy          # Rebuild/redeploy manually, or restart after deploy:stop
npm run deploy:status   # Inspect the launchd service
npm run deploy:stop     # Stop the server and display until the next deploy or login
npm run kiosk:status    # Inspect the automatic display service
npm run kiosk:stop      # Close the kiosk display while leaving the server running
npm run kiosk:start     # Reopen/restart the kiosk display
npm run kiosk:uninstall # Remove automatic display startup; keep the server
npm run test:deploy     # Check deployment hooks and display startup/recovery
tail -f .deploy/server.log .deploy/server.error.log
tail -f .deploy/display.log .deploy/display.error.log
```

The hook records the installer's absolute Node path in `.deploy/node`, so `git pull` can deploy even if the Git client's PATH lacks Node. Keep that runtime installed; rerun `deploy:install` using the new Node executable after moving/upgrading it. To remove the services and pull automation, run `npm run kiosk:uninstall`, run `npm run deploy:stop`, remove `~/Library/LaunchAgents/com.still.photokiosk.plist`, and run `git config --local --unset core.hooksPath`. Keep `.data/` and any custom data directory.

### Match touch input to the rotated display (macOS)

For this booth's CVTouch USB panel (`1ff7:0013`), run `npm run touch:install`, then enable **Still Touch** in **System Settings → Privacy & Security → Accessibility**. The installer compiles a small local app with Apple's command-line tools and installs a separate login service. It rotates the panel's absolute pointer input to match the display's current 0°, 90°, 180°, or 270° orientation. It applies throughout macOS and Chrome, passes other input devices through unchanged, and pauses if more than one display is active. The booth server and kiosk browser can keep running during installation.

Use `npm run touch:status` to inspect it and `.deploy/touch.log` to check activation and received touch presses. `npm run touch:stop` temporarily restores the panel's original mapping; `npm run touch:start` resumes correction. `npm run touch:uninstall` removes automatic startup. The local app is `.deploy/Still Touch.app`; if it is absent from Accessibility, add it with the **+** button. Rebuilding the helper can require renewing its permission. Its device attribution uses an undocumented macOS event field and must be checked after major macOS updates. Test taps near all four corners on the physical display after setup.

If touches are slightly offset, run `npm run touch:calibrate`. Tap the center of each of the nine crosshairs, lifting your finger between targets. The helper fits offset, scale, and axis skew, rejects inconsistent readings, and saves the result to ignored `.deploy/touch-calibration.json`. Then check alignment against the targets and tap **Done**. **Esc** cancels unfinished calibration without changing the previous mapping. During calibration the fullscreen overlay consumes panel taps so they cannot trigger kiosk actions. Regular mouse input cannot supply calibration samples. The saved correction loads at login only for the same display and rotation; recalibrate after physically moving the touch frame or changing orientation.

After restarting the Mac, log in to the **kiosk** user. The touch service automatically starts and reloads the saved calibration using its existing Accessibility permission. Restarting the service with `npm run touch:start` does the same; it waits for macOS to finish stopping the previous process. No reinstall or recalibration is needed for ordinary restarts or app redeployments. Keep `.deploy/Still Touch.app` and `.deploy/touch-calibration.json` in place.

## Set up the booth

1. In **Camera setup**, choose a webcam or **Canon tethering**. Save the selection, then open the preview. A webcam needs browser camera permission on localhost. For Canon, press **Start live preview** in Admin. The kiosk connects automatically on startup and between guests.
2. Choose one of six built-in backgrounds, or upload a JPEG, PNG, or WebP up to 10 MB. Under **Backgrounds for each photo**, keep the **Same background**, **Rotate backgrounds** through the library starting with the active scene, or **Choose per photo** to assign scenes to photos 1, 2, and 3. Save the photo backgrounds to apply the plan to the next session.
3. Under **Background replacement**, choose **Green screen** or **Off**. Green screen uses a physical green backdrop and offers color similarity, edge softness, and spill reduction controls. Off keeps the camera's original scene. Open the live preview to check the result, then **Save adjustments** to apply it to the kiosk.
4. Optionally configure **Backblaze B2** for QR sharing using the instructions below. In **Email delivery**, optionally enter the sender address, display name, and a Google app password. Customize the subject/message, save, then send a test to an address you control.
5. Launch the kiosk. Guests have five seconds before photo one, then three seconds between each remaining photo. Photos are saved locally before sharing starts. B2 uploads run automatically when enabled; email entry appears when Gmail is configured. Guests can use both when both are configured. The kiosk provides QR and email delivery without gallery navigation links or local download buttons. When neither is configured, guests can ask the host for a copy.

The admin refreshes on focus and the gallery has a refresh button. The kiosk picks up saved settings between guests, polling every 15 seconds while idle. A reset waits for fresh settings before enabling another session. Start a fresh session to apply changes made during capture.

Hold **I + P** together on a physical keyboard for about a second to show the booth computer's local IPv4 addresses. Release either key to hide them. The shortcut stays inactive during email entry. The email screen has a touch keyboard with **@gmail.com** and **@yahoo.com** shortcuts.

The kiosk displays each photo's scene before starting its countdown and uses that scene in the saved photo. The camera stays connected while backgrounds switch. The plan is fixed for the guest's session, and the gallery keeps the background name for each photo. Sequences work with green screen; Off preserves the original camera scene for all three shots.

### Ubuntu / mini PC setup

Install Node.js 22 or later and a current desktop Chrome, Chromium, or Edge browser. Copy/clone the project, then run the following on the Ubuntu machine:

```bash
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000/admin` on that same machine and choose your background mode. Run `npm ci` on Ubuntu itself so native dependencies such as Sharp match Linux; do not copy `node_modules` from a Mac.

Webcams use the browser's camera permissions. For Canon USB tethering, also install `gphoto2` (`sudo apt install gphoto2`) and verify `gphoto2 --auto-detect` works as the same user running the booth. Close photo-import apps that have claimed the camera. Keep the webcam kiosk on localhost; Admin can use the booth computer's network IP.

## Canon EOS 5D Mark IV

The Canon is controlled directly over USB through **gphoto2** on the studio computer. The official [libgphoto2 camera list](https://gphoto.sourceforge.io/proj/libgphoto2/support.php) lists the EOS 5D Mark IV with capture, trigger, Liveview, and configuration support. The app uses the documented [gphoto2 CLI](https://gphoto.sourceforge.io/doc/manual/ref-gphoto2-cli.html).

```bash
# macOS with Homebrew
brew install gphoto2

# Debian / Ubuntu
sudo apt install gphoto2
```

Connect a USB data cable, switch the camera on, select still-photo mode, and choose JPEG or RAW+JPEG image quality. For automatic exposure, set the camera's physical mode dial to **P (Program)** and ISO to **Auto**. Close EOS Utility, Photos, Image Capture, and any other software claiming the camera. The app never terminates those applications itself.

Choose **Canon tethering** in Admin. **Exposure control → Camera automatic (P)** is the default, including for older saved booth settings. The app leaves ISO, aperture, and shutter speed unchanged and does not switch the physical mode dial. Set P and ISO Auto on the camera so it chooses the exposure. Existing manual values are retained for later use.

For fixed exposure, choose **Manual settings (M)** and set the camera's dial to M. ISO, aperture, and shutter speed are applied to the connected camera before preferences are saved, so a rejected setting remains visible in the form. Disconnected manual preferences can be saved; connect the Canon and save again to apply them. Lens limitations or camera mode can prevent a requested setting.

Press **Start live preview** to begin Canon live view, and **Stop live preview** to end it. The app runs one persistent `gphoto2 --capture-movie --stdout` process and displays its streamed preview JPEGs; it does not launch another camera process or take a full-resolution still for each preview frame. This is the [preview-streaming mode documented by gphoto](https://gphoto.sourceforge.io/doc/remote/), and the Canon must stay in still-photo mode. The mirror can move when live view starts or stops, rather than cycling for each displayed frame.

The kiosk starts Canon live view automatically after login, a server/browser restart, and a next-guest reset. While idle and during a guest's countdowns, it retries disconnected cameras, USB errors, corrupt preview frames, and expired sessions with delays increasing from one to fifteen seconds, showing "Reconnecting the camera…" rather than ending the guest's session. It never reconnects during a shutter. USB I/O failures or timeouts, from still commands or the live stream, trigger a reset of the affected camera's port before the next live connection, at most once every thirty seconds. Each new live session detects the current USB address, including after a reset. Keep the camera powered on and connected. The app does not terminate other camera apps, and processing/settings errors still require correction.

Admin preview remains manual: opening its panel does not operate the camera, and an error requires **Start live preview** again. **Stop live preview** pauses automatic connection in the kiosk until explicitly started again or the preview is reopened. Hiding the kiosk stops its stream; returning to the visible idle kiosk reconnects it. Changing backgrounds or green-screen settings does not restart a healthy camera stream. Browser frame requests read the latest cached stream image; they cannot start the camera. The owned stream also stops if its browser stops requesting frames.

Canon live preview stays active throughout each countdown. At each shutter, the kiosk holds the last displayed frame, stops live view, and takes one high-resolution session photo. After successful photos 1 and 2, it restores live view within that same guest session and waits for a fresh processed frame before starting the next three-second countdown. Automatic recovery never retries a still shutter or interrupts its USB ownership. After photo 3, preview stays stopped during review and reconnects for the next guest. Each saved photograph is composited with the preview's crop and saved as a JPEG up to 2400 pixels wide, with originals retained on the camera card. Webcam preview remains continuous at up to 24 fps.

Each still autofocuses as it is taken. The capture switches the Canon into live view and selects the wide-area **FlexiZone - Multi** AF method (`viewfinder=1`, `afmethod=LiveMulti`), so the shutter's half-press focuses on the nearest subject across the frame. Keep the lens switch on **AF**, AF operation on **One Shot**, and shutter-button AF enabled. If the camera rejects this live-view setup, that photo is taken with the camera's own AF settings and later photos skip the setup until the server restarts; the shutter never fires twice.

Cancelling a session aborts pending capture requests and skips queued shutter commands. The server waits for its own camera process to exit before releasing the camera or cleaning up temporary files. A shutter that already fired cannot be undone; cancelled frames are discarded by the kiosk.

Diagnostics:

```bash
gphoto2 --auto-detect
gphoto2 --summary
gphoto2 --capture-preview
```

On macOS, Preview can keep the camera import helper `ptpcamerad` holding the Canon even with no visible import window. Fully quit **Preview (Command-Q)**, Photos, Image Capture, and EOS Utility, reconnect the camera, then retry `gphoto2 --summary`; the [gphoto FAQ](https://gphoto.sourceforge.io/doc/manual/FAQ.html) describes the built-in PTP tool blocking USB access. A USB claim failure is an operating-system access problem before exposure can be validated; distinguish it from a rejected ISO/aperture/shutter value and from a PTP communication timeout.

Copy `.env.example` to `.env.local` if gphoto2 needs an explicit path, such as `GPHOTO2_PATH=/opt/homebrew/bin/gphoto2`, or to choose a different data directory. Restart the server after changing environment variables.

Automated tests cover simulated USB faults, resets, changing USB addresses, and server/session recovery. The physical Canon EOS 5D Mark IV has also been checked for live preview and automatic reconnection after server and kiosk-browser restarts. Check the camera before an event; USB ownership, lens behavior, operating-system permissions, and camera firmware can affect tethering. After rebooting the Mac, log in to the kiosk user so the server and display services start.

## Gmail

Enable Google **2-Step Verification** and generate a [Google app password](https://support.google.com/accounts/answer/185833?hl=en). Enter the 16-character app password in Admin, not your normal Google password. Some managed accounts do not permit app passwords.

The server uses `smtp.gmail.com:465` with TLS and sends the three JPEG attachments. See [Nodemailer’s Gmail guide](https://nodemailer.com/guides/using-gmail). Gmail needs internet access and applies its sending limits. If a Google account password changes, its app passwords can be revoked.

“Sent” means Gmail accepted the email; it does not guarantee inbox delivery. SMTP errors retain the captured photos and recipient details for review/retry. Successful retries to the same latest recipient are idempotent. Sending to a new recipient keeps previous delivery history. If the server stops during a send, the session is marked interrupted on restart; inspect Gmail’s Sent folder before retrying an uncertain send.

## Backblaze B2 QR sharing

A QR code can open one page showing all three photos. The booth uploads the JPEGs and a small self-contained HTML gallery to the same B2 folder. The QR points directly to that HTML file on Backblaze, where guests can view the photos, open their phone's sharing options for all three, or download the regular JPEG files. Backblaze's [hosted media example](https://www.backblaze.com/docs/cloud-storage-connect-to-backblaze-b2) demonstrates serving a photo viewer directly from a public bucket. The booth needs no public web server, domain, or port forwarding; guests only need internet access.

On supported phones, the gallery prepares the three image files and opens the native share sheet after a tap. If that sheet offers **Save Images** or a photo-library destination, guests can choose it to save all three together. The available actions depend on the phone, browser, and installed apps. The [Web Share standard](https://www.w3.org/TR/web-share/) does not let a website select a destination, inspect which destinations are available, or confirm that images reached the photo library. A successful share is therefore not proof that the photos were saved to the gallery. This flow cannot guarantee one-tap photo-library saving on every iPhone or Android device.

Downloads remain available if native sharing is unsupported, cancelled, or fails. **Download all photos** requests three separate image downloads; the browser may ask guests to allow multiple downloads. Individual download buttons and full-size photos remain available too. On Android, downloaded images go to the browser's default download location and can be found in **Files** or **Downloads**, as described in [Google's Chrome instructions](https://support.google.com/chrome/answer/95759?co=GENIE.Platform%3DAndroid&hl=en); their appearance in a gallery app depends on the device. Guests can also open each photo and use their browser's touch-and-hold save action.

1. Create a dedicated B2 bucket with **Public** access (`allPublic`). Private buckets are not supported by this direct-link flow: [public buckets permit downloads without authorization](https://www.backblaze.com/docs/cloud-storage-download-files-with-the-native-api).
2. Create an application key restricted to that bucket. It needs `listBuckets` and `writeFiles` capabilities. `listBuckets` lets the app verify the configured bucket and its public access; a bucket restriction still requires the app to specify that bucket when [checking its settings](https://www.backblaze.com/apidocs/b2-list-buckets). If you add a file-name prefix restriction, use `photo-booth/`.
3. In **Admin → Backblaze B2**, enter the **Key ID**, **Application key**, and **Bucket name**, enable sharing, and save. The secret is stored on the local server; leaving its field blank preserves the saved secret.
4. Test the connection, then capture a test session. Scan the QR using mobile data on an actual iPhone and Android phone before the event. Check all three previews, the native share sheet, and whether its selected save action really places all three images in the photo library. Also check cancelling the share sheet, individual downloads, and **Download all photos**. Allow multiple downloads if the browser asks. Browser automation cannot verify the phone's native share targets or photo library.

The gallery URL ends in `photo-booth/<random-session-id>/index.html`, with any application-key prefix added before that path. It uses a complete file URL, so no static website index routing is required. HTML is uploaded with its content type and an inline disposition; B2 preserves the [upload content type and download disposition metadata](https://www.backblaze.com/apidocs/b2-upload-file).

When B2 is enabled and configured, each saved session uploads automatically and the QR appears only after the upload finishes. When Gmail is also configured, the email box remains available beside the QR. Email still sends the three JPEG attachments independently of B2. Failed uploads keep the local photos and offer a retry; configured email delivery remains available. Guests open the gallery by scanning the QR on their own phones.

**These are public links.** Random session folders make links difficult to guess, but anyone who has a link can view and share the photos. The gallery contains no recipient email address or credentials. There is no guest password or automatic link expiry. Disabling B2 sharing does not revoke existing links. Manage deletion and retention in Backblaze, including any old file versions or partially completed uploads; deleting local photos does not remove cloud copies. Use a dedicated event bucket and agree on a retention policy before sharing guest photos.

The local server needs internet access to upload. Once uploaded, the gallery remains available from B2 while the booth is offline or switched off, subject to your bucket access, retention, and account limits. A real B2 upload and phone download check requires your own account; automated tests use mocked B2 responses and do not upload guest photos.

## Local data

`.data/` contains the studio settings, normalized background uploads, captured JPEGs, recipient addresses, B2 sharing status/URLs, and server-side Gmail and B2 secrets. It is excluded from Git and build tracing. The app creates directories with mode `0700` and files with mode `0600`; secrets are stored locally and are never returned by an API. Back up this folder if you need to preserve your event. Do not share it or commit it. Enabling B2 also creates the public cloud copies described above.

All API routes accept localhost and IPv4 addresses currently assigned to the booth computer, and reject unrelated hostnames and cross-origin browser requests. Admin is accessible to devices on the same trusted network and has no login or multi-operator coordination. Guest configuration responses exclude gallery photos, recipients, delivery history, and sender settings. Keep access on a trusted network or VPN.

## Checks

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

The tests cover countdown timing and cancellation, chroma keying, actual route handlers, image validation and normalization, atomic writes, session idempotence, recipient history, Gmail transport success/failure, secret redaction, local-request checks, camera process timeouts, USB reconnection, and temporary-file cleanup. Email tests use a mock transport and never send mail.

The built-in scenery is bundled locally from [Unsplash](https://unsplash.com), so the booth does not need to fetch background images during an event.

## Isolated capture acceptance check

`tests/fixtures/fake-gphoto.mjs` and its clearly labeled synthetic green-screen frame allow testing the complete kiosk flow without using a physical camera. The driver refuses to run without the test flag and a separate data folder.

After building, start a separate production instance:

```bash
task_test_data=$(mktemp -d /tmp/still-kiosk-test.XXXXXX)
PHOTO_KIOSK_DATA_DIR="$task_test_data" STILL_TEST_ONLY=1 \
GPHOTO2_PATH="$PWD/tests/fixtures/fake-gphoto.mjs" \
npm start -- --port 3001
```

Open `http://127.0.0.1:3001/admin`, choose Canon tethering, save, then open `/kiosk` on that port. Press **Start live preview**, start a session, and check that three composited photos appear in review and in the admin gallery. Keep Gmail unconfigured for this test. The normal booth’s `.data` folder is unaffected.

A browser acceptance run verified live chroma preview, the five-second first countdown, three shutter events separated by three-second countdowns, three saved 2400 × 1600 JPEGs, thumbnail review, missing-Gmail handling, next-guest reset, capture cancellation, and admin gallery visibility. This synthetic check supplements the unit tests; it does not replace a live check with your Canon and Gmail account.
