# BenchBox — Web app design prompts (Claude Design)

The brief for designing the BenchBox **web app** in Claude Design: the browser version of the Android
app, plus the public page that share links open. It is written from the backend's knowledge of every
feature, so the screens match what the server actually does. It uses the same theme, words and sample
data as the app's brief (`UI_DESIGN_PROMPT.md`): **Workbench, quiet** — soft neutrals, one grey-green
accent and a muted red kept for attention.

Keep the two briefs in step: when a colour, a word or a feature changes, change it in both, in the same
commit.

## How to use it

1. In Claude Design, start a new project and paste **Prompt 1** as the first message. If the Android
   app's design system is saved in Claude Design, select it too. Prompt 1 repeats its tokens, so the two
   stay identical either way.
2. Refine that first round until it sits beside the app's design as the same product.
3. Send **Prompts 2–11** one at a time, in order, in the same project. Each ends with a "Done when" line.
4. Finish with **Prompt 12**, the handoff for the web developers.

Before you start:

- **Placeholders.** As in the app's brief: the price (₹2.50 per GB a month), the free allowance (2 GB),
  the limit presets, the link expiry options and the credit packs are open decisions
  (`BACKEND_PLAN.md` §13).
- **Not built yet.** Billing (Prompts 7–8) and share links (Prompt 9) are designed now so the web app has
  room for them. Their details can still move.
- **Fixed names.** The published delete-account page names the path **Settings → Account → Delete
  account** and the button **Delete**. The web app keeps them, so the page's steps work in both.
- **Where the web differs from the app** (the prompts already cover it):
  - uploads run only while the tab is open;
  - Play credits are bought only in the Android app;
  - bill alerts come by email, with no push notifications;
  - images and videos preview in the browser, and everything else downloads.

---

## Prompt 1 — Brief, design system, first screens

````text
You're designing the BenchBox web app: the browser version of BenchBox, whose Android app is already
designed in this same theme. Build it as an interactive, clickable prototype at desktop size
(1440 × 900) with a light/dark toggle, using static sample data. Also show how each screen adapts to a
laptop (1280), a small window (1024) and a phone's browser (390). This message is the full brief. Start
with the design system and the screens at the end. Later messages add the rest of the web app one area
at a time, so keep every round consistent with this brief. Name screens by round and number ("1.2 Files
— root, table view"). If something isn't covered here, make a sensible choice and list it under
"Assumptions" on the design system page.

# The product
BenchBox is pay-as-you-use cloud storage for India. People keep files and folders in the cloud, and
each month they pay only for the storage they actually kept, measured day by day.
- The first 2 GB are free.
- To store more, they set up auto-pay (UPI AutoPay, card or bank mandate) with a monthly limit they
  choose (₹100 by default). Android users can also buy Google Play credits in advance. Price: ₹2.50 per
  GB a month above the free 2 GB, plus 18% GST. (The price, the free 2 GB and the limit presets are
  placeholders: show them as examples.)
- The monthly limit caps what auto-pay charges, not what the user can owe. Reaching it only sends an
  alert, and uploads keep working. If a bill is above the limit, auto-pay charges the limit and the
  rest is paid by a payment link. Never imply "you'll never pay more than your limit".
- The web app never calculates money. It shows the amounts the server sends.
- Sign-in is Google only. The web app is a companion to the Android app: the same account, the same
  files, the same bill. Desktop first, but it must also work in a phone's browser.
- Who it's for: the same Indian, UPI-native, price-conscious users, at a laptop or an office computer.
  They move big folders off a computer, download files to work on, and check the bill on a bigger
  screen. English first; leave room for longer Hindi strings later.

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
grey-green accent, barely coloured, marks what can be clicked, what's selected and what's going well.
One muted brick red appears only when something needs the user's attention. There are no other colours:
the colour on screen should come from the user's own photos. Use the accent exactly as given; don't
drift towards teal, mint or any brighter green. Flat surfaces with hairline borders. No gradients,
glows or heavy shadows.

## Colour
Eleven tokens and nothing else, identical to the Android app. Don't add hues, tints or one-off colours.
| Token | Light | Dark | Used for |
|---|---|---|---|
| background | #F7F6F3 | #161918 | page background |
| surface | #FFFFFF | #1E2221 | cards, tables, panels, menus, dialogs |
| surface-muted | #EFEEEA | #262B2A | search field, chips, file-type tiles, hover rows, the empty part of meters |
| outline | #E3E1DC | #333938 | hairline borders, dividers, table rules |
| text | #1F2523 | #E8E9E6 | primary text and icons |
| text-muted | #646966 | #A3A8A5 | secondary text, metadata, placeholders, column headers |
| accent | #4A5A56 | #A7B5B1 | primary buttons, links, selection, folder icons, progress, meters, focus rings, success |
| accent-soft | #E2E8E6 | #283130 | selected rows, tonal buttons, drop targets, "Paid" chips (text on it uses accent) |
| danger | #8C5048 | #CC9E95 | over the limit, payment due or failed, destructive actions |
| danger-soft | #F4E9E6 | #332522 | attention banners (text on it uses danger) |
| on-fill | #FFFFFF | #161918 | text and icons on accent or danger fills |

Use them as CSS variables with the same names, the dark set applied when the system or the user picks
dark. Every text pair here meets WCAG AA; keep it that way. Underline links in running text, because
the accent sits close to the text colour.

## Type
Inter (it has the ₹ sign). Tabular figures for every number: sizes, amounts, percentages and dates in
tables.
| Style | Size / line | Weight | Used for |
|---|---|---|---|
| Display | 36 / 44 | SemiBold | the hero amount or size on Usage |
| Page title | 24 / 32 | SemiBold | page headings |
| Section | 18 / 24 | SemiBold | card and section titles |
| Body | 16 / 24 | Regular | prose, dialogs, sign-in |
| Table | 14 / 20 | Regular | file rows, metadata, helper text |
| Label | 14 / 20 | SemiBold | buttons, menu items, column headers |
| Caption | 12 / 16 | Medium | chips, meter labels, timestamps |

## Shape, space, icons, motion
- Corners: 12 px for cards, panels and dialogs; 8 px for buttons (not pills), inputs, menus and chips.
- A 4 px grid. 24 px page padding (16 px on phones), 24 px between sections. Table rows 48 px. Click
  targets at least 32 px on desktop and 44 px on touch screens.
- Elevation: flat. Hairline outlines instead of shadows. Only menus, dialogs, the uploads panel and
  toasts lift, with one soft shadow.
- Hover: a surface-muted background. Focus: a 2 px accent outline, 2 px away, on everything focusable.
- Icons: Material Symbols Rounded, 20 px in tables and menus, 24 px elsewhere. Folders use the accent.
  File types (image, video, audio, PDF, document, spreadsheet, presentation, archive, other) are
  text-muted glyphs on surface-muted tiles. Images and videos show their thumbnail when they have one.
- Motion: calm, 150–250 ms. Meters fill on load. No bounces, no confetti.
- Illustrations only on empty states: simple line drawings in text-muted, with at most one accent
  detail. Motifs: a tidy bench, labelled boxes, a luggage tag.

## The meters (the signature component, as in the app)
- Storage meter: storage used against the free allowance. Segments: files (accent), trash (accent at
  40%), uploading (accent outline). Label: "1.4 GB of 2 GB free used". At 90%: "Almost full". At 100%
  the bar turns danger: "Full. Uploads are paused."
- Bill meter: this month's amount so far (accent) against the monthly limit, which a tick marks. A
  segment of accent at 40% extends to the estimated month-end amount. If the estimate passes the
  limit, the part beyond the tick is danger at 40%. If the amount so far passes the limit, the bar
  rescales so the tick sits at 75%, and the excess is solid danger after a 2 px gap.
- Every state is also said in words, with an icon: "On track" (accent check), "Heads-up" (an info icon
  in the text colour, on a surface-muted callout), "Over your limit" (danger alert). Never colour alone.
- Both: an 8 px bar with 4 px corners, on surface-muted.

# Voice and words
- Plain, warm and direct. Sentence case. Contractions. No exclamation marks, no "please", no
  "successfully". Errors say what happened, then what to do.
- Money copy is exact: what will be charged, how, and when.
- Use these words, exactly as the app does: Files, Trash, Restore, Delete forever, Empty trash, Upload,
  Share link, Monthly limit (never "cap"), Auto-pay (never "mandate"), This month so far, Estimated
  bill, Statement, Free allowance, Play credits, Signed-in devices, This device.
- Formats: ₹ with Indian digit grouping (₹1,00,000.00), and amounts to the paisa on statements. Sizes in
  decimal units (1 GB = 1,000,000,000 bytes): "2.4 GB", "850 MB". Dates "23 Oct 2026", times "4:05 pm";
  tables say "Today", "Yesterday", "3 Oct".
- Sample data, the same as the app: the user is Asha Verma (asha.verma@gmail.com). Folders "Diwali
  2026", "College notes", "Documents", "Camera 2026". Files "Rent agreement.pdf" (2.1 MB), "Goa trip.mp4"
  (1.2 GB), "IMG_2041.jpg" (3.5 MB), "Trip budget.xlsx" (48 KB). Today is 23 Oct 2026. This browser is
  "Chrome on Windows".

# Platform
- A responsive web app for current Chrome, Edge, Safari and Firefox. Light and dark follow the system
  unless the user picks otherwise.
- Desktop conventions:
  - hover states;
  - right-click menus with the same actions as each row's ⋮ menu;
  - drag and drop: drop files and folders from the computer to upload them, and drag items onto a
    folder to move them;
  - multi-select with Ctrl/Cmd-click and Shift-click;
  - keyboard shortcuts, listed in a "?" help dialog.
- Fully usable from the keyboard, with visible focus, WCAG AA contrast, screen-reader labels on icon
  buttons, and no meaning carried by colour alone.
- In a phone's browser: one column, and the Android app's bottom navigation (Files, Usage, Settings).

# Layout and navigation
- A left sidebar, 240 px and collapsible:
  - the BenchBox wordmark;
  - a filled "Upload" button (its menu: Files, Folder), and "New folder";
  - Files, Shared links, Trash, Usage, Settings;
  - at its foot, a compact meter that opens Usage: "1.4 GB of 2 GB free", or, with auto-pay,
    "₹35.12 this month · limit ₹100".
- A top bar: a wide search field ("Search your files"; "/" focuses it), the uploads indicator while
  uploads run, and the account menu (photo, name, email, Settings, Sign out).
- Breadcrumbs above the file list ("Files › Diwali 2026"). Each crumb is also a drop target.
- When the account has a payment due or is suspended, a banner sits under the top bar on every page.
- The names Settings, Account and Delete account are fixed: a published page tells people to follow
  exactly that path.

# The whole web app (later messages design these)
1. Sign-in and the app gates (maintenance, a new version, offline, unsupported browsers).
2. Files: the table, selection, item menus, new folder, rename, move (including drag to move),
   details, search, keyboard shortcuts.
3. Uploads: picking and dropping files and folders, name clashes, the uploads panel, limits.
4. Preview and download.
5. Trash: restore, delete forever, empty trash, the 30-day rule.
6. Usage and bills: the Usage page in every state, daily usage, statements, how billing works.
7. More storage: auto-pay setup, the monthly limit, managing auto-pay.
8. Sharing: create a link, shared links, and the public page recipients open.
9. Settings: account, delete account, devices, notifications, appearance, legal.
10. System states: loading, empty, errors, toasts.
Don't add features that aren't on this list: no automatic photo backup, desktop sync client, favourites,
recent files, version history, comments, sharing with specific people, in-browser editing, previews of
PDFs or office files (those download), push notifications, ads, or a notification inbox.

# This round
1. A design system page: the colour tokens in light and dark, the type scale, and these components in
   all their states (default, hover, focus, active, disabled):
   - buttons (filled, tonal, outlined, text, destructive);
   - a text input and the search field;
   - the file table: a header with sort arrows, and rows for a folder, a file, a file with a
     thumbnail, hover, selected, focused, uploading, and drop target;
   - grid tiles;
   - sidebar items, the top bar and breadcrumbs;
   - a dropdown menu and a right-click menu;
   - dialog, toast, and banners (info, heads-up, attention);
   - the uploads panel and the drop-to-upload overlay;
   - both meters in every state;
   - tooltips, and the empty-state pattern.
2. Files, root, table view: the four folders and four files from the sample data, the sidebar and the
   top bar.
3. "Diwali 2026" in grid view: 24 photos and 2 videos, with thumbnails.
4. Usage on the free plan: the storage meter at 1.4 GB of 2 GB, the breakdown (files 1.2 GB, trash
   0.2 GB), the price in one line, and a "Get more storage" button.
Make the sidebar clickable between these.
````

---

## Prompt 2 — Sign-in and app gates

````text
Next round: sign-in and the app gates. Same brief and design system.

1. Sign-in page.
   - On a desktop, two halves. Left: the wordmark, one line ("Pay only for the storage you keep"), and
     three short points ("2 GB free", "Billed monthly for what you keep, measured daily", "A monthly
     limit you control"). Right: "Continue with Google" in Google's own web button style.
   - Under the button, the consent line: "By continuing you agree to our Terms & Conditions and Privacy
     Policy", both phrases linked.
   - A footer: Privacy Policy · Terms & Conditions · Contact support.
   - On a phone, one column.
2. Google's sign-in window. It's Google's UI: show it as a placeholder.
3. Signing in: a short progress state, then Files (an empty root for a new account).
4. Sign-in problems, under the button:
   - Not available yet (before launch): "Sign-in isn't available yet. Try again later."
   - Offline: "You're offline. Connect to sign in."
   - Pop-up blocked: "Your browser blocked Google's sign-in window. Allow pop-ups for BenchBox, then try
     again."
   - Too many tries: "Too many sign-in attempts. Try again in a minute."
   - Google account rejected: "That Google account can't be used. Try another one."
5. Signed out: when this browser was signed out from another device, or after 90 days unused, the user
   lands on sign-in with a note: "You were signed out in this browser. Sign in to continue."
6. Maintenance (a full page that blocks the app): the server's message, e.g. "BenchBox is down for
   maintenance until 2:00 pm. Your files are safe.", and "Try again".
7. A new version: a slim banner, "A new version of BenchBox is ready", with "Reload". (The web app has
   no forced-update screen: a reload always brings the latest version.)
8. Offline: a banner under the top bar, "You're offline. Reconnect to keep working." The web app needs
   a connection; actions that need one say so.
9. Unsupported browser: a plain page listing the supported browsers.

Done when: every page exists in light and dark, and sign-in is clickable from the sign-in page to Files.
````

---

## Prompt 3 — Files: browse and organise

````text
Next round: browsing and organising files. Same brief and design system.

1. A folder ("Documents") as a table.
   - Columns: Name (type icon and name), Size, Modified. Long names are shortened in the middle so the
     extension stays visible.
   - Clicking a column header sorts by it (name, last modified or size, up or down). Folders always
     come first.
   - A checkbox appears on hover and on selected rows. The footer counts the items ("1,284 items").
     Folders can hold thousands of items, so scrolling must stay smooth.
2. Selection.
   - Click selects; Ctrl/Cmd-click adds; Shift-click selects a range; Ctrl/Cmd+A selects all; Esc
     clears.
   - With a selection, a toolbar shows "3 selected" and its actions: Download (files only), Share link
     (one item), Move, Rename (one item), Details, and Move to trash.
3. Item menu: the ⋮ at the end of a row and a right-click both open Open, Download (files only), Share
   link, Rename, Move, Details, and Move to trash.
4. Opening: double-click or Enter opens a folder, or previews a file (next rounds).
5. New folder: a dialog with a name field. Errors under the field:
   - empty name;
   - too long (names are up to 255 bytes);
   - not allowed: "/", "\", control characters, or a name that is just "." or "..";
   - taken: "There's already a folder called 'Photos' here." Names are unique ignoring case. Offer
     "Keep both", which creates "Photos (1)".
6. Rename: inline in the row (F2), with the name before the extension selected. The same errors.
7. Move:
   - A dialog with a folder tree that starts in the current folder, plus "New folder" and "Move here".
     The item itself and its subfolders can't be chosen.
   - Or drag the selection onto a folder row, a breadcrumb, or "Files" in the sidebar. Valid targets
     highlight (accent-soft) while dragging.
   - After moving: a toast, "Moved to Documents", with "Undo".
8. Move to trash: the Delete key or the toolbar. A toast with "Undo". For a folder: "'Diwali 2026' and
   its 26 items moved to trash".
9. Details: a panel on the right with type, size, location, created and modified, and a larger
   thumbnail for images.
10. Search: from the top bar. The results page adds a Location column ("Documents › Bills") and
    highlights the match. Searching skips the trash. No results: "No files named 'xyz'".
11. Keyboard shortcuts, listed in a dialog that "?" opens:
    - "/" search
    - Enter open
    - Delete move to trash
    - F2 rename
    - Ctrl/Cmd+A select all
    - Esc clear the selection
    - Shift+N new folder
    - U upload
12. Changed elsewhere: when a rename or move meets a change made in another window or on another
    device, ask. "'Report.pdf' was renamed to 'Report final.pdf' elsewhere." Buttons "Keep 'Report
    final.pdf'" and "Use 'Report v2.pdf'".
13. Empty states:
    - a new account's root: "Your files live here", with "Upload" and "or drop files anywhere";
    - an empty folder.
14. Errors:
    - "That folder isn't there any more. It was moved or deleted on another device."
    - "This item is in the trash. Restore it first."

Done when: every action works from the toolbar, the ⋮ menu and right-click, and drag-to-move is shown
with its highlighted targets.
````

---

## Prompt 4 — Uploads

````text
Next round: uploads. Same brief and design system.

1. Starting an upload, three ways:
   - the Upload button's menu: Files, or Folder (a folder upload recreates its folders);
   - the browser's file picker (show a placeholder);
   - dragging files and folders from the computer anywhere onto the page, which shows a full-window
     overlay: "Drop to upload to Diwali 2026".
2. Too big: files over 10 GB are left out, and the rest still upload. "'Movie.mkv' is 12.4 GB. Files can
   be up to 10 GB."
3. Name clash, checked before any bytes move: "'IMG_2041.jpg' is already in this folder." A dialog with:
   - Replace: "The existing file is replaced. Its old version can't be recovered."
   - Keep both: the new file becomes "IMG_2041 (1).jpg".
   - Skip.
   Add a checkbox, "Do this for all 5 clashes". If a clash appears only at the end of an upload, ask the
   same question then: nothing is lost.
4. In the folder: files being uploaded appear at the top of the table with a progress ring, until they
   land.
5. The uploads panel: floating at the bottom right, and collapsible.
   - Its header: "Uploading 3 files · 42% · about 2 min left", with minimise and close.
   - Each row: a thumbnail or type icon, the name, the destination ("to Diwali 2026"), a progress bar
     with "504 MB of 1.2 GB", and its state:
     - Waiting
     - Uploading 42%
     - Waiting for a connection (resumes by itself)
     - Finishing
     - Uploaded
     - Failed, with the reason and "Retry"
     - Cancelled
   - Row actions: Cancel and Retry. Panel actions: "Cancel all" and "Clear finished".
6. Leaving the page: uploads run only while BenchBox is open in the tab.
   - Closing or reloading the tab asks first, with the browser's own "Leave site?" prompt (show a
     placeholder).
   - After a reload, an unfinished upload shows "Interrupted. Choose 'Goa trip.mp4' again to continue
     from 42%", with "Choose file". Parts already sent aren't sent again.
7. Not enough space: a dialog, "Not enough space. 'Goa trip.mp4' needs 1.2 GB, and you have 0.6 GB
   left." Actions: "Get more storage" and "Free up space" (opens Trash).
8. Over 50 uploads at once: the rest wait their turn with no error ("Waiting").
9. Storage service unreachable: affected rows show "Can't reach storage. Retrying…", then "Failed" with
   "Retry".
10. Uploads switched off by the server: the upload buttons and the drop overlay are hidden. The panel
    says "Uploads are paused for now. Uploads already under way will finish."
11. Payment due or account suspended: "Uploads are paused until your payment of ₹31.00 is made", with
    "Pay now".
12. Spending note (once billing is live). When new uploads push the estimated bill past the monthly
    limit, inform; never block or ask before uploading. "These uploads bring your estimated bill to
    ₹112, above your ₹100 limit. Auto-pay charges up to ₹100; we'll send a link for the rest." Action
    "Raise limit".

Done when: dragging files in through to a finished upload is clickable, and every state appears in the
uploads panel.
````

---

## Prompt 5 — Preview and download

````text
Next round: previewing and downloading. Same brief and design system.

1. Preview, for images and videos: a full-window viewer on a dark background in both themes.
   - Arrow keys, or arrows on screen, move through the folder's photos and videos.
   - Images zoom.
   - Videos play while they stream, so they can seek before fully loading.
   - The top bar has the name, then Download, Share link, Details, Move to trash, and Close (Esc).
2. Other files (PDFs, documents, archives) don't preview: opening one downloads it.
3. Download:
   - It uses the browser's own download (show a placeholder), with a toast: "Downloading 'Rent
     agreement.pdf'".
   - Several selected files download one by one. The browser may ask to allow multiple downloads (its
     own prompt).
   - Folders can't be downloaded.
4. No thumbnail yet: show the file type's tile.
5. Errors: "Couldn't open the file. Try again." Offline: "Connect to open 'Goa trip.mp4'."

Done when: a photo and a video open from "Diwali 2026", and a PDF downloads from "Documents".
````

---

## Prompt 6 — Trash

````text
Next round: the trash. Same brief and design system.

1. Trash (in the sidebar):
   - A header card: "Files in the trash still count towards your storage until they're deleted
     forever.", with the size (1.2 GB) and "Empty trash".
   - A line under it: "Items are deleted forever after 30 days."
2. A table of what the user trashed, most recent first. Columns: Name, From ("Documents"), Deleted
   ("3 days ago"), and Deletes in ("27 days"; text-muted, danger only on the last day).
3. With a selection, the toolbar offers Restore, Delete forever and Details. So do the ⋮ menu and
   right-click.
4. A trashed folder can be opened and browsed, read-only. Its contents can't be restored on their own:
   "Restore 'Diwali 2026' to get this back", with "Restore folder".
5. After restoring, a toast:
   - normally: "Restored to Documents", with "Show";
   - when its folder is gone: "Restored to Files. Its folder isn't there any more.";
   - when the name was taken: "Restored as 'Report (1).pdf'".
6. Delete forever: a confirmation. "Delete 'Goa trip.mp4' forever? This frees 1.2 GB and can't be
   undone." For a folder, add "and the 26 items in it". Buttons "Delete forever" (danger) and "Cancel".
7. Empty trash: a confirmation. "Empty the trash? 14 items (1.2 GB) will be deleted forever. This can't
   be undone."
8. Files in the trash can still be previewed and downloaded.
9. Empty: "The trash is empty", with "Things you delete stay here for 30 days."

Done when: restore, delete forever and empty trash are each clickable with their confirmations.
````

---

## Prompt 7 — Usage and bills

````text
Next round: the Usage page and bills, the most important pages for trust. Same brief and design system.
Amounts stand out by size, not colour. The danger colour appears only when the user owes something or
is over the limit.

Lay the page out for a wide screen:
1. The standing banner, when it applies.
2. A hero card across the top.
   - On the free plan: storage ("1.4 GB of 2 GB free").
   - With auto-pay: money. "₹35.12 · This month so far", "Estimated bill ₹48.38 by 31 Oct", the bill
     meter against "Limit ₹100", and a status line.
3. Side by side:
   - Storage: the storage meter and the breakdown (Files, Trash, Uploading), with "Manage trash".
   - Paying: "Auto-pay · UPI · ashav•••@okhdfc", "Monthly limit ₹100" with "Change", and "Next charge:
     around 2 Nov, for October's bill". Play credits: the balance ("₹0 · used before auto-pay" in these
     samples, except state I), with "Buy credits in the BenchBox Android app". The web can't sell
     them: they're bought through Google Play.
4. This month: daily usage, full width.
5. Statements, as a table.
6. "How billing works", the price line ("₹2.50 per GB a month above your free 2 GB, plus GST"), and
   links to the Terms and the Privacy Policy.

Design each of these states as its own page:
A. Free plan: 1.4 GB of 2 GB.
B. Free plan, almost full (1.9 GB), and full (2 GB, uploads paused), each with "Get more storage".
C. Auto-pay, on track: 18.4 GB stored; ₹35.12 so far; estimated ₹48.38; limit ₹100.
D. Heads-up: ₹84.10 so far (84% of the limit), estimated ₹131. "Your estimated bill is above your
   ₹100 limit. Auto-pay will charge ₹100, and we'll send a link for the rest." Actions "Raise limit"
   and "Free up space".
E. Over the limit: ₹112.40 so far. "You've passed your ₹100 limit. Uploads keep working."
F. Payment due. A danger banner on every page: "Payment due: ₹31.00 by 9 Nov. Uploads are paused until
   it's paid.", with "Pay now" (opens a payment page in a new tab). Downloads and share links still
   work.
G. Suspended. "Your account is suspended and your share links are off. Pay ₹31.00 to restore it.",
   with "Pay now". Then the warning: "Your files will be deleted on 24 Dec unless the bill is paid."
H. Paid again: "Payment received. Uploads are back on."
I. Play credits only, no auto-pay: the bill meter measures against the credit balance (₹150) instead of
   a limit. When the estimate is above the balance: "Your credits won't cover this month. Set up
   auto-pay, or buy credits in the BenchBox Android app."

Daily usage: a bar per day of the month. The height is the GB stored that day, with the free 2 GB drawn
as a line. Hovering a bar shows "12 Oct · 18.2 GB · ₹1.47". Today's bar is lighter, because the day
isn't over.

Statements table. Columns: Month, Total, Status, Paid on, Invoice (download). Status chips:
- Paid (accent-soft)
- Due (danger-soft)
- Failed (danger-soft)
- Paid with credits (surface-muted)
- Carried forward (surface-muted, text-muted): "Under ₹10, so it moves to next month."
Sample:
- September 2026: ₹43.27, Paid
- August 2026: ₹18.54, Paid (it includes ₹6.20 carried in)
- July 2026: ₹6.20, Carried forward

Statement detail (September 2026), as a page:
| Line | Amount |
|---|---|
| Storage | 500 GB-days |
| Free allowance | −60 GB-days |
| Billable | 440 GB-days = 14.67 GB-months |
| Storage at ₹2.50 per GB a month | ₹36.67 |
| GST 18% | ₹6.60 (shown as CGST 9% + SGST 9% when the user's state calls for it) |
| Total | ₹43.27 |
Then: "Paid by auto-pay on 2 Oct", "Download invoice", and "How it's calculated".

How billing works, one page built on the same example:
- 10 GB kept for 20 days, then 30 GB for 10 days: 500 GB-days.
- The free 2 GB covers 60 GB-days, leaving 440, about 14.67 GB-months.
- At ₹2.50 that's ₹36.67, plus GST of ₹6.60: ₹43.27.
Then:
- Files in the trash count until they're deleted forever. Thumbnails and unfinished uploads don't count.
- Downloads are free.
- Bills close on the 1st of each month, India time.
- Amounts under ₹10 move to the next month.
- Prices change only with 30 days' notice.
- Bill alerts come by email, and as notifications in the Android app.

Done when: states A–I exist in light and dark, and Usage links to the statements, statement detail and
the explainer.
````

---

## Prompt 8 — More storage: auto-pay and the monthly limit

````text
Next round: getting more storage on the web. Same brief and design system. Link the Terms and the
Privacy Policy on every page of this flow.

1. Get more storage.
   - Auto-pay, the way to pay on the web: "Pay each month for what you keep, up to a limit you set."
   - A note: "Prefer to pay in advance? Buy Play credits in the BenchBox Android app."
   - The price, then "Continue".
2. Auto-pay setup, as a stepper on one page:
   1. Monthly limit: ₹100 (default), ₹250, ₹500, ₹1,000, or a custom amount. Under it: "Auto-pay charges
      your actual bill each month, up to this limit. We alert you at 80% and 100%. If a bill is higher,
      auto-pay charges the limit and we send a payment link for the rest, due in 7 days." Plus an
      estimate: "At your current 18.4 GB, a month costs about ₹48."
   2. Your state: a searchable list of Indian states and union territories, explained: "We need this for
      GST."
   3. How to pay: UPI AutoPay (recommended), Debit or credit card, or Bank account.
   4. Review: the limit, the method and the state. "Your bank or UPI app tells you before each charge."
      Then "Set up auto-pay".
3. "Set up auto-pay" opens the payment provider's page in a new tab. On a computer, the user approves
   UPI AutoPay by scanning a QR code with their phone's UPI app. It's external: show a placeholder.
4. Back in BenchBox:
   - "Confirming with your bank…" (it can take a few minutes, and the user can leave the page);
   - then "Auto-pay is on" (limit ₹100, UPI), returning to Usage;
   - or "Auto-pay wasn't set up. Nothing was charged.", with "Try again";
   - or, if it's slow: "We'll email you when your bank confirms."
   Note: "If your bank takes a small payment to set this up, it's added to your balance."
5. Manage auto-pay (from Usage): the method, the limit and the status.
   - "Change limit" uses the same chooser, with "Your current limit stays on until the new one is
     confirmed."
   - "Change payment method".
   - "Turn off auto-pay", with a confirmation: "Turn off auto-pay? You'll be back to the free 2 GB and
     can't upload beyond it. What you already owe is still due." Buttons "Turn off" (danger) and "Keep
     auto-pay".
6. Auto-pay turned off from the UPI app: a banner, "Auto-pay is off. Set it up again to store more than
   2 GB."
7. Before paid storage launches: "Get more storage" shows "More storage is coming soon."

Done when: auto-pay setup is clickable from Usage to "Auto-pay is on".
````

---

## Prompt 9 — Share links and the public page

````text
Next round: share links. Same brief and design system.

1. Create (toolbar, ⋮ menu or right-click → Share link): a dialog with the item. "Anyone with the link
   can view it."
   - A toggle: "Allow downloads".
   - Expiry chips: 1 day, 7 days (default) and 30 days (placeholders).
   - "Create link". The link then appears in a field (benchbox.ferbotz.com/s/…) with "Copy" and
     "Expires 30 Oct".
   - If the item already has links, list them above, each with Copy and Revoke.
2. Shared links (in the sidebar): a table of every link the user made. Columns: Item, Created, Status
   ("Expires in 5 days", "Expired", "Revoked" or "Turned off by BenchBox"), and Downloads (allowed or
   off). Actions: Copy and Revoke. Revoke asks first: "Revoke this link? Anyone who has it won't be able
   to open it."
3. Suspended account: a banner, "Share links are off while your account is suspended."
4. The public page that recipients open: no sign-in, the same Workbench look, at desktop and phone
   sizes.
   - A file: its preview (image or video) or type tile, the name, the size, and "Download" when allowed.
   - A folder: its items with sizes. Click one to preview or download it.
   - Never show the owner's name or email.
   - Footer: "Report this link" (a short form: a reason and optional details) and "Get BenchBox".
   - States: "This link has expired", "This link isn't available", and "Too many visits. Try again in a
     few minutes."

Done when: creating, copying and revoking a link are clickable, and the public page exists for a file
and a folder at desktop and phone sizes.
````

---

## Prompt 10 — Settings, account and devices

````text
Next round: Settings. Same brief and design system. Keep the names Settings, Account, Delete account
and the button Delete exactly: a published page tells people to follow that path.

1. Settings: a page with its own sub-menu: Account, Signed-in devices, Notifications, Appearance, Help
   and support, Privacy Policy, Terms & Conditions, and About (version and open-source licences).
   Privacy Policy and Terms open in a new tab.
2. Account: photo, name, email, and "Signed in with Google". Then:
   - "Sign out", which confirms: "Sign out of BenchBox in this browser? Uploads in progress will stop."
   - "Delete account", in the danger colour.
3. Delete account, a confirmation page titled "Delete account":
   - A warning card: "Download anything you want to keep first."
   - What happens: all files and folders are deleted, including the trash; share links stop working;
     auto-pay is cancelled after a final bill for this month's storage; unused Play credits are lost;
     every device is signed out.
   - "This can't be undone."
   - A link: "What's deleted and what's kept" (the web page).
   - Buttons "Delete" (danger, filled) and "Cancel".
   - Then "Confirm it's you": Google's sign-in window (a placeholder).
   - Then "Deleting your account…", and a final page, "Your account is deleted", with "Done", which
     returns to the sign-in page.
   - Errors:
     - The user picked another Google account: "Choose asha.verma@gmail.com, the Google account you use
       with BenchBox.", with "Try again".
     - It took too long: "That took too long. Confirm it's you again."
4. Signed-in devices: a table, most recently used first. Columns: Device ("Chrome on Windows", "Pixel
   8"), Where ("Web" or "Android · BenchBox 0.1.0"), and Last used ("Active now", "3 days ago"). "This
   device" is a chip on the current browser.
   - Each row has "Sign out".
   - "Sign out all other devices" confirms first: "Sign out 2 other devices? They'll need to sign in
     again." Then a toast: "Signed out 2 devices".
   - A note: "Devices unused for 90 days are signed out automatically."
   Sample: Chrome on Windows (this device), Pixel 8 (3 days ago), Galaxy Tab S9 (12 Oct).
5. Notifications: "Bill alerts come by email to asha.verma@gmail.com, and as notifications in the
   BenchBox Android app." List them:
   - Usage alerts: at 80% and 100% of your monthly limit, and when your estimated bill is above it.
   - Bills and payments: bill ready, payment received, payment failed.
6. Appearance: System default, Light, Dark.
7. Help and support: "Contact support" opens an email to support@ferbotz.com.

Done when: the full delete-account path is clickable, Settings → Account → Delete account → Delete →
Google → deleted, and every Settings section exists.
````

---

## Prompt 11 — System states

````text
Last design round: the states between pages. Same brief and design system.

1. Loading: skeleton rows for tables, and a skeleton for Usage.
2. Empty states, using the illustration pattern: no search results, no shared links, and no statements
   yet ("Your first statement arrives on 1 Nov").
3. Errors:
   - generic: "Something went wrong. Try again.";
   - too many requests: "Too many requests. Try again in 30 seconds.";
   - storage unreachable: "Can't reach storage right now. Try again in a moment.";
   - an item deleted elsewhere: "This file isn't there any more.";
   - an address that doesn't exist: a page, "This page doesn't exist", with "Go to Files".
4. Offline: the banner on every page. Actions that need a connection say so.
5. Toasts: every success and undo toast from the earlier rounds, together on one page.
6. A screen index page listing every page in the prototype by name, grouped by round.

Done when: every state exists in light and dark, and the index lists every page.
````

---

## Prompt 12 — Handoff

````text
Write the handoff for the web developers:
1. The colour tokens as CSS variables: name, light and dark values.
2. The type scale, spacing, shape values and the breakpoints (1440, 1280, 1024, 390).
3. Every component with its states (default, hover, focus, active, disabled) and where it's used.
4. Every page by name, grouped by area, with a suggested route (for example /files/:folderId, /trash,
   /usage, /settings/account): what it shows, and where each action leads.
5. Every user-facing string, including errors, grouped by page.
6. The keyboard shortcuts and drag-and-drop behaviours.
7. Every assumption you made that isn't in the brief, so we can confirm or change it.
````
