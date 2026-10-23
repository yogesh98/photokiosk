# Still · Photo kiosk studio

A local photo booth with green-screen or on-device AI background replacement and a USB camera. Built with Next.js 16, React, and TypeScript.

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

**Saved settings survive rebuilds.** Backblaze and Gmail credentials entered in Admin, booth preferences, backgrounds, and photos remain in the checkout's `.data/` folder (or `PHOTO_KIOSK_DATA_DIR` if configured). Rebuilding never deletes that folder. Runtime `.env` files are loaded from the checkout, so `.env.local` is preserved too; relative data-directory overrides are resolved against the checkout. Optional AI weights and `.venv-ai` are reused across releases. Back up the data folder separately.

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
3. Under **Background replacement**, choose **Green screen**, **AI background**, or **Off**. Green screen uses a physical green backdrop and offers color similarity, edge softness, and spill reduction controls. AI background offers people models and general foreground models for subjects and props without a green screen. Off keeps the camera's original scene. Open the live preview to check the result, then **Save adjustments** to apply it to the kiosk.
4. Optionally configure **Backblaze B2** for QR sharing using the instructions below. In **Email delivery**, optionally enter the sender address, display name, and a Google app password. Customize the subject/message, save, then send a test to an address you control.
5. Launch the kiosk. Guests have five seconds before photo one, then three seconds between each remaining photo. Photos are saved locally before sharing starts. B2 uploads run automatically when enabled; email entry appears when Gmail is configured. Guests can use both when both are configured, or keep local downloads when neither is configured.

The admin refreshes on focus and the gallery has a refresh button. The kiosk picks up saved settings between guests, polling every 15 seconds while idle. A reset waits for fresh settings before enabling another session. Start a fresh session to apply changes made during capture.

Hold **I + P** together on a physical keyboard for about a second to show the booth computer's local IPv4 addresses. Release either key to hide them. The shortcut stays inactive during email entry. The email screen has a touch keyboard with **@gmail.com** and **@yahoo.com** shortcuts.

The kiosk displays each photo's scene before starting its countdown and uses that scene in the saved photo. The camera and AI model stay loaded while backgrounds switch. The plan is fixed for the guest's session, and the gallery keeps the background name for each photo. Sequences work with both green screen and AI; Off preserves the original camera scene for all three shots.

## Local AI background replacement

**AI background** offers seven models in **Admin → Backgrounds → AI model**: three people models, three BiRefNet general foreground models, and a model that uses a captured empty scene. Pick one, open the live preview, then save your choice for the kiosk. The default remains Fast.

| Choice | Model | What to compare | Model size |
| --- | --- | --- | --- |
| Fast (default) | [MediaPipe Selfie](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter), 256 × 256 | Lightweight person segmentation; a good baseline for a mini PC. | 244 KiB |
| Detailed | MediaPipe Selfie Multiclass, 256 × 256 | A heavier model that separates hair, skin, clothing and accessories; all person categories are retained. | 15.6 MiB |
| Portrait | [MODNet](https://github.com/ZHKKKe/MODNet), up to 512 pixels | Portrait matting with continuous transparency for fine edges and hair. | 24.7 MiB |
| General foreground · Lite | [BiRefNet Lite](https://huggingface.co/ZhengPeng7/BiRefNet_lite), 1024 × 1024 | The smallest general model; compare retention of principal subjects, props, and other objects. | 214 MiB |
| General foreground · Large | [BiRefNet General](https://huggingface.co/ZhengPeng7/BiRefNet), 1024 × 1024 | A larger general foreground model; compare edge quality and processing time. | 928 MiB |
| General foreground · Matting | [BiRefNet Matting](https://huggingface.co/ZhengPeng7/BiRefNet-matting), 1024 × 1024 | A larger model tuned for fine edges and transparency. | 897 MiB |
| Reference background · MobileNet | [BackgroundMattingV2 MobileNetV2](https://github.com/PeterL1n/BackgroundMattingV2), 768 × 512 | Uses an empty scene from the same fixed camera to separate people. Requires a reference capture first. | 19.1 MiB |

Inference runs locally, with no account, API key, cloud service, or dedicated GPU required. The three original people models are bundled locally, and matching MediaPipe/ONNX browser runtimes are copied from pinned npm dependencies during setup/build. Their CPU inference uses WebAssembly in a browser worker and does not require cross-origin isolation headers. BiRefNet and BackgroundMattingV2 use a local Python process with ONNX Runtime CPU or supported native acceleration and need the one-time setup below. Only the selected model/runtime loads. Camera frames remain on this computer. After dependencies and model weights are downloaded, AI background replacement works without internet access.

### Set up the native foreground models

Install Python 3.11–3.14, then run this once from the project folder:

```bash
npm run setup:foreground
npm run setup:ai
```

`setup:foreground` downloads the three pinned BiRefNet ONNX files and the BackgroundMattingV2 file to ignored local model storage, about 2.16 GB combined. To download only the reference model, run `npm run setup:foreground -- background-matting-mobilenet`. `setup:ai` prepares or updates the project-local `.venv-ai` runtime; rerun it when upgrading an older native setup so ONNX Runtime CPU and reference-image decoding are installed too. Initial package and weight downloads need internet access. Allow additional RAM for inference and disk space for optional compiled model caches. The weights are prepared explicitly, rather than downloaded during camera use. The three original people models work without this setup. You can use `PHOTO_KIOSK_AI_PYTHON` to select a compatible existing Python environment when starting the app.

Choose **General foreground · Lite**, **General foreground · Large**, or **General foreground · Matting** in Admin after setup. **CPU** runs BiRefNet through local ONNX Runtime. **Auto** also uses local CPU for predictable memory use and reports that choice in the runtime status. **GPU** requests native acceleration and reports an error if the model cannot initialize or process on it. If weights or Python packages are missing, the preview shows the setup error and capture stays blocked until corrected or another model is selected.

Development checks ran all three real models on public portrait and cat images, including the complete browser worker → local API → native inference path. CPU processing on the development Mac took about 3 seconds per frame for Lite, 5 seconds for General, and 7.5 seconds for Matting, excluding initialization. These are quality-comparison options with slow CPU preview. Lite's explicit Core ML GPU check failed because the pinned compiler rejected a convolution parameter; it correctly displayed an error. General/Matting GPU execution and Intel OpenVINO execution still need hardware validation.

### Capture an empty scene for BackgroundMattingV2

1. Save the camera settings, then select **AI background → Reference background · MobileNet** in Backgrounds.
2. Clear everyone from the camera scene. Keep the camera fixed and use locked focus, locked exposure, and steady lighting.
3. Click **Open empty-scene camera**. For Canon, explicitly press **Start live preview**. The capture button becomes available after a live frame arrives.
4. Click **Capture empty background**. This freezes the raw live frame with the same centered 3:2 crop and mirror as the kiosk, resizes it to 768 × 512, and saves a local PNG reference. It does not take a still photo or create a guest session. The empty-scene camera closes after saving and the reference thumbnail appears.
5. Open the regular preview controls, return people to the scene, and compare the result and timing. For Canon, start live preview again. Then **Save adjustments** to choose this model for the kiosk.

The reference is saved immediately; the model choice is saved only by **Save adjustments**. The two preview controls share the camera by opening one at a time. Changing the camera, device selection, mirror, or exposure settings makes a saved reference incompatible and requires recapture. Camera movement, focus changes, or changing light can also spoil the result even when the saved settings are unchanged; recapture the empty scene whenever these happen. Missing or incompatible references block this model's processed preview and capture.

BackgroundMattingV2 uses the current frame and the empty reference to predict a continuous alpha matte. The app composites the original camera RGB using that matte; it does not replace the camera colors with the model's foreground RGB output. Saved photographs keep the existing photo resolution of up to 2400 pixels wide, with the alpha matte scaled to match. Auto and CPU use local ONNX Runtime CPU; GPU is an explicit native hardware test.

An isolated synthetic Canon check captured an empty reference without a shutter command or guest session, then ran processed preview at about 120 ms per completed CPU frame (roughly 6 FPS including transport). A full guest session saved three 2400 × 1600 JPEGs using that reference. Direct synthetic inference also verified Core ML execution. These checks establish integration and throughput; evaluate real hair, props, camera alignment, and changing light on the booth before choosing this model.

Use a current desktop Chrome or Edge browser for the booth. AI preview is capped at 12 frames per second and processes one frame at a time; slower machines naturally run below that cap. Canon live preview starts only after an explicit button press, then processes frames from its persistent preview stream. Every saved photo gets its own mask from its frozen, cropped and mirrored frame, with the output retaining the existing resolution (up to 2400 pixels wide). Browser webcams and Canon captures use the same processing. Green screen and Off do not load the AI model.

Fast, Detailed, Portrait, and BackgroundMattingV2 are intended for people. The general foreground models can also retain props and other principal subjects, but may retain unwanted objects or omit less prominent subjects. Even lighting and separation from the background help. Fine hair, held props, distant people, and crowded groups can have imperfect edges; a well-lit green screen can give cleaner results. A larger model is not always better for a particular scene, and BiRefNet may take several seconds per preview frame on a CPU. Check quality, memory use, and responsiveness on the actual event computer before use. If AI cannot load or process a frame, the preview shows an error and blocks capture until retry succeeds or you select another mode/model.

Existing saved booths retain their previous background mode and start with the Fast AI model. Background images and green-screen tuning are retained when switching modes.

### Compare models on the booth computer

Open **Backgrounds**, select **AI background**, choose a model and acceleration setting, and click **Open live preview**. For the three original people models, **Auto** tries acceleration and falls back to CPU if it cannot run; for BiRefNet and BackgroundMattingV2, it selects local CPU for predictable memory use. **CPU** uses the browser CPU implementation for the original people models and local ONNX Runtime for BiRefNet and BackgroundMattingV2. **GPU** reports an error if acceleration fails, so a GPU benchmark cannot silently become a CPU benchmark. Existing booths start with Auto.

The preview reports the active runtime and any fallback reason as soon as initialization finishes. The comparison table starts reporting after three warm-up frames and five measured frames. Switch models or acceleration while the preview is open to compare them using the same camera, background, lighting, and pose. Each model, selected acceleration, and runtime has a separate row. Previous measurements remain in the table until you save or leave the panel.

Average frame time and 95th-percentile time measure AI processing plus compositing at the preview resolution, using a rolling window of up to 30 frames. Lower is faster. Preview FPS is the actual output rate, including camera delays and the 12 FPS AI cap; it is not the model's maximum possible speed. Canon's frame rate also depends on its USB preview stream, so compare frame processing time as well as observed FPS. Full-resolution capture and JPEG saving can take longer than preview processing. Inspect hair, hands, props, and groups as well as the timing numbers, then **Save adjustments** to use the chosen model in the kiosk.

### GPU acceleration on Intel Ubuntu and Apple Silicon

Fast and Detailed use MediaPipe's browser GPU delegate when available. Portrait tries browser WebGPU, then the optional native backend below. BiRefNet and BackgroundMattingV2 use the native backend: Auto and CPU use local ONNX Runtime CPU, while GPU requests Core ML or OpenVINO. Browser GPU support depends on the browser, graphics drivers, and model; successful initialization and processing determine availability.

For native Portrait acceleration, install Python 3.11–3.14, then run this once from the project folder:

```bash
npm run setup:ai
```

This creates a project-local `.venv-ai` and installs pinned packages. It does not alter the system Python. To choose a particular Python version, run `python3.12 scripts/native-ai/setup.py` instead. To use an existing compatible environment, set `PHOTO_KIOSK_AI_PYTHON` to its Python executable when starting the app.

| Computer | Native Portrait runtime | Requirements |
| --- | --- | --- |
| Intel Ubuntu, x86-64 | OpenVINO targeting the Intel GPU | Supported Intel GPU, supported Ubuntu release, and Intel GPU compute drivers accessible to the user running the app. |
| Apple Silicon Mac | ONNX Runtime Core ML, allowing GPU and CPU | Native arm64 Python and macOS 14 or later. |

On Ubuntu, install the graphics compute drivers appropriate to the exact Intel GPU using the [OpenVINO installation guide](https://docs.openvino.ai/2026/get-started/install-openvino.html). The setup command installs Python packages; it does not install system drivers or change device permissions. The Intel GPU must be listed by `.venv-ai/bin/python -c 'import openvino as ov; print(ov.Core().available_devices)'`. An Intel CPU alone does not establish GPU compatibility.

The native process is launched by the app and communicates over local process pipes; it does not open another network port. The first native run may take longer while compiling the model. Model caches live under `.data/native-ai`. Native Portrait uses a fixed 512 × 512 tensor, BiRefNet uses 1024 × 1024, and BackgroundMattingV2 uses 768 × 512; the complete frame is resized and the mask mapped back to its original aspect ratio.

The reported runtime identifies the execution backend, not a guarantee that every operation runs on one chip. Core ML can divide work between GPU and CPU; ONNX WebGPU can also use CPU for unsupported operations. Intel OpenVINO explicitly targets its GPU. Switching acceleration does not change which objects a model was trained to retain—test actual props before an event.

### Ubuntu / mini PC setup

Install Node.js 22 or later and a current desktop Chrome, Chromium, or Edge browser. Copy/clone the project, then run the following on the Ubuntu machine:

```bash
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000/admin` on that same machine and choose your background mode. Run `npm ci` on Ubuntu itself so native dependencies such as Sharp match Linux; do not copy `node_modules` from a Mac. A normal desktop session with browser WebGL support is required for MediaPipe's image handling, including in CPU mode. Integrated graphics is sufficient for the browser path; CUDA, Python, and a separate AI service are not required for the people models. Python is needed for BiRefNet, BackgroundMattingV2, and the optional native acceleration setup above. Unsupported browser graphics configurations show an error rather than saving an unprocessed photo.

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

For fixed exposure, choose **Manual settings (M)** and set the camera's dial to M. ISO, aperture, and shutter speed are applied to the connected camera before preferences are saved, so a rejected setting remains visible in the form. Disconnected manual preferences can be saved; connect the Canon and save again to apply them. Lens limitations or camera mode can prevent a requested setting. Switching exposure control can require recapturing an empty-scene background reference; keep exposure locked while using that reference model.

Press **Start live preview** to begin Canon live view, and **Stop live preview** to end it. The app runs one persistent `gphoto2 --capture-movie --stdout` process and displays its streamed preview JPEGs; it does not launch another camera process or take a full-resolution still for each preview frame. This is the [preview-streaming mode documented by gphoto](https://gphoto.sourceforge.io/doc/remote/), and the Canon must stay in still-photo mode. The mirror can move when live view starts or stops, rather than cycling for each displayed frame.

The kiosk starts Canon live view automatically after login, a server/browser restart, and a next-guest reset. While idle, it retries disconnected cameras, USB errors, and expired sessions with delays increasing from one to fifteen seconds. USB I/O failures or timeouts trigger a reset of the affected camera's port before the next live connection, at most once every thirty seconds. Each new live session detects the current USB address, including after a reset. Keep the camera powered on and connected. The app does not terminate other camera apps, and processing/settings errors still require correction.

Admin preview remains manual: opening its panel does not operate the camera, and an error requires **Start live preview** again. **Stop live preview** pauses automatic connection in the kiosk until explicitly started again or the preview is reopened. Hiding the kiosk stops its stream; returning to the visible idle kiosk reconnects it. Changing backgrounds, AI models, or processing settings does not restart a healthy camera stream. Browser frame requests read the latest cached stream image; they cannot start the camera. The owned stream also stops if its browser stops requesting frames.

Canon live preview stays active throughout each countdown. At each shutter, the kiosk holds the last displayed frame, stops live view, and takes one high-resolution session photo. After successful photos 1 and 2, it restores live view within that same guest session and waits for a fresh processed frame before starting the next three-second countdown. Automatic recovery never retries a still shutter or interrupts its USB ownership. After photo 3, preview stays stopped during review and reconnects for the next guest. Each saved photograph is composited with the preview's crop and saved as a JPEG up to 2400 pixels wide, with originals retained on the camera card. Webcam preview remains continuous at up to 24 fps, or 12 fps with AI background replacement.

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

When B2 is enabled and configured, each saved session uploads automatically and the QR appears only after the upload finishes. When Gmail is also configured, the email box remains available beside the QR. Email still sends the three JPEG attachments independently of B2. Failed uploads keep the local photos and offer a retry; local downloads and configured email delivery remain available.

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

AI tests also cover settings migration and model validation, confidence/alpha mask composition, rolling preview measurements, worker crashes/timeouts, serialized processing after cancellation, GPU fallback, device loss, and native process lifecycle. Run native preprocessing and setup tests with `.venv-ai/bin/python -m unittest discover -s scripts/native-ai -p 'test_*.py'` after optional native setup.

For real Portrait mask correctness, temporarily copy `tests/browser/modnet-gpu-parity.html` to `public/modnet-gpu-parity.html` while the app is running, open `http://127.0.0.1:3000/modnet-gpu-parity.html`, and choose a portrait. The check compares CPU and WebGPU alpha values on identical frames across three image shapes and repeated runs; it requires mean absolute error ≤ 0.001 and foreground IoU ≥ 0.99. Images stay in browser memory. Remove the temporary public HTML afterward. Run this check when changing the model, ONNX runtime, or GPU session options: finite, in-range masks alone do not establish correct segmentation. Portrait explicitly uses NCHW on WebGPU because the runtime's default layout produced fragmented masks in this check.

For the BiRefNet models, temporarily copy `tests/browser/general-foreground-check.html` to `public/general-foreground-check.html` and open it on localhost. Choose a public reference image with people, props, or other objects, then check all three models. The check loads models sequentially through the real kiosk worker/API, validates full-frame alpha output, and displays composites over a purple background for visual inspection. CPU and Auto are supported; GPU is an explicit hardware test. Remove the temporary public HTML after checking. Use `npm run setup:foreground -- --verify` to verify the installed weights without network access.

Chromium acceptance checks ran all three actual models on a public portrait and verified live model switching, retained CPU/GPU comparison measurements, and saved acceleration settings. Apple Silicon checks exercised MediaPipe GPU, ONNX WebGPU, browser CPU, and actual Core ML inference through the local API. Full AI kiosk sessions with the synthetic Canon driver verified three saved 2400 × 1600 JPEGs and photo review. These checks ran on the development Mac; Intel OpenVINO GPU execution and mini PC performance still need an on-device Ubuntu check.

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
