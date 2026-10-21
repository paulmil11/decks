# Changelog

What changed in each version of Decks. To update, run `git pull` in your Decks folder, then
restart the server. To hear about new versions, watch this repository on GitHub
(Watch › Custom › Releases).

## Unreleased

- Screen recordings of an open deck no longer blink every few seconds when the deck sits idle.
- `sb shot`, `sb audit`, `sb export`, Download PDF, and dashboard thumbnails share one headless
  Chrome instead of starting their own each time, which takes about half a second off each one.
  A private worker keeps Chrome open and quits after two idle minutes; `SB_BROWSER_WORKER=0`
  turns it off. Thanks to @delirious6423, whose pull request designed the worker.

## 0.9.0 (October 20, 2026)

- **Proposed slides you can accept or keep.** When Claude suggests a new version of one of
  your slides, **Proposed** in the slide list takes you through them one at a time. Space flips
  between the proposal and your original; A accepts it, K keeps your original, and U undoes.
  A slide can have several options: Space flips through them, and accepting one drops the rest.
  Your choices apply at once, and `sb proposals <deck> --bake` writes them into the deck file at
  the next round.
- **What changed, round by round.** View › What changed lists each round's slides and what
  changed on each, and a slide's notes panel lists every round that changed it.
- **Download PDF** in Share makes the PDF on your machine: one landscape 16:9 page per slide,
  as the deck looks now. The print window could turn every slide sideways onto portrait paper.
  Print is still there, for paper.
- **A new logo**, StrategyU Decks, in the top bar, on the dashboard, and as the tab icon.
- **A faster dashboard.** It no longer downloads its thumbnails again every few seconds or waits
  on git, and tabs in the background stop checking in until you come back to them.
- **Dark decks:** the comment box, a slide's ↑ ↓ × buttons, and the slide number keep readable
  colors, whatever text color the deck's theme sets.
- **Imported slides** keep their titles' alignment and their tables' text size.

## 0.8.0 (October 20, 2026)

- **Import a deck**, in New deck, brings in a deck you already have: a PowerPoint file (.pptx)
  or a PDF. From Keynote or Google Slides, export to PowerPoint first. Choose the file or paste
  its path, then pick how it comes in. **Keep its look** converts every slide as it is, so every
  word on it can be edited, with its speaker notes. **Rebuild it in Decks' layouts** keeps your
  slides, words, and notes and lays them out in Decks' own layouts and colors. The deck keeps
  the file in `source/`, and `BRIEF.md` has the steps for your agent. Paste the prompt it
  copies into Claude Code or Codex.
- `tools/importdeck.py` does the converting. It writes each slide's title and speaker notes
  into the deck, turns PowerPoint sections into parts, puts hidden slides on the shelf, and
  gives each slide a picture of the original to compare with. A PDF on its own keeps its look
  too: each page's words come back as text you can edit. For a rebuild, `--outline` lists every
  slide's words, tables, chart numbers, and notes.
- The PowerPoint converter (`tools/pptx2native.py`) handles more decks: slides of any size
  (Google Slides' 10-inch slides, older 4:3 decks), photo and gradient backgrounds, logos and
  graphics on the slide layout and master, gradient fills with transparency, oval speech
  bubbles, and the deck's own fonts where your machine has them.
- `sb new "<name>" --from <file>` imports from the command line (`--rebuild` for a rebuild).
  It's separate from `sb import`, which brings a reviewer's returned file back in.
- `sb audit` no longer reports a cropped picture as running off the slide or cutting off text.
- New deck shows its three steps at the top (what you're making, who it's for, how it looks),
  and each Next button names the next step. A step you've been to is a link back to it.

## 0.7.4 (October 20, 2026)

- When a new version is out, **Copy update prompt** puts a prompt on your clipboard for Claude
  Code or Codex. It names your Decks folder and port, pulls the new version (and stops to show
  you any local changes first), restarts the server, and checks the version in the footer. The
  button is on the dashboard's new-version note; in a deck, the first row of `?` copies it.

## 0.7.3 (October 20, 2026)

- The consulting template's 2x2 asks for your raw data. Paste each option's name and its score
  on both axes in the comment under the slide (or the path to a spreadsheet that has them), and
  Claude renames the dots and moves each one to where its numbers put it. The decks skill says
  how to place them, so the agent works from the numbers instead of by eye.

## 0.7.2 (October 20, 2026)

- New deck has three steps: what you're making, who it's for, and how it looks. The new third
  step shows a sample slide in each color set, titled with your deck's name, in the title font
  you pick. Upload your logo and it shows on the samples too. Without one, slides have no logo.
- The dashboard shows the version next to the name. Click it for what changed.

## 0.7.1 (October 20, 2026)

- **Check for updates**, in the dashboard footer and under `?` in a deck, asks GitHub right
  away whether a newer Decks is out. It says you're up to date, or which version is out and how
  to update, or that GitHub couldn't be reached.
- New versions show up sooner. The server checks every six hours instead of once a day, and a
  check that fails (offline, or Decks started at login before the network was up) is tried
  again ten minutes later instead of the next day. It goes by the clock, so a laptop that was
  asleep checks soon after it wakes.
- When a new version is out, `?` in a deck gets a dot, and its menu starts with the new version
  and how to update. Before, only the dashboard said so.

## 0.7.0 (October 20, 2026)

A tidier top bar. Everything is still there, in fewer places:

- The deck's name and version are one control: click it to switch versions.
- **View** holds Titles only (H) and on/off switches for the slide list ([), the notes panel
  (]), and facilitator notes.
- **Share** holds Save as PDF and the three copies: Client copy, Review copy, and Editable copy.
- **Present** starts from the slide you're on (⌘↵), or opens presenter view.
- **Ask Claude** is the one red button, with its shortcut on it.
- **?** holds How this works, the keyboard shortcuts, the plain deck file, Send feedback, and
  Made by StrategyU.
- The ⋯ menu and Copy edits are gone. New slide is a plain button.

## 0.6.2 (October 20, 2026)

- The Ask Claude shortcut is ⌘⇧↵ (Ctrl+Shift+Enter). ⌘↵ is the deck's own Present shortcut,
  so it stays that.

## 0.6.1 (October 20, 2026)

- The Ask Claude shortcut is now ⌘↵ (Ctrl+Enter on Windows and Linux) instead of A. It works
  while you're typing a comment, so you can finish the comment and send it in one go.

## 0.6.0 (October 20, 2026)

- Watch mode watches every deck: say "watch my decks", and a Process now click in any deck
  starts its round. `sb watch` with no deck name does this; `sb watch <deck>` still watches one.
- The Review copy is simpler for the person reviewing it: the deck's logo and name, two lines
  of instructions, **Save a copy with my edits** as the main button, and **Print slides as PDF
  (without comments)**. The version picker, slide list, and Revert are gone.
- Ask Claude (and Process now) shows its shortcut, A, on the button.
- How this works closes with ×, a click anywhere else, or Esc.

## 0.5.0 (October 20, 2026)

- **Review copy** in the ⋯ menu: a file for someone outside to comment on and edit, then send
  back. It holds the version on screen, without your notes, your comments, facilitator
  slides, or other versions.
- **`sb import <deck> <file.html>`** brings the returned file into the deck: their comments
  merge in slide by slide, and their edits come in where they made them. `--dry-run` shows
  what would change first.
- The Editable copy keeps the deck's file name instead of always saving as `workshop.html`.
- **A** is the shortcut for Ask Claude (and for Process now in watch mode).

## 0.4.0 (October 20, 2026)

- **Watch mode.** Say "watch my decks" once in Claude Code. In the deck, Ask Claude turns into
  **Process now**, and each click starts a round in that chat without typing anything. A click
  while Claude is busy is queued. Behind it is a new command, `sb watch <deck>`.
- The server accepts changes only from its own pages. Before, another website you visited could
  have sent requests to it (depending on your browser).
- **Send feedback** on the dashboard and in each deck's ⋯ menu opens an email to Paul at
  paul@strategyu.co (and copies the address, in case your mail app doesn't open).

## 0.3.0 (October 19, 2026)

- The dashboard tells you when a new version is out, with a link to what's new. Once a day the
  server asks GitHub which release is newest (one small request; nothing about your decks is
  sent). Hide the notice until the next version with ×, or turn the check off with
  `"check_updates": false` in `config.json` or `SB_CHECK_UPDATES=0`.

## 0.2.0 (October 19, 2026)

**Checks**

- Vertical flow and Titles only find a slide's title wherever its layout puts it, including
  inside a column or a panel. Before, a custom layout could hide its own title along with
  the body. Thanks to William Fitzpatrick for reporting it.
- **Help me choose** asks what you want to know and opens the check that answers it, with
  an order for going through a whole deck.
- You can comment without leaving Checks: the comment box stays under the slide, except
  during the timed tests.
- Guides: **Ask Claude to fix** turns what a slide breaks into a comment for the next round,
  and **Comment on all** does it for every flagged slide.

**Reviewing**

- Each slide keeps its history in the side panel: every comment, the agent's reply, and how
  it ended.
- The Changed badge sits above the slide instead of covering the title.

**The agent**

- The bundled skill carries the StrategyU method: answer first, ghost deck first, action
  titles, vertical and horizontal flow, the five- and ten-second tests, "so what?", charts
  that prove the title, and how to give feedback on a deck.
- Custom layouts should give their titles the class `h-title`, so every check finds them.

**Other**

- The dashboard footer shows the version you're running, with a link to this file.
- The dashboard links to StrategyU and to the free consulting PowerPoint templates the
  consulting template is built from.
- The README explains why I built this, the setup I use, and the method, with screenshots.

## 0.1.0 (October 18, 2026)

The first public release.

- Comment under a slide, or edit its text, and your agent (Claude Code or Codex) changes the
  deck and replies on the slide.
- Four views (Focus, Scroll, Sorter, and Checks) and five checks: the five- and ten-second
  tests, horizontal flow, vertical flow, and Guides.
- Templates for a consulting storyline, a talk, a workshop, a proposal, and a blank deck,
  with six color themes and your own logo.
- Add a slide with Help me choose, basic layouts, and picture layouts.
- **Client copy** sends one file with only the slides. `sb export` makes PDFs.
- Saves merge across tabs and survive a dropped connection.
- Hide or delete decks from the dashboard.
- Code under MIT, templates under CC BY 4.0.
