# BenchBox — UI design prompts (Claude Design)

The brief for designing the BenchBox Android app in Claude Design. It is written from the backend's
knowledge of every feature — `FRONTEND_API.md`, `BACKEND_PLAN.md` and the legal pages — so the screens
match what the server actually does. Theme: **Workbench, quiet**: soft neutrals, one grey-green accent
and a muted red kept for attention (final palette chosen 2026-10-23).

Keep it in step with those docs: when a feature's behaviour changes, change its prompt here in the same
commit.

## How to use it

1. In Claude Design, start a new project and paste **Prompt 1** as the first message. It carries the
   whole brief and the design system, and asks for the foundations plus four screens.
2. Refine that first round until the look is right. Every later round builds on it.
3. Send **Prompts 2–11** one at a time, in order, in the same project. Each designs one area of the app
   and ends with a "Done when" line to check before moving on.
4. Finish with **Prompt 12**, which asks for a handoff summary the app can be built from.

Before you start:

- **Placeholders.** The price (₹2.50 per GB a month), the free allowance (2 GB), the limit presets, the
  link expiry options and the credit packs are open decisions (`BACKEND_PLAN.md` §13). If any is decided
  first, change it in Prompt 1; the other prompts repeat some of them as sample data.
- **Not built yet.** Billing (Prompts 7–8) and share links (Prompt 9) are designed now so the app's
  navigation has room for them. Their details can still move when their API lands.
- **Fixed names.** The published delete-account page tells Play reviewers to go to
  **Settings → Account → Delete account** and tap **Delete**. Don't let any round rename those.

---

## Prompt 1 — Brief, design system, first screens

````text
You're designing BenchBox, an Android app. Build it as an interactive, clickable prototype in an
Android phone frame (412 × 915 dp) with a light/dark toggle, using static sample data. This message is
the full brief. Start with the design system and the four screens at the end. Later messages add the
rest of the app one area at a time, so keep every round consistent with this brief. Name screens by
round and number ("1.2 Files — root, list view") so we can refer to them. If something isn't covered
here, make a sensible choice and list it under "Assumptions" on the design system page.

# The product
BenchBox is pay-as-you-use cloud storage for India. People keep files and folders in the cloud, and
each month they pay only for the storage they actually kept, measured day by day.
- The first 2 GB are free.
- To store more, they set up auto-pay (UPI AutoPay, card or bank mandate) with a monthly limit they
  choose (₹100 by default), or buy Google Play credits in advance. Price: ₹2.50 per GB a month above
  the free 2 GB, plus 18% GST. (The price, the free 2 GB and the limit presets are placeholders: show
  them as examples.)
- The monthly limit caps what auto-pay charges, not what the user can owe. Reaching it only sends an
  alert, and uploads keep working. If a bill is above the limit, auto-pay charges the limit and the
  rest is paid by a payment link. Never imply "you'll never pay more than your limit".
- The app never calculates money. It shows the amounts the server sends.
- Sign-in is Google only. Android first (Kotlin Multiplatform, Jetpack Compose, Material 3); iOS comes
  later with the same design adapted.
- Who it's for: Indian smartphone users, UPI-native and price-conscious, who've outgrown their free
  storage but don't want to pay for a big plan they won't fill. English first; leave room for longer
  Hindi strings later.

# The mood
- Clean and neat: very few colours, all of them soft. Nothing vibrant, nothing decorative.
- Safe: it holds private files and a mandate on the user's bank account. Serious, never playful.
- Calm about money: the bill should reassure, never alarm. Amounts stand out through size and weight,
  not colour.
- Transparent: numbers are the main content. Big, legible, and explained in plain words.
- Practical: most time is spent in file lists and uploads. Quick, dense, out of the way.
- Distinct: Google Drive, Dropbox and OneDrive are all blue. BenchBox isn't.

# Theme: Workbench, quiet
A clean workbench with labelled boxes: tidy and honest. Soft neutrals do almost all the work. One
grey-green accent, barely coloured, marks what can be tapped, what's selected and what's going well.
One muted brick red appears only when something needs the user's attention. There are no other colours:
the colour on screen should come from the user's own photos. Use the accent exactly as given; don't
drift towards teal, mint or any brighter green. Flat surfaces with hairline borders. No gradients,
glows or heavy shadows.

## Colour
Eleven tokens and nothing else. Don't add hues, tints or one-off colours.
| Token | Light | Dark | Used for |
|---|---|---|---|
| background | #F7F6F3 | #161918 | app background |
| surface | #FFFFFF | #1E2221 | cards, list rows, sheets, dialogs |
| surface-muted | #EFEEEA | #262B2A | search field, chips, file-type tiles, the empty part of meters |
| outline | #E3E1DC | #333938 | hairline borders, dividers |
| text | #1F2523 | #E8E9E6 | primary text and icons |
| text-muted | #646966 | #A3A8A5 | secondary text, metadata, placeholders |
| accent | #4A5A56 | #A7B5B1 | primary buttons, links, selection, folder icons, progress, meters, success |
| accent-soft | #E2E8E6 | #283130 | selected rows, tonal buttons, "Paid" chips (text on it uses accent) |
| danger | #8C5048 | #CC9E95 | over the limit, payment due or failed, destructive actions |
| danger-soft | #F4E9E6 | #332522 | attention banners (text on it uses danger) |
| on-fill | #FFFFFF | #161918 | text and icons on accent or danger fills |

Map them to Material 3: primary = accent, primaryContainer = accent-soft, error = danger,
errorContainer = danger-soft, surfaceVariant = surface-muted, plus background, surface and outline.
Secondary and tertiary reuse the accent; don't introduce new hues. Turn Material You dynamic colour
off, so the app always looks the same. Every text pair here meets WCAG AA; keep it that way. Underline
links in running text, because the accent sits close to the text colour.

## Type
Inter (it has the ₹ sign). Tabular figures for every number: sizes, amounts, percentages and dates in
lists.
| Style | Size / line | Weight | Used for |
|---|---|---|---|
| Display | 36 / 44 | SemiBold | the hero amount or size on Usage |
| Headline | 24 / 32 | SemiBold | screen titles (large top app bar) |
| Title | 18 / 24 | SemiBold | card and section titles |
| Body | 16 / 24 | Regular | body text, row names |
| Body small | 14 / 20 | Regular | metadata, helper text |
| Label | 14 / 20 | SemiBold | buttons, tabs |
| Caption | 12 / 16 | Medium | chips, meter labels, timestamps |

## Shape, space, icons, motion
- Corners: 12 dp for cards, list groups and buttons (not pills); 8 dp for chips and small controls;
  16 dp for the FAB; 28 dp on the top corners of bottom sheets.
- A 4 dp grid. 16 dp screen margins and 24 dp between sections. List rows 64 dp tall (72 dp with a
  thumbnail). Touch targets at least 48 dp.
- Elevation: flat. Hairline outlines instead of shadows; only sheets, dialogs and the FAB lift.
- Icons: Material Symbols Rounded, 24 dp. Folders use the accent. File types (image, video, audio,
  PDF, document, spreadsheet, presentation, archive, other) are text-muted glyphs on surface-muted
  tiles. Images and videos show their thumbnail when they have one.
- Motion: calm, 200–300 ms, standard easing. Meters fill on load. No bounces, no confetti.
- Illustrations only on empty states: simple line drawings in text-muted, with at most one accent
  detail. Motifs: a tidy bench, labelled boxes, a luggage tag.

## The meters (the signature component)
- Storage meter: storage used against the free allowance. Segments: files (accent), trash (accent at
  40%), uploading (accent outline). Label: "1.4 GB of 2 GB free used". At 90%: "Almost full". At 100%
  the bar turns danger: "Full. Uploads are paused."
- Bill meter: this month's amount so far (accent) against the monthly limit, which a tick marks. A
  segment of accent at 40% extends to the estimated month-end amount. If the estimate passes the
  limit, the part beyond the tick is danger at 40%. If the amount so far passes the limit, the bar
  rescales so the tick sits at 75%, and the excess is solid danger after a 2 dp gap.
- Every state is also said in words, with an icon: "On track" (accent check), "Heads-up" (an info icon
  in the text colour, on a surface-muted callout), "Over your limit" (danger alert). Never colour alone.
- Both: an 8 dp bar with 4 dp corners, on surface-muted.

# Voice and words
- Plain, warm and direct. Sentence case. Contractions. No exclamation marks, no "please", no
  "successfully". Errors say what happened, then what to do.
- Money copy is exact: what will be charged, how, and when.
- Use these words: Files, Trash, Restore, Delete forever, Empty trash, Upload, Share link, Monthly
  limit (never "cap"), Auto-pay (never "mandate"), This month so far, Estimated bill, Statement, Free
  allowance, Play credits, Signed-in devices, This device.
- Formats: ₹ with Indian digit grouping (₹1,00,000.00), and amounts to the paisa on statements. Sizes
  in decimal units (1 GB = 1,000,000,000 bytes, the unit phones use): "2.4 GB", "850 MB". Dates
  "23 Oct 2026", times "4:05 pm"; lists say "Today", "Yesterday", "3 Oct".
- Sample data: the user is Asha Verma (asha.verma@gmail.com). Folders "Diwali 2026", "College notes",
  "Documents", "Camera 2026". Files "Rent agreement.pdf" (2.1 MB), "Goa trip.mp4" (1.2 GB),
  "IMG_2041.jpg" (3.5 MB), "Trip budget.xlsx" (48 KB). Today is 23 Oct 2026.

# Platform
Material 3 components and behaviour: top app bars, navigation bar, extended FAB, search bar, bottom
sheets, dialogs, snackbars. Edge to edge, predictive back. Every screen in light and dark; dark follows
the system unless the user picks otherwise. Check 360 dp-wide phones and 200% text size. Every icon
button has a TalkBack label.

# Navigation
A navigation bar with three destinations:
1. Files: the file browser. A search bar at the top and an "Upload" extended FAB. The overflow menu
   holds View (list or grid), Sort (name, last modified, size), Trash, Shared links and Uploads. While
   uploads run, a slim strip above the navigation bar ("Uploading 3 files · 42%") opens the uploads
   screen.
2. Usage: storage used, this month's bill, the monthly limit, auto-pay, Play credits and statements.
3. Settings: Account, Signed-in devices, Notifications, Appearance, Help and support, Privacy Policy,
   Terms & Conditions, About. The screen names Settings, Account and Delete account are fixed: a
   published page tells Google Play reviewers to follow exactly that path.
When the account has a payment due or is suspended, a banner sits under the top app bar on every tab.

# The whole app (later messages design these)
1. First run: welcome, Google sign-in, and the app gates (maintenance, forced update, offline).
2. Files: browse, item actions, new folder, rename, move, details, multi-select, search, offline edits.
3. Uploads: pickers, name clashes, the queue, failures, limits.
4. Open and download: image viewer, video player, other files, downloads.
5. Trash: restore, delete forever, empty trash, the 30-day rule.
6. Usage and bills: the Usage tab in every state, daily usage, statements, how billing works.
7. More storage: auto-pay setup, the monthly limit, Play credits, managing auto-pay.
8. Sharing: create a link, shared links, the public web page.
9. Settings: account, delete account, devices, notifications, appearance, legal.
10. System states: loading, empty, errors, signed out, push notifications.
Don't add features that aren't on this list: no automatic photo backup, favourites, recent files,
version history, comments, sharing with specific people, offline pinning, ads, or an in-app
notification inbox.

# This round
1. A design system page: the colour tokens in light and dark, the type scale, and these components in
   all their states: buttons (filled, tonal, outlined, text, destructive), list rows (folder, file, file
   with thumbnail, selected, waiting to sync, uploading), chips, search bar, top app bars, the
   navigation bar, the extended FAB, bottom sheet, dialog, snackbar, banners (info, heads-up,
   attention), both meters in every state, and the empty-state pattern.
2. Files, root, list view: the four folders and four files from the sample data, the Upload FAB and
   the navigation bar.
3. "Diwali 2026" in grid view: 24 photos and 2 videos, with thumbnails.
4. Usage on the free plan: the storage meter at 1.4 GB of 2 GB, the breakdown (files 1.2 GB, trash
   0.2 GB), the price in one line, and a "Get more storage" button.
Make the navigation bar clickable between these.
````

---

## Prompt 2 — First run, sign-in and app gates

````text
Next round: first run, sign-in and the app gates. Same brief and design system.

1. Splash: the BenchBox wordmark on the background. The app never waits on the network to open.
2. Welcome and sign-in, one screen: the wordmark, one line ("Pay only for the storage you keep"), three
   short points ("2 GB free", "Billed monthly for what you keep, measured daily", "A monthly limit you
   control"), and a "Continue with Google" button in Google's own style. Under it, the consent line:
   "By continuing you agree to our Terms & Conditions and Privacy Policy", both phrases linked (they
   open in an in-app browser).
3. Google's account chooser over it. It's system UI: show it as a placeholder sheet.
4. Signing in: a short progress state, then Files (an empty root for a new account).
5. Sign-in problems, shown on the welcome screen:
   - Not available yet (before launch): "Sign-in isn't available yet. Try again later."
   - Offline: "You're offline. Connect to sign in."
   - Too many tries: "Too many sign-in attempts. Try again in a minute."
   - Google account rejected: "That Google account can't be used. Try another one."
6. Signed out: when this device was signed out from another device, or after 90 days unused, the user
   lands on the welcome screen with a note: "You were signed out on this device. Sign in to continue."
7. Notifications permission: a short explainer before Android's prompt, shown the first time it matters
   (after the first upload, or when auto-pay is set up). "Get alerts about your bill: at 80% and 100% of
   your monthly limit, and when a bill is ready." Buttons "Turn on" and "Not now".
8. Maintenance (full screen, blocks the app): the server's message, e.g. "BenchBox is down for
   maintenance until 2:00 pm. Your files are safe.", and "Try again".
9. Update required (full screen, blocks the app): "Update BenchBox to keep using it", the server's
   optional message, and "Update" (opens the Play Store).
10. Update available (dismissible sheet): "A new version of BenchBox is ready", "Update" and "Not now".
11. Offline: a banner under the top app bar, "You're offline. Showing the files saved on this phone."
    Browsing works from the phone's copy of the file list.

Done when: every screen exists in light and dark, and sign-in is clickable from splash to Files.
````

---

## Prompt 3 — Files: browse and organise

````text
Next round: browsing and organising files. Same brief and design system.

1. A folder ("Documents"): top app bar with back, the folder name, a path subtitle ("Files › Documents"),
   search, and an overflow menu (New folder, Select, View, Sort). Folders always come first. File rows
   show "2.1 MB · 12 Oct"; folder rows show "12 items". Long names are shortened in the middle so the
   extension stays visible. Pull to refresh. Folders can hold thousands of items: show a fast-scroll
   handle.
2. Item actions (the ⋮ on a row): a bottom sheet with the item's icon, name and size, then Open,
   Download (files only), Share link, Rename, Move, Details, and Move to trash.
3. New folder: a dialog with a name field. Errors under the field:
   - empty name;
   - too long (names are up to 255 bytes);
   - not allowed: "/", "\", control characters, or a name that is just "." or "..";
   - taken: "There's already a folder called 'Photos' here." Names are unique ignoring case. Offer
     "Keep both", which creates "Photos (1)".
4. Rename: the same dialog, with the name before the extension selected.
5. Move: a full-screen folder picker that starts in the current folder. Folders only, with a path
   bar, "New folder", and "Move here". The item itself and its subfolders can't be chosen. After
   moving: a snackbar, "Moved to Documents", with "Undo".
6. Move to trash: a snackbar with "Undo". For a folder: "'Diwali 2026' and its 26 items moved to
   trash".
7. Details: a sheet with type, size, location, created and modified.
8. Multi-select (long-press a row): a contextual top bar ("3 selected") with Download, Move, Move to
   trash, and Select all. Share link works on one item at a time.
9. Search: the search bar expands to a full screen. Results show the folder each item is in
   ("Documents › Bills") with the match highlighted. Searching skips the trash. No results: "No files
   named 'xyz'". Offline: "Showing results saved on this phone".
10. Sort and view: a sheet with Name, Last modified, and Size (ascending or descending), and a
    list/grid toggle.
11. Offline edits: new folder, rename, move and trash all work offline. The row shows "Waiting to sync"
    with a small cloud-off icon until it's sent.
12. Changed on another device: when an offline edit meets a change made elsewhere, ask. "'Report.pdf'
    was renamed to 'Report final.pdf' on another device." Buttons "Keep 'Report final.pdf'" and
    "Use 'Report v2.pdf'".
13. Refreshing everything: after 90 days away, the app reloads the whole file list. A full-screen state
    "Refreshing your files", with a count.
14. Empty states: a new account's root ("Your files live here", with "Upload"), and an empty folder
    (with "Upload" and "New folder").
15. Errors: "That folder isn't there any more. It was moved or deleted on another device."; "This item
    is in the trash. Restore it first."

Done when: every action in the sheet leads somewhere clickable, and each error appears in context.
````

---

## Prompt 4 — Uploads

````text
Next round: uploads. Same brief and design system.

1. Starting: the Upload FAB opens a sheet with "Photos and videos" (Android's photo picker), "Files"
   (the system file picker) and "New folder". The pickers are system UI: show them as placeholders.
2. Too big: files over 10 GB are left out, and the rest still upload. "'Movie.mkv' is 12.4 GB. Files
   can be up to 10 GB."
3. Name clash, checked before any bytes move: "'IMG_2041.jpg' is already in this folder." Choices:
   - Replace: "The existing file is replaced. Its old version can't be recovered."
   - Keep both: the new file becomes "IMG_2041 (1).jpg".
   - Skip.
   Add a checkbox, "Do this for all 5 clashes". If a clash appears only at the end of an upload, ask
   the same question then: nothing is lost.
4. In the folder: files being uploaded appear at the top as placeholder rows with a progress ring,
   until they land.
5. The uploads screen (from the strip above the navigation bar, or the overflow menu): sections In
   progress, Failed, and Done. Each row has a thumbnail or type icon, the name, the destination ("to
   Diwali 2026"), a progress bar with "504 MB of 1.2 GB", and its state:
   - Waiting
   - Uploading 42%
   - Waiting for a connection (resumes by itself)
   - Finishing
   - Uploaded
   - Failed, with the reason and "Retry"
   - Cancelled
   Row actions: Cancel and Retry. Screen actions: "Cancel all" and "Clear finished". Uploads carry on
   in the background, after the app is closed and after a restart, and resume where they stopped.
   Never "start again from zero".
6. Android notifications: "Uploading 3 files · 42%" with Cancel while it runs; "3 files uploaded" when
   done; "1 upload failed" (opens the uploads screen).
7. Not enough space: a sheet, "Not enough space. 'Goa trip.mp4' needs 1.2 GB, and you have 0.6 GB
   left." Actions: "Get more storage" and "Free up space" (opens Trash).
8. Over 50 uploads at once: the rest wait their turn with no error ("Waiting").
9. Storage service unreachable: affected rows show "Can't reach storage. Retrying…", then "Failed" with
   "Retry".
10. Uploads switched off by the server: the upload buttons are hidden. The uploads screen says
    "Uploads are paused for now. Uploads already under way will finish."
11. Payment due or account suspended: "Uploads are paused until your payment of ₹31.00 is made", with
    "Pay now".
12. Spending note (once billing is live). When new uploads push the estimated bill past the monthly
    limit, inform; never block or ask before uploading. "These uploads bring your estimated bill to
    ₹112, above your ₹100 limit. Auto-pay charges up to ₹100; we'll send a link for the rest." Action
    "Raise limit".

Done when: the flow is clickable from the FAB to a finished upload, and every state appears on the
uploads screen.
````

---

## Prompt 5 — Open and download

````text
Next round: opening and downloading files. Same brief and design system.

1. Image viewer: full screen on a dark background in both themes. Swipe through the folder's photos and
   videos, pinch to zoom. Top bar: back and the name. Bottom actions: Share link, Download, Details,
   Move to trash.
2. Video player: plays while it streams, so you can seek before it has fully loaded. Same actions.
3. Other files: they open in another app. While the file is fetched: "Getting 'Rent agreement.pdf'
   (2.1 MB)…", then Android's "Open with" chooser (system UI: show a placeholder).
4. Download: saves a copy to the phone's Downloads folder. Progress shows in a notification. When it's
   done, a snackbar: "Saved to Downloads", with "Open".
5. No thumbnail yet: show the file type's tile. Thumbnails already seen show offline too.
6. Offline: "Connect to open 'Goa trip.mp4'."
7. Error: "Couldn't open the file. Try again."

Done when: a photo, a video and a PDF each open from the "Diwali 2026" and "Documents" folders.
````

---

## Prompt 6 — Trash

````text
Next round: the trash. Same brief and design system.

1. Trash (from the Files overflow menu, and from Usage):
   - A header card: "Files in the trash still count towards your storage until they're deleted
     forever.", with the size (1.2 GB) and "Empty trash".
   - A line under it: "Items are deleted forever after 30 days."
2. The list shows what the user trashed, most recent first. Each row: the name, where it came from
   ("From Documents"), "Deleted 3 days ago", and "Deletes in 27 days" (text-muted; danger only on
   the last day).
3. Row actions: Restore, Delete forever, Details. Multi-select offers Restore and Delete forever.
4. A trashed folder can be opened and browsed. Its contents can't be restored on their own: "Restore
   'Diwali 2026' to get this back", with "Restore folder".
5. After restoring, a snackbar:
   - normally: "Restored to Documents", with "Show";
   - when its folder is gone: "Restored to Files. Its folder isn't there any more.";
   - when the name was taken: "Restored as 'Report (1).pdf'".
6. Delete forever: a confirmation. "Delete 'Goa trip.mp4' forever? This frees 1.2 GB and can't be
   undone." For a folder, add "and the 26 items in it". Buttons "Delete forever" (danger) and "Cancel".
7. Empty trash: a confirmation. "Empty the trash? 14 items (1.2 GB) will be deleted forever. This can't
   be undone."
8. Files in the trash can still be opened and downloaded.
9. Empty: "The trash is empty", with "Things you delete stay here for 30 days."

Done when: restore, delete forever and empty trash are each clickable with their confirmations.
````

---

## Prompt 7 — Usage and bills

````text
Next round: the Usage tab and bills, the most important screens for trust. Same brief and design
system. Amounts stand out by size, not colour. The danger colour appears only when the user owes
something or is over the limit.

The Usage tab, top to bottom:
1. The standing banner, when it applies.
2. A hero card.
   - On the free plan: storage ("1.4 GB of 2 GB free").
   - With auto-pay: money. "₹35.12 · This month so far", "Estimated bill ₹48.38 by 31 Oct", the bill
     meter against "Limit ₹100", and a status line.
3. Storage: the storage meter and the breakdown (Files, Trash, Uploading), with "Manage trash".
4. Paying: "Auto-pay · UPI · ashav•••@okhdfc", "Monthly limit ₹100" with "Change", and "Next charge:
   around 2 Nov, for October's bill". Play credits: the balance ("₹0 · used before auto-pay" in these
   samples, except state I), with "Buy credits".
5. This month: daily usage.
6. Statements: the last three, and "All statements".
7. "How billing works", the price line ("₹2.50 per GB a month above your free 2 GB, plus GST"), and
   links to the Terms and the Privacy Policy.

Design each of these states as its own screen:
A. Free plan: 1.4 GB of 2 GB.
B. Free plan, almost full (1.9 GB), and full (2 GB, uploads paused), each with "Get more storage".
C. Auto-pay, on track: 18.4 GB stored; ₹35.12 so far; estimated ₹48.38; limit ₹100.
D. Heads-up: ₹84.10 so far (84% of the limit), estimated ₹131. "Your estimated bill is above your
   ₹100 limit. Auto-pay will charge ₹100, and we'll send a link for the rest." Actions "Raise limit"
   and "Free up space".
E. Over the limit: ₹112.40 so far. "You've passed your ₹100 limit. Uploads keep working."
F. Payment due. A danger banner on every tab: "Payment due: ₹31.00 by 9 Nov. Uploads are paused until
   it's paid.", with "Pay now" (opens a payment page in the browser). Downloads and share links still
   work.
G. Suspended. "Your account is suspended and your share links are off. Pay ₹31.00 to restore it.",
   with "Pay now". Then the warning: "Your files will be deleted on 24 Dec unless the bill is paid."
H. Paid again: "Payment received. Uploads are back on."
I. Play credits only, no auto-pay: the bill meter measures against the credit balance (₹150) instead
   of a limit. When the estimate is above the balance: "Your credits won't cover this month. Buy
   credits or set up auto-pay."

Daily usage: a bar per day of the month. The height is the GB stored that day, with the free 2 GB
drawn as a line. Tapping a bar shows "12 Oct · 18.2 GB · ₹1.47". Today's bar is lighter, because the
day isn't over.

Statements list: month, total and a status chip:
- Paid (accent-soft)
- Due (danger-soft)
- Failed (danger-soft)
- Paid with credits (surface-muted)
- Carried forward (surface-muted, text-muted): "Under ₹10, so it moves to next month."
Sample:
- September 2026: ₹43.27, Paid
- August 2026: ₹18.54, Paid (it includes ₹6.20 carried in)
- July 2026: ₹6.20, Carried forward

Statement detail (September 2026):
| Line | Amount |
|---|---|
| Storage | 500 GB-days |
| Free allowance | −60 GB-days |
| Billable | 440 GB-days = 14.67 GB-months |
| Storage at ₹2.50 per GB a month | ₹36.67 |
| GST 18% | ₹6.60 (shown as CGST 9% + SGST 9% when the user's state calls for it) |
| Total | ₹43.27 |
Then: "Paid by auto-pay on 2 Oct", "Download invoice", and "How it's calculated".

How billing works, one explainer screen built on the same example:
- 10 GB kept for 20 days, then 30 GB for 10 days: 500 GB-days.
- The free 2 GB covers 60 GB-days, leaving 440, about 14.67 GB-months.
- At ₹2.50 that's ₹36.67, plus GST of ₹6.60: ₹43.27.
Then:
- Files in the trash count until they're deleted forever. Thumbnails and unfinished uploads don't count.
- Downloads are free.
- Bills close on the 1st of each month, India time.
- Amounts under ₹10 move to the next month.
- Prices change only with 30 days' notice.

Done when: states A–I exist in light and dark, and Usage links to the statements, statement detail
and the explainer.
````

---

## Prompt 8 — More storage: auto-pay, monthly limit, Play credits

````text
Next round: getting more storage. Same brief and design system. Link the Terms and the Privacy Policy on
every screen of this flow.

1. Get more storage: two ways, one line each.
   - Auto-pay: "Pay each month for what you keep, up to a limit you set."
   - Play credits: "Pay in advance through Google Play."
   Show the price, then "Continue". This leads to Google Play's billing choice screen, where the user
   picks "Google Play" (credits) or "UPI AutoPay / card" (auto-pay). That screen is Google's system UI:
   show a placeholder.
2. Auto-pay setup, step 1, the monthly limit: ₹100 (default), ₹250, ₹500, ₹1,000, or a custom amount.
   Under it: "Auto-pay charges your actual bill each month, up to this limit. We alert you at 80% and
   100%. If a bill is higher, auto-pay charges the limit and we send a payment link for the rest, due
   in 7 days." Plus an estimate: "At your current 18.4 GB, a month costs about ₹48."
3. Step 2, your state: a searchable list of Indian states and union territories. Explain it: "We need
   this for GST."
4. Step 3, how to pay: UPI AutoPay (recommended), Debit or credit card, or Bank account.
5. Step 4, review: the limit, the method and the state. "Your bank or UPI app tells you before each
   charge." Then "Set up auto-pay". This opens the payment provider's page or the UPI app, where the
   user approves with their UPI PIN. It's external: show a placeholder.
6. Back in the app:
   - "Confirming with your bank…" (it can take a few minutes, and the user can leave);
   - then "Auto-pay is on" (limit ₹100, UPI), returning to Usage;
   - or "Auto-pay wasn't set up. Nothing was charged.", with "Try again";
   - or, if it's slow: "We'll let you know when your bank confirms."
   Note: "If your bank takes a small payment to set this up, it's added to your balance."
7. Manage auto-pay (from Usage): the method, the limit and the status.
   - "Change limit" uses the same chooser, with "Your current limit stays on until the new one is
     confirmed."
   - "Change payment method".
   - "Turn off auto-pay", with a confirmation: "Turn off auto-pay? You'll be back to the free 2 GB and
     can't upload beyond it. What you already owe is still due." Buttons "Turn off" (danger) and "Keep
     auto-pay".
8. Auto-pay turned off from the UPI app: a banner, "Auto-pay is off. Set it up again to store more
   than 2 GB."
9. Play credits: packs of ₹100, ₹250 and ₹500 (placeholders), bought through Google Play's purchase
   sheet (system UI: show a placeholder). Afterwards: "₹250 added to your Play credits." Note: "Credits
   pay your bills before auto-pay. They don't expire while your account is open, and they're lost if
   you delete it."
10. Before paid storage launches: "Get more storage" shows "More storage is coming soon."

Done when: auto-pay setup is clickable from Usage to "Auto-pay is on", and the credits path to "added".
````

---

## Prompt 9 — Share links

````text
Next round: share links. Same brief and design system.

1. Create (item actions → Share link): a sheet with the item. "Anyone with the link can view it."
   - A toggle: "Allow downloads".
   - Expiry chips: 1 day, 7 days (default) and 30 days (placeholders).
   - "Create link". The link then appears (benchbox.ferbotz.com/s/…) with "Copy", "Share" (Android's
     share sheet) and "Expires 30 Oct".
   - If the item already has links, list them above, each with Copy, Share and Revoke.
2. Shared links (Files overflow menu): every link the user made. Each row shows the item, then
   "Expires in 5 days", "Expired", "Revoked" or "Turned off by BenchBox", and "Downloads allowed".
   Actions: Copy, Share and Revoke. Revoke asks first: "Revoke this link? Anyone who has it won't be
   able to open it."
3. Suspended account: a banner, "Share links are off while your account is suspended."
4. The public web page that recipients open, with no sign-in, on a phone and on a desktop browser. The
   same Workbench look.
   - A file: its preview (image or video) or type tile, the name, the size, and "Download" when
     allowed.
   - A folder: its items with sizes. Tap one to preview or download it.
   - Never show the owner's name or email.
   - Footer: "Report this link" (a short form: a reason and optional details) and "Get BenchBox".
   - States: "This link has expired", "This link isn't available", and "Too many visits. Try again in
     a few minutes."
5. On a phone with BenchBox installed, a link opens in the app: a read-only "Shared link" view with
   the same content and Download.

Done when: creating, copying and revoking a link are clickable, and the web page exists for a file and a
folder.
````

---

## Prompt 10 — Settings, account and devices

````text
Next round: Settings. Same brief and design system. Keep the names Settings, Account, Delete account
and the button Delete exactly: Google Play reviewers follow that path from our published page.

1. Settings:
   - A profile header: Google photo, name and email.
   - Rows: Account, Signed-in devices, Notifications, Appearance, Help and support ("Contact support"
     opens an email to support@ferbotz.com), Privacy Policy, Terms & Conditions (both in an in-app
     browser), and About (version 0.1.0, build 1, open-source licences).
2. Account: photo, name, email, "Signed in with Google". Then:
   - "Sign out", which confirms: "Sign out of BenchBox on this phone? Uploads in progress will stop."
   - "Delete account", in the danger colour.
3. Delete account, a confirmation screen titled "Delete account":
   - A warning card: "Download anything you want to keep first."
   - What happens: all files and folders are deleted, including the trash; share links stop working;
     auto-pay is cancelled after a final bill for this month's storage; unused Play credits are lost;
     every device is signed out.
   - "This can't be undone."
   - A link: "What's deleted and what's kept" (the web page).
   - Buttons "Delete" (danger, filled) and "Cancel".
   - Then "Confirm it's you": Google's account chooser (system UI, a placeholder).
   - Then "Deleting your account…", and a final screen, "Your account is deleted", with "Done" (back to
     welcome).
   - Errors:
     - The user picked another Google account: "Choose asha.verma@gmail.com, the Google account you
       use with BenchBox.", with "Try again".
     - It took too long: "That took too long. Confirm it's you again."
4. Signed-in devices: most recently used first. Each row: a phone or tablet icon, the device name
   ("Pixel 8"), "Android · BenchBox 0.1.0", and "Active now" or "Last used 3 days ago". "This device" is
   a chip on the current one.
   - Tapping a row offers "Sign out this device".
   - "Sign out all other devices" sits at the bottom and confirms: "Sign out 2 other devices? They'll
     need to sign in again." Then a snackbar: "Signed out 2 devices".
   - A note: "Devices unused for 90 days are signed out automatically."
   Sample: Pixel 8 (this device), Redmi Note 13 Pro (3 days ago), Galaxy Tab S9 (12 Oct).
5. Notifications: what BenchBox sends, with the system permission state and "Open notification
   settings". Turning them on or off happens in Android's settings.
   - Usage alerts: at 80% and 100% of your monthly limit, and when your estimated bill is above it.
   - Bills and payments: bill ready, payment received, payment failed.
   - Uploads and downloads: progress and results.
   Note: "Bill alerts are also sent by email."
6. Appearance: System default, Light, Dark.

Done when: the full delete-account path is clickable, Settings → Account → Delete account → Delete →
Google → deleted, and every row in Settings leads somewhere.
````

---

## Prompt 11 — System states and notifications

````text
Last design round: the states between screens. Same brief and design system.

1. Loading: skeleton rows for lists, and a skeleton for Usage.
2. Empty states, using the illustration pattern: no search results, no shared links, and no statements
   yet ("Your first statement arrives on 1 Nov").
3. Errors:
   - generic: "Something went wrong. Try again.";
   - too many requests: "Too many requests. Try again in 30 seconds.";
   - storage unreachable: "Can't reach storage right now. Try again in a moment.";
   - an item deleted on another device: "This file isn't there any more."
4. Offline: the banner on every tab. Actions that need a connection say so.
5. Push notifications, as they look in Android's notification shade in light and dark. Each opens the
   screen in brackets.
   - "You've used 80% of your ₹100 limit" (Usage)
   - "You've passed your ₹100 limit" (Usage)
   - "Your estimated bill is above your limit" (Usage)
   - "Your October bill is ₹43.27. Auto-pay charges it around 2 Nov." (the statement)
   - "Payment received: ₹43.27" (the statement)
   - "Auto-pay couldn't charge ₹43.27. Pay by 9 Nov." (Pay now)
   - "Uploads are paused: a payment is due" (Usage)
   - "Your account is suspended" (Usage)
   - "Your files will be deleted on 24 Dec" (Usage)
   - Upload and download progress and results
6. A screen index page listing every screen in the prototype by name, grouped by round.

Done when: every state exists in light and dark, and the index lists every screen.
````

---

## Prompt 12 — Handoff

````text
Write the handoff for the developers who will build this in Jetpack Compose with Material 3:
1. The colour tokens: name, light, dark and Material 3 role.
2. The type scale, spacing and shape values.
3. Every component with its states and where it's used.
4. Every screen by name, grouped by area: what it shows, and where each action leads.
5. Every user-facing string, including errors, grouped by screen.
6. Every assumption you made that isn't in the brief, so we can confirm or change it.
````
