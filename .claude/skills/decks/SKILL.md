---
name: decks
description: Run feedback rounds and build slides in Decks, HTML slide decks reviewed in the browser at http://localhost:8790 (or the configured port). Use when the user says "process changes", "read my feedback", "check my comments", pastes an "Ask Claude" prompt from a deck, asks to find, open, or export a deck, or wants a new deck built or an existing PowerPoint or PDF imported. Covers the round procedure, the sb command line, the deck file, slide style rules, and the StrategyU slide method it applies to every slide (action titles, vertical and horizontal flow, the five- and ten-second tests, charts that prove the title).
---

# Decks

The user reviews a deck in the browser. They type a comment under a slide (or edit text right on it), then say "process changes" or click **Ask Claude** in the deck, which copies a prompt naming the deck file and the `sb` steps below; treat that prompt as "process changes" for that deck. You act on every comment, reply on the slide itself, check your work, and export. Keep the chat summary short: the replies on the slides carry the detail.

## Where things are

- The app folder is the Decks repository: the folder this skill ships in (`.claude/skills/decks/` inside it), or, for a copy of this skill in `~/.claude/skills/`, wherever the user cloned it. The Ask Claude prompt names it. It has `server.py`, the `sb` command line, the browser shell in `static/`, templates in `templates/`, and headless tools in `tools/`. Run `sb` from there: `./sb ...`.
- The server: `python3 server.py`, at http://localhost:8790/ unless `config.json` or `SB_PORT` says otherwise. If `sb` says the server is not reachable, start it (in the background) and try again. `sb` finds it at `SB_URL`, or at the configured port.
- Decks live in the decks folder (default `~/slide-decks`), one folder per deck, listed in `decks.json` there. `./sb decks` lists them with their addresses.
- Open a deck at `http://localhost:<port>/d/<slug>/<entry>`. `#s=<slide-id>` jumps to a slide, and `#v=<version>&s=<id>` picks a version.
- Saved state lives next to each deck in `.slidebuilder/`:
  - `state.json`: the reviewer's edits, comments, and slide order, mirrored from the page. Never write to it by hand.
  - `review.json`: your replies, rounds, and changed badges. Write it through `sb`.
- Every deck folder is a git repo. PDFs, zips, and PPTX files are ignored.

## The page

- Four views: Focus (F), Scroll (S), Sorter (G), and Checks (C). The filmstrip on the left reorders by drag.
  - In Focus and Scroll, the comment box sits under each slide, with your reply below it. The right bar holds the slide's notes and what changed.
  - Checks has five checks, keys 1 to 5: the 5-second test (first impression), the 10-second test (legibility; a miss leaves a comment on the slide for the next round), horizontal flow (the titles alone, editable in place), vertical flow (the title first, the body hidden until revealed), and Guides.
  - Comments can come from Checks: "Five-second test: …" and "Ten-second test: …" after a missed timed test, and "Guides: …" from Ask Claude to fix in Checks › Guides, naming what the slide breaks. Fix the slide so it passes, like any comment.
  - H hides everything but the titles. ? lists every shortcut.
  - **Proposed slides** (see Proposing a slide): a slide you proposed shows Accept and Keep original under it, and Original | Proposed above it (Space flips; the right bar shows the original too). With several options for one slide it reads Original | Option 1 | 2 | 3, Space flips through them, and A accepts the one on screen. The Proposed filter goes through the undecided slides; A accepts, K keeps the original, U undoes. A decision changes the version on screen at once (Accept takes the original out, Keep takes the proposal out) and is saved in `review.json`. You write it into the deck file at the next round with `sb proposals --bake`.
  - **View › What changed, round by round**: each round's summary, the proposals accepted or kept in it, and its commit, with decisions still waiting for a round at the top.
- **Add a slide** (N, "+ Slide", or the + between slides) suggests layouts and can add one the deck carries. Its Copy prompt gives you the deck file, the position, and what the slide should say. When a prompt says "I just added a … slide (LIBRARY['id'])", fill that slide in; when it says "add a new slide …", build it in the deck file at that position.
- When the reviewer edits a title in Checks, that is an inline edit: bake it like any other.
- **Hide client work** (a dashboard switch, `settings.json` in the decks folder) is for recording or screen sharing. With it on, the server leaves out decks marked `client` and versions listed in `clientVersions`. Never show client names on screen when it is on.

## A round ("process changes")

1. `cd` to the app folder.
2. `./sb comments <deck>` lists the comments to act on, numbered like the deck. Drafts are skipped. `./sb edits <deck>` shows the reviewer's inline text edits and slide moves. Both read from disk, so you don't need their browser tab. When the deck has proposed slides, `sb comments` starts with how many are decided and how many still wait; `./sb proposals <deck>` lists each one.
3. `./sb status <deck> "Reading your 9 comments" --done 0 --total 9`. The reviewer sees this live in the top bar. Update it as you go.
4. For each comment:
   - `./sb working <deck> <slide>`.
   - Make the change in the deck file.
   - `./sb reply <deck> <slide> done "one plain sentence on what changed"`.
   - If you need the reviewer's call, use `question` instead of `done`. For something you deliberately left alone, use `skipped` and say why.
   - A half-typed comment gets a `question` reply, not a guess.
5. Bake the decisions on proposed slides: `./sb proposals <deck> --bake` (see Proposing a slide). Then bake the reviewer's inline edits into the deck file (their edit wins). Git has the old version. `sb edits` marks the slides that left a version because of a proposal decision: the bake handles those, so don't move them by hand.
6. Check every slide you touched:
   - `./sb shot <deck> <ids…>`, then look at each image.
   - `./sb audit <deck>` finds overflow, overlapping labels, and anything the Guides flag.
   - `./sb comments <deck>` should show nothing new and unhandled.
7. Finish:
   - `./sb export <deck>` writes the next numbered PDF from the deck file and moves older ones to `_archive/`. If the browser still holds edits that aren't baked in, it says so: bake them first. `--with-edits` exports exactly what the browser shows instead.
   - `./sb round <deck> --summary "…" --changed id="what changed" … --export vN`. It records the proposal decisions you baked since the last round, and keeps each `--changed` note with the round, so View › What changed shows what changed on each slide in every round (and the slide's right bar lists its changes over time): write each note as one plain sentence on what changed. `sb commit` adds the commit to the same record.
   - `./sb commit <deck> "Round N: …"`.
   - `./sb idle <deck>`.
   - Tell the user where the PDF is.
8. The page reloads itself once the reviewer stops typing. Don't reload or clear their tab. In chat: a few lines, plus anything that needs their decision, including how many proposed slides still wait for them.

New comments can arrive while you work. Run `./sb comments` again before finishing.

The reviewer clears handled comments with "Looks good". Don't add them to `DONE_FB`; that list is only for copies opened outside Decks, such as a file sent to someone else.

**A reviewer sent the file back.** Someone opened a Review copy (or an Editable copy), commented and edited, clicked "Save a copy with my edits", and returned the file. Run `./sb import <deck> <file.html>`, then process changes as usual: their comments show up in `sb comments` and their text edits in `sb edits`.
- It prints what came in: each version, its comments, and the slides whose text changed. Run it with `--dry-run` first to see that without changing anything.
- Comments merge slide by slide. A comment already on the slide stays and the reviewer's goes under it; comments already handled don't come back.
- Text and slide order: the file wins where it changed them, and the summary names every slide where that replaced newer text of the user's. `--keep-mine` keeps theirs on those slides.
- A Review copy holds one version and no notes. `sb import` puts the user's notes back and keeps the facilitator slides it left out where they were. A slide the deck file rewrote since the copy was made is "not brought back" and named: tell the user, and redo that edit by hand if they want it.
- It refuses a file that isn't this deck and says why.
- Reply to the reviewer's comments on the slides like the user's. Their edits bake in like the user's, but name them in the chat summary so the user sees what the reviewer changed.

## Watch mode ("watch my decks")

When the user asks you to watch (their decks, or one deck), they want to start each round from the deck instead of typing to you:

1. Run `./sb watch` in the background (in Claude Code, a Bash command with run_in_background). With no deck named it watches every deck; `./sb watch <deck>` watches one. It waits until the user clicks **Process now** (or presses ⌘⇧↵) in a deck, then exits with a line naming that deck. While it runs, every watched deck's Ask Claude button reads Process now.
2. When it exits with that line, run a full round for the deck it names, exactly as for "process changes".
3. When the round is done, start the same `./sb watch` command in the background again, and say in one line that you're watching.

Keep going until the user says to stop; then don't start it again. A click that comes in during a round waits on the server, and the next `sb watch` returns with it right away. If `sb watch` exits with an error, say so instead of restarting it.

## The deck file

- One self-contained HTML file per deck, with three parts you edit:
  - content: `LIBRARY` entries (`'id': { cat, layout, title, …, notes }`), grouped into parts by `cat` (the parts are `CATS`, named in `CAT_LABELS`)
  - figures: `FIGS` functions returning inline SVG
  - versions: `PITCHES` (each a name and a list of slide ids)
- The default version is LIBRARY order within each part. To reorder, move LIBRARY entries. A saved order that equals an old default follows the file.
- Retire a slide with `alt:true` (it goes to the Sorter's shelf), and put its replacement just before it. Don't delete the user's slides. When you'd change a slide nobody asked you to change, or offer another take on one they did, propose it instead (below).
- A source line goes in the footer via `src:'Source: …'`, not a subtitle.

### Proposing a slide

A proposal is your alternative to one of the user's slides (a redraw, another layout, a tighter version), shown next to it for them to accept or not.
- Write it as its own LIBRARY entry right after the original, in the same part (`cat`): `'<id>-2': { cat, layout, …, prop: true, replaces: '<original id>', title, notes }`. Write it as a plain `{ … }` object (not through a helper), so the bake can edit it. Leave the original exactly as it is.
- Start its notes with what's different, so the reviewer can judge it from the right bar: "Proposed redraw, same idea and words: …".
- To offer several options for one slide, write each as its own proposal with the same `replaces`, one after another, and say in each one's notes how it differs. The reviewer flips through them and accepts one (the others go) or keeps the original. Offer options when the choice is real (two different drawings); otherwise make one proposal.
- An original that is an extra (`alt:true`) can have a proposal too; give the proposal `alt:true` as well, and it shows in the version that carries the extras.
- The reviewer decides in the deck (Accept, Keep original, or a comment on the proposal). A comment on a proposal asks for a change to it: change the proposal in place, keep `prop` and `replaces`, and reply as usual. Never accept or reject one yourself.

Decisions come back through `./sb proposals <deck>`: each decided proposal with how it was decided (Accept or Keep original clicked, or slides taken out of a version by hand), then the undecided ones. Options show as "option 2 of 3"; the ones that lost to the accepted option show as REJECT. `./sb proposals <deck> --bake` writes the decided ones into the deck file:
- **Accept:** the original gets `alt:true` (it moves to the shelf), the proposal loses `prop` and `replaces`, and every version that lists slides by hand (PITCHES blocks) lists the proposal in the original's place. Versions built from the parts follow on their own.
- **Keep original** (and an option that lost to another): the proposal's LIBRARY entry is deleted (git keeps it) and leaves every hand-made list. If it printed that a figure in FIGS drew only that slide, delete the figure too.
- **Two options of one slide accepted** (from two versions, say): the bake leaves that slide alone and says NOT BAKED. Ask which one.
- It then loads the deck to check every decision landed in every version and nothing broke, and puts the file back if not. A line that says NOT BAKED, or a put-back, means do that one by hand with the rules above, then run `./sb proposals <deck> --bake` again: it sees the ones you did by hand and records them for the round.
- It refuses to run until the server knows about proposals (after an update, restart it).
- A kept proposal that still has a comment on it: reply `skipped`, saying the original was kept.
- When a comment gives raw data for a chart or a 2x2, rebuild the slide from the numbers rather than by eye, and say the range and source in the source line. The consulting template's 2x2 is a converted slide: its shapes live in the deck's `ct-slides.js`, under the slide's key (`sp6`). The plot area runs x 105 to 661 and y 131 to 477 on the 1000-wide slide. The quadrant lines sit at x 383 and y 304, so put the bar each axis must clear there and scale each half out to the end of the range. Each dot is a 20 px box placed so its center lands on the option's two scores (higher is right and up), and its label box sits at the dot's x + 23 and y − 2. Dots in the recommended quadrant take the accent color and the rest are gray. If a label would run past the plot's right edge, put it on the dot's left instead: its x is the dot's x − 3 − the label's width, with `align: 'r'`. Add or drop dot-and-label pairs to match the options, and update the count in the callout.
- Colors, title font, and logo: a `<style id="deck-theme">` block in the deck file, and `LOGO` for the deck's logo in `img/`. Restyle by editing that block, not individual slides. Without `LOGO`, slides have no logo.
- In that block, the text and surface colors (`--ink`, `--text`, `--text-light`, `--text-mute`, `--title-red`, `--paper`, `--light`, `--white`, `--line`) go on `.slide, .slide-frame`, never on `:root`. The editor around the slides (the sidebar, the title above them, the slide numbers, the ↑ ↓ × buttons, the comment boxes, the Sorter) sits on light backgrounds, and in decks made with an older engine it takes its colors from `:root`: a dark deck's light text turns it pale. Accent and fill colors (`--red`, `--red-deep`, `--maroon`, `--maroon-deep`, `--char`, `--accent`) can stay on `:root`. The built-in Dark theme in `newdeck.py` (its `slide` colors) is the pattern to follow.
- Big visual changes (a new layout, a redesign): show the user a mockup or two options first, then build.
- When the user wants a file to send someone, that is the Share menu's **Client copy**: the version on screen as slides only (no notes, comments, facilitator slides, other versions, or editing), pictures inside, with a Present button. **Editable copy** is the whole deck with notes and comments: never send that one to a client.
- Decks come off the dashboard with `./sb hide <deck>` (back with `./sb show`). `./sb delete <deck> --yes` moves a deck this app made to the Trash and only unregisters a deck in a folder of the user's own. Only delete when the user asks.
- Downloading images or logos needs the user's OK each time. Tell them the filename, source, size, and license, and put the credit in the footer.

## The method

Decks is built on the method Paul Millerd teaches at StrategyU. Apply it to every slide you write or fix. If the `strategy-slides` skill is installed, it has the full version: use it for storylines, titles, and feedback.

**Answer first.** Lead with the recommendation, then the context, then the evidence. Build up to the recommendation (situation and complication, then the key ideas) only for a skeptical audience.

**Ghost deck first.** Before you build any slide body, write every action title in order and read them as one paragraph. If the paragraph doesn't make the argument, fix the titles or the order now; it's the cheapest point to fix the story. Note what each body must show to prove its title.

**Vertical flow: the title is the takeaway, and the body proves it.**
- Every title is an action title: a full sentence that says the point. "Q3 revenue grew 22%, driven by enterprise expansion", never "Q3 Revenue".
- Push past vague titles. "The company is improving" is step one; "Profitability increased for the first time in 5 years due to supply chain investments" is where to end up.
- No "key takeaway" boxes or summary strips at the bottom. The insight leads the page.
- Use plain verbs with their natural objects. Don't personify data or force metaphors onto numbers. No comma-pivot fragments ("One mode of thinking, when the work needs two"). Two lines at most. Read it out loud: it should sound like something a person would say to a colleague.
- Count-only titles are blank. "Three risks and how we cover them" becomes the finding: "The real exposure is West Coast service, not warehouse capacity."
- Covers, section dividers, and the appendix divider are exempt. The closing slide isn't: "Approve by March 14 and we exit both leases before they renew", not "Next steps".

**Horizontal flow: the titles alone tell the story.** Read them in order (Checks › Horizontal flow). If they don't make sense without the slide bodies, fix the titles or the order.

**One idea per slide.** If a slide needs "and also", it needs to be two slides.

**The five- and ten-second tests are about legibility.** A presented slide gets its one point across in five seconds. A slide people read can be taken in within ten: one main point, a readable hierarchy, a chart whose shape reads without study. Walls of text, a key number buried in a dense table, and several unrelated ideas on one slide all fail.

**"So what?" is a separate test.** Three tidy boxes reading Innovation, Excellence, Growth pass the ten-second test and fail "so what?" (pretty slide syndrome). Every slide tells the audience what to think. Keep the two findings separate when you give feedback.

**Charts prove the title.** Write the message before you draw the chart. Bars, columns, and lines cover almost everything; never use a pie chart. The number that matters is the most prominent mark, anything the title names (a recession, an inflection point) is marked on the chart, and whatever doesn't support the title goes. Uncertain data gets an "Illustrative" label and a note on the assumptions.

**The executive summary is the most important slide:** the recommendation as its title, and three insights with a line of evidence each. Use section dividers only in long decks (20+ slides) with distinct sections.

**Presented or read.** Presented: under 20 words in the body, one idea, large visuals. Read: more text is fine, with bold lead words, and every slide stands on its own because it will be forwarded.

**Giving feedback on a deck.** Read the whole deck first. Then give, in order: the story (the titles in sequence, what they say, and what's missing or out of order); the slides that have a problem, with the fix (write the new title when the title is the problem); and the three changes that matter most, with the argument and the order before fonts and colors. If the argument doesn't hold, say that first. Check every slide number before you cite it.

**Writing.** Active verbs, contractions, and numbers rather than adjectives. Never: delve, landscape, leverage, utilize, crucial, pivotal, robust, seamless, transformative, underscore, additionally, moreover, furthermore. One em dash per slide at most.

**Custom layouts.** Give every slide's title the class `h-title` (or make it an `h2`), even inside a column or panel, so Checks, Titles only, and `sb audit` find it.

## Slide style rules

On top of the method:

- No small, muted, or italic lines at the bottom of cards or boxes. Fold anything important into the item it belongs to.
- No grids of identical cards. Draw the relationship instead: a process, spectrum, ladder, chart, or map.
- Instructions are one plain sentence. Reflection questions are plain and about the audience's own work.
- Agenda times in round 5-minute blocks.
- Use the user's own material, diagrams, and wording before inventing frameworks. When cutting, cut invented slides first, and keep builds and setup/payoff pairs whole.
- Mark text you drafted in the notes, so the user can replace it.
- Quotes and numbers come only from sources you opened in the session, quoted exactly and attributed to who actually said them.
- Everything passes Checks › Guides: the protected border, two-line titles, nothing under 12 px, at most four text sizes on a slide. These are guidelines, not rules; fix what `sb audit` lists, or say why a slide is an exception.

## Starting a new deck

The user starts decks from the dashboard's **New deck** form, in three steps. Step 1: a name, what they're building (a presentation, a training, a talk, a proposal, or a blank deck), and the pieces to build alongside it. Step 2: who it's for, what they know and care about, the one point, and optional length, kind of audience, structure, density, and notes. Step 3: colors, title font, and logo. (Step 1 also offers **Import a deck**, for a deck they already have: see Importing a deck below.) Create deck makes the folder, gives it its own storage prefix, adds it to `decks.json`, starts its git history, writes the brief to `BRIEF.md`, copies a prompt to their clipboard, and opens the deck. When they paste that prompt:

1. Read `BRIEF.md` in the deck folder and shape the template to it before writing slides. The template is a starting point, not a fixed form:
   - **How it will be used.** Presented: one idea per slide, big type, little text; it must pass the 5-second test. Sent to read: each slide stands on its own with a fuller body; it must pass the 10-second test. Presented, then sent: presentable slides, with the detail in the notes or an appendix.
   - **Audience and what they know.** Pitch the vocabulary, the examples, and how much you explain; executives get the answer first.
   - **Structure.** Answer first: the recommendation, then the reasons. Situation, complication, resolution: in that order. A story in a few parts: sections with dividers. Teach, practice, reflect: modules with exercises and reflection questions.
   - **Density.** Sparse, balanced, or detailed, as the words say.
   - Anything left blank is your call. Say what you chose in the chat summary.
   - **Pieces** (`## What to build` in BRIEF.md). Each piece is a version in the same deck file (the version menu), so pieces share slides. The first is the main deck: build it first, then derive the others from it. A piece other than the main one starts as one placeholder slide (`only:true, in:['<piece>']`); replace it. A slide that belongs only to a piece gets `only:true, in:['<piece>']`; a main-deck slide that also belongs in a piece adds the piece to `in`.
     - Presentation: **Final presentation** reads on its own (full story, evidence, sources). **Live presentation**: the same story with fewer words, built to present. **CEO deck**: the same story in five or six slides, answer first. **Check-in doc**: a progress update partway through (what we set out to answer, what we've learned, what's next, open questions).
     - Training: **Training content** is what's projected. **Facilitator pack** is the facilitator version (the agenda plus `fac:true` slides: run sheet, timings, notes). **Participant pack**: handouts and exercises to print.
     - Talk: **Leave-behind** is a fuller version to send afterward. Proposal: **Short version** is a few slides for the decision maker.
   - Length follows the kind: trainings in hours or days, talks in minutes, presentations and proposals in slides.
2. Build the first draft in the deck file (replace the template's placeholder slides; keep its layouts where they fit).
3. Follow the round steps from 6 on: shots, audit, export, `sb round`, commit.

When the user asks in chat instead, run `./sb new "<name>" --template <id>` with whatever brief they gave (`--audience`, `--audience-type`, `--knows`, `--use`, `--length`, `--point`, `--structure`, `--density`, `--style`, `--notes`; `./sb templates` lists the templates), then build as above.

- Templates live in `templates/<id>/` (`template.json`, `content.js`, `pitches.js`, assets). They fill the engine `templates/_engine/engine.html`.
- `consulting` (a presentation: a guided eight-slide storyline), `workshop` (a training), `talk`, `proposal`, and `blank`. Every new deck also carries the basic guided layouts in `templates/_engine/basics.js` (big number, points, two columns, process, table, quotes, divider, question, exercise) for Add a slide. Dividers show "Part N of M" with every part along the bottom; give each divider a `short` label.
- `templates/_import` is the hidden template Import a deck starts from: the `ct()` helper for converted slides, an empty `ct-slides.js`, and one placeholder slide between the `IMPORTED SLIDES` lines.

## Importing a deck

The user brings in a deck they already have with **Import a deck** (in New deck), or you run `./sb new "<name>" --from <file.pptx|file.pdf>`. Add `--rebuild` for a rebuild, with `--style` and `--titles` if they gave them. This is not `sb import`, which brings a returned Review copy back in.

It takes a PowerPoint file (.pptx) or a PDF. From Keynote: File › Export To › PowerPoint. From Google Slides: File › Download › Microsoft PowerPoint. An old .ppt: open it in PowerPoint and save it as .pptx. The deck folder gets the file in `source/`, a placeholder slide, and `BRIEF.md` with the steps for this deck, and the user gets a prompt to paste. BRIEF.md says which of two ways the user picked:

- **Keep its look**: every slide converted as it is, so every word on it is editable, with its speaker notes. Rewrite nothing; the user reviews it first.
- **Rebuild it**: the same slides in the same order, with the user's words and speaker notes, laid out in Decks' own layouts and the color set they picked.

**Before you start.** Work from the app folder. `python3 tools/importdeck.py --check` says whether python-pptx, lxml, Pillow, and PyMuPDF are installed, and whether LibreOffice is. If packages are missing, ask the user before installing them: `python3 -m pip install python-pptx lxml Pillow PyMuPDF`.

**A PDF of the deck.** For a PowerPoint file, the converter cuts charts, SmartArt, and icons out of a PDF of each slide, and the PDF gives each slide a picture of the original to compare with (`img/imp-NNN.jpg`, and the slide's "original" button in the deck). `importdeck.py` uses a PDF in `source/` if there is one, or makes one with LibreOffice when it's installed. Otherwise ask the user to export one into the deck's `source/` folder: in PowerPoint, File › Export › PDF; in Keynote, File › Export To › PDF; in Google Slides, File › Download › PDF. If they can't, `--no-pdf` brings in every word, box, line, table, and picture and leaves out charts, SmartArt, and icons: tell them that. PowerPoint leaves hidden slides out of its PDF, and the tool matches the pages to the slides that show.

**Keep its look.**
1. `python3 tools/importdeck.py <deck>` converts every slide with `tools/pptx2native.py`. Each slide's shapes go into `ct-slides.js` (`CT.s1`, `CT.s2`, …) and its pictures into `img/`. The slides go into the deck file between the `IMPORTED SLIDES` lines, one `ct('s7', part, title, { src, notes })` per slide, in order:
   - PowerPoint sections become parts (`CATS`), and hidden slides go on the shelf (`alt:true`).
   - The speaker notes become each slide's notes.
   - The title is the title placeholder's text, or the biggest words near the top. A slide with neither is named "Slide N".
   - A slide whose background is a photo or a gradient keeps it as a picture under the editable shapes. A deck of another size or shape (Google Slides' 10-inch slides, an old 4:3 deck) is scaled onto the slide.
2. It prints what came in: how many slides are editable, which came in as a picture of the original and why, how many have notes, and which have no title.
3. A PDF on its own also keeps its look. Each page is drawn without its words, and the words go back on top as text, one text box per line, at the page's own sizes, weights, and colors. Every word is editable, but a line doesn't rewrap as it grows, and a PDF has no speaker notes.
4. Check it. `./sb shot <deck> <ids>` for the first and last slides and every slide with a chart, table, photo, or diagram, and compare each with its `img/imp-NNN.jpg`. Converted text is drawn in the deck's font, so a line can break in a slightly different place. Then `./sb audit <deck>`, and fix text that is cut off or runs off the slide. Its Guides lines (text in the footer, close to the edge) describe the original's layout: list them in your report, but don't move things in a keep-look import.
5. Fix what's off in `ct-slides.js` (a shape's `x`, `y`, `w`, `h`, or its text runs) or in the slide's LIBRARY entry (`title`, `notes`). Give each "Slide N" a title made of the words on that slide.
6. Running it again replaces the imported slides, so once the deck has changed it stops unless you add `--force` (git keeps the old version). `--slides 3-9 --no-wire` converts a few slides again into `ct-slides.js` and `img/` only.
7. `./sb export <deck>`, then `./sb commit <deck> "Imported from <file>"`. Tell the user how many slides came in editable, which came in as pictures and why, the titles you added, and anything that looks different from the original.

A keep-look import has no color set or logo of its own: its slides bring theirs. The `deck-theme` block still styles any slide the user adds from Add a slide.

**Rebuild it.**
1. `python3 tools/importdeck.py <deck> --outline` writes `source/outline.md`: each slide's title, its words in reading order (indented by bullet level), its tables, the numbers behind its charts, and its speaker notes. With a PDF, a picture of each slide goes into `source/pages/`.
2. Replace the placeholder slide with one LIBRARY entry per slide, in the same order. Use the engine's layouts and the basic layouts from Add a slide that the deck already carries (points, two columns, process, table, big number, quotes, divider, question).
3. Keep the user's words: cut nothing and paraphrase nothing. When a slide holds more than its layout fits, split it into two slides or move the detail into the notes, and say which. Speaker notes go in `notes`. Each section of the file becomes a part (`CATS`), with a divider when the deck is long.
4. Rebuild a chart from its numbers in the outline as a `FIGS` figure, following the method (bars, columns, or lines; no pies). A slide that can't be rebuilt well, like a dense diagram or a photo collage, can stay as it was: `python3 tools/importdeck.py <deck> --slides 7 --no-wire` converts it into `ct-slides.js` (it needs the PDF), and `ct('s7', part, title, { notes })` puts it in LIBRARY.
5. Keep the user's titles. Where one is a label ("Q3 revenue") rather than a sentence, suggest an action title in that slide's notes instead of changing it.
6. Check it: `./sb shot` against the pictures in `source/pages/`, and `./sb audit`. Everything passes Checks › Guides.
7. `./sb export`, `./sb commit <deck> "Rebuilt from <file>"`, and tell the user which layouts the slides went into, what you split or moved to the notes, any slide you kept as it was, and the titles you'd change.
