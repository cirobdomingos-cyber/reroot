# Android release (Google Play)

How the Capacitor Android app (`app.aue`) gets to Google Play. After the
one-time setup below, a build ships with:

```
git tag android-v1.2 && git push origin android-v1.2      # internal track
```

or **Actions → Android — Google Play → Run workflow** to pick a track
(internal, alpha, beta, production). The workflow is
[.github/workflows/android-play.yml](../.github/workflows/android-play.yml);
it uploads every build as a **draft** release while the app is unpublished.

## 1. Upload key (once)

Play App Signing keeps the real app-signing key at Google; we only hold an
**upload key**. Create it on your machine, never in the repo:

```
keytool -genkeypair -v -keystore aue-upload.jks -alias aue-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Keep the `.jks` and both passwords in the password manager. Then set the
GitHub secrets (repo → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 aue-upload.jks` (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("aue-upload.jks"))`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `aue-upload` |
| `ANDROID_KEY_PASSWORD` | key password (keytool's default PKCS12 uses the keystore password) |
| `PLAY_SERVICE_ACCOUNT_JSON` | full JSON key of the service account (step 3) |
| `GOOGLE_SERVICES_JSON_BASE64` | optional: base64 `google-services.json`, only for FCM push |

Local release builds read the same values from `android/keystore.properties`
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`; gitignored).

The old keystore whose fingerprint used to be in `backend/main.py` is public
in git history: never use it again.

## 2. First upload by hand (once)

Create the app in Play Console with package `app.aue` and enroll in **Play
App Signing** (the default for new apps). The Publishing API answers
"package not found" until the app has one build, so the **first AAB is
uploaded by hand**:

1. Run the workflow once (it fails at the upload step, which is expected) and
   download the `aue-android-*` artifact, or build locally with
   `cd android && ./gradlew bundleRelease -PversionCode=3`.
2. Play Console → Testing → Internal testing → Create release → upload
   `app-release.aab`.

From then on the workflow handles every upload. `versionCode` is
`run_number*10 + run_attempt`, always above the hand-set 2; a hand upload
uses a code the workflow has not reached yet.

## 3. Service account for the API (once)

1. Google Cloud Console (any project) → IAM → Service accounts → Create;
   no project roles needed. Keys → Add key → JSON. Enable the **Google Play
   Android Developer API** in that project.
2. Play Console → Users and permissions → Invite new user → the service
   account's e-mail → app `auê` → permission to release to testing tracks
   (and production, if CI will ship there).
3. Paste the JSON into `PLAY_SERVICE_ACCOUNT_JSON`.

## 4. Google sign-in on Android

Android signs in with Google's **Credential Manager** (the native account
sheet) through `@capgo/capacitor-social-login`, not the browser PKCE flow
iOS uses. The plugin asks Google for an **ID token** whose `aud` is the
**web** OAuth client (`511485926685-9a6hihg5...`, `VITE_GOOGLE_CLIENT_ID` in
the workflow); the app posts it to `/auth/google` as `id_token`, and the
backend verifies signature, issuer, `aud` (env `GOOGLE_WEB_CLIENT_ID`,
defaulting to that client), expiry and `email_verified`
(`backend/google_id_token.py`). The account is keyed on Google's `sub`, so
web, iOS and Android land on the same user.

Google only issues the token if an **Android OAuth client** (Google Cloud →
APIs & Services → Credentials) matches the installed app's certificate:
package `app.aue` with

- the SHA-1 of the **Play app-signing key** (Play Console → Test and
  release → App integrity), for builds installed from Play;
- the SHA-1 of the **upload key** (`keytool -list -v -keystore
  aue-upload.jks -alias aue-upload`), for local builds signed with it.

Both clients must be in the **same Google Cloud project** as the web client.
No secret is involved. The plugin is Android-only: `ios.includePlugins` in
`capacitor.config.json` keeps it (and the Google/Facebook iOS SDKs it would
pull in) out of the iOS build, so **a new Capacitor plugin that iOS needs
must be added to that list**. Its other providers are off
(`plugins.SocialLogin.providers`), so no Facebook SDK ships on Android.

## 5. Asset links

`/.well-known/assetlinks.json` (backend, `TWA_PACKAGE_NAME` /
`TWA_SHA256_FINGERPRINT` on Railway) matters only for a TWA or verified
Android App Links. The Capacitor app needs neither: leave
`TWA_SHA256_FINGERPRINT` empty unless a TWA ships, then set it to the Play
app-signing SHA-256.

## 6. Closed-test testers via `/install`

`auecuritiba.com/install` (the Instagram bio link) recruits the 12 closed-test
testers. Railway env vars, read in this order for Android: set
`PLAY_BETA_GROUP_URL` (the Google Group join link the closed test uses) while
the closed test runs, and `/install` serves a three-step page (join the group,
accept the test at `PLAY_BETA_OPTIN_URL`, install from the Play listing), with
an "Abre no Chrome" step first for Instagram/WhatsApp/TikTok webviews, where
Google sign-in is blocked. `PLAY_BETA_OPTIN_URL` defaults to
`https://play.google.com/apps/testing/app.aue`; change it only if the package
changes. Set `PLAY_STORE_URL` once the app is public on Play: `/install` then
302s Android straight to the listing and the beta page is skipped. With none
set, the old `PLAY_STORE_INTERNAL_URL` redirect (if set) or the PWA walkthrough
applies, as before.

## 7. Live updates (OTA) on Android

`/updates/check` offers Android only `OTA_ANDROID_BUNDLE_VERSION` (Railway;
empty by default = nothing), never the iOS `OTA_BUNDLE_VERSION`. Android
1.1.2 showed why: the production web bundle was applied under a page the
PWA service worker kept alive, and lazy chunks went missing ("Failed to
fetch dynamically imported module"). The service worker is now web-only,
but publish an Android bundle only after testing it on an Android device
(canary first: an Android device id in `OTA_CANARY_DEVICES` does get the
canary). A new AAB resets downloaded bundles (`resetWhenUpdate`).

## Going public

While the app has never been released to production, Play only accepts
`status: draft`. After the first production release, change `status` in the
workflow to `completed` so uploads roll out without a Console click.
