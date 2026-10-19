# Still · Photo kiosk studio

A local photo booth for a green screen and a USB camera. Built with Next.js 16, React, and TypeScript.

- **Admin:** [http://127.0.0.1:3000/admin](http://127.0.0.1:3000/admin) (also available at `/`). Manage backgrounds, green-screen tuning, camera settings, Gmail, and the gallery with recipients and delivery history.
- **Kiosk:** [http://127.0.0.1:3000/kiosk](http://127.0.0.1:3000/kiosk). Live background replacement, a five-second countdown, three photos with three-second intervals, review/retake, and email entry after capture.

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

Dev and production bind to `127.0.0.1`. Open the kiosk in a second browser window and use its fullscreen button. Keep the studio server running throughout the event. The app needs a writable local disk; it is designed for one Node process and one booth, rather than static or serverless hosting.

## Set up the booth

1. In **Camera setup**, choose a webcam or **Canon tethering**. Save the selection, then open the preview. A webcam needs browser camera permission on localhost.
2. Choose one of six built-in backgrounds, or upload a JPEG, PNG, or WebP up to 10 MB. Set up an evenly lit green screen behind the guests.
3. Under **Green screen magic**, open the live preview and adjust color similarity, edge softness, and spill reduction. Changes appear immediately in this preview; save to apply them to the kiosk.
4. In **Email delivery**, enter the sender address, display name, and a Google app password. Customize the subject/message, save, then send a test to an address you control.
5. Launch the kiosk. Guests have five seconds before photo one, then three seconds between each remaining photo. Photos are saved before email is requested. Guests can retake or download if email is unavailable.

The admin refreshes on focus and the gallery has a refresh button. The kiosk picks up saved settings between guests, polling every 15 seconds while idle. A reset waits for fresh settings before enabling another session. Start a fresh session to apply changes made during capture.

## Canon EOS 5D Mark IV

The Canon is controlled directly over USB through **gphoto2** on the studio computer. The official [libgphoto2 camera list](https://gphoto.sourceforge.io/proj/libgphoto2/support.php) lists the EOS 5D Mark IV with capture, trigger, Liveview, and configuration support. The app uses the documented [gphoto2 CLI](https://gphoto.sourceforge.io/doc/manual/ref-gphoto2-cli.html).

```bash
# macOS with Homebrew
brew install gphoto2

# Debian / Ubuntu
sudo apt install gphoto2
```

Connect a USB data cable, switch the camera on, select still-photo mode and Manual (M) exposure, and choose JPEG or RAW+JPEG image quality. Close EOS Utility, Photos, Image Capture, and any other software claiming the camera. The app never terminates those applications itself.

Choose **Canon tethering** in Admin. ISO, aperture, and shutter speed are applied to the connected camera before preferences are saved, so a rejected setting remains visible in the form. Disconnected preferences can be saved; connect the Canon and save again to apply exposure. Lens limitations or camera mode can prevent a requested setting.

The DSLR preview uses JPEG preview frames at up to one frame per second. The shutter takes a separate high-resolution photograph, composites it with the same crop as the preview, and saves a JPEG up to 2400 pixels wide. Originals remain on the camera card. Browser-camera preview runs at up to 24 fps.

Cancelling a session aborts pending capture requests and skips queued shutter commands. The server waits for its own camera process to exit before releasing the camera or cleaning up temporary files. A shutter that already fired cannot be undone; cancelled frames are discarded by the kiosk.

Diagnostics:

```bash
gphoto2 --auto-detect
gphoto2 --summary
gphoto2 --capture-preview
```

Copy `.env.example` to `.env.local` if gphoto2 needs an explicit path, such as `GPHOTO2_PATH=/opt/homebrew/bin/gphoto2`, or to choose a different data directory. Restart the server after changing environment variables.

Canon compatibility is implemented and tested with a simulated CLI. A final live check with the physical camera is still required before an event. USB ownership, lens behavior, operating-system permissions, and camera firmware can affect tethering.

## Gmail

Enable Google **2-Step Verification** and generate a [Google app password](https://support.google.com/accounts/answer/185833?hl=en). Enter the 16-character app password in Admin, not your normal Google password. Some managed accounts do not permit app passwords.

The server uses `smtp.gmail.com:465` with TLS and sends the three JPEG attachments. See [Nodemailer’s Gmail guide](https://nodemailer.com/guides/using-gmail). Gmail needs internet access and applies its sending limits. If a Google account password changes, its app passwords can be revoked.

“Sent” means Gmail accepted the email; it does not guarantee inbox delivery. SMTP errors retain the captured photos and recipient details for review/retry. Successful retries to the same latest recipient are idempotent. Sending to a new recipient keeps previous delivery history. If the server stops during a send, the session is marked interrupted on restart; inspect Gmail’s Sent folder before retrying an uncertain send.

## Local data

`.data/` contains the studio settings, normalized background uploads, captured JPEGs, recipient addresses, and server-side Gmail app password. It is excluded from Git and build tracing. The app creates directories with mode `0700` and files with mode `0600`; the password is stored locally and is never returned by an API. Back up this folder if you need to preserve your event. Do not share it or commit it.

All API routes require a local host and reject cross-origin browser requests. This is a local studio, with no remote login or multi-operator access model. Guest configuration responses exclude gallery photos, recipients, delivery history, and sender settings. Do not expose the server on a public or shared network.

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

Open `http://127.0.0.1:3001/admin`, choose Canon tethering, save, then open `/kiosk` on that port. Capture a session and check that three composited photos appear in review and in the admin gallery. Keep Gmail unconfigured for this test. The normal booth’s `.data` folder is unaffected.

A browser acceptance run verified live chroma preview, the five-second first countdown, three shutter events separated by three-second countdowns, three saved 2400 × 1600 JPEGs, thumbnail review, missing-Gmail handling, next-guest reset, capture cancellation, and admin gallery visibility. This synthetic check supplements the unit tests; it does not replace a live check with your Canon and Gmail account.
