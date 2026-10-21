# Decks: instructions for coding agents

This folder is Decks: HTML slide decks reviewed in the browser, where the
user comments under each slide and you edit the deck file and reply on the slide.

For any deck work ("process changes", "read my feedback", a pasted "Ask Claude" prompt
from a deck, a new deck, a PDF), read and follow
`.claude/skills/decks/SKILL.md`. It has the round procedure, the `sb` commands,
how a deck file is organized, and the slide style rules.

Every slide follows the method in that file: action titles, vertical and horizontal flow, the
five- and ten-second tests, and charts that prove the title.

If a pasted prompt says "Import … into Decks", follow Importing a deck in that file: BRIEF.md in
the deck folder has the steps, and `tools/importdeck.py` does the conversion. Ask before
installing its Python packages.

If the user says "watch my decks", follow Watch mode in that file: `./sb watch` in the background (every deck), a round
for the deck it names each time it returns, then watch again.

Quick reference:

- Start the server if it isn't running: `python3 server.py` (port 8790 unless
  `config.json` or `SB_PORT` says otherwise).
- `./sb decks`, `./sb comments <deck>`, `./sb edits <deck>`: what to act on.
- `./sb proposals <deck> [--bake | --fix-placement]`: decisions on proposed slides (`prop:true, replaces:'id'`), after a line for any proposal that won't show where its original shows; `--fix-placement` files those right after their original, `--bake` writes the decisions into the deck file. `sb audit` names misfiled proposals too, and `sb round` refuses while one exists (`--force` records it anyway).
- `./sb reply <deck> <slide> done|question|skipped "<text>"`: answer on the slide.
- `./sb shot`, `./sb audit`, `./sb export`, `./sb round`, `./sb commit`: check and finish.

Working on Decks itself (not a deck):

- `server.py` and `sb` use only the Python standard library. Keep it that way.
- `tools/browser.mjs` needs `playwright-core` (`./setup.sh` installs it).
- `tools/importdeck.py` and `tools/pptx2native.py` (Import a deck) need python-pptx, lxml,
  Pillow, and PyMuPDF. The server never imports them.
- Check a change by starting the server on a spare port with a scratch decks folder,
  `SB_PORT=8799 SB_DECKS_DIR=/tmp/sb-test python3 server.py`, then `sb new` a deck from
  each template and run `sb audit` and `sb export` on it.
