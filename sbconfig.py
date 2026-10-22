"""Where Decks keeps your decks, and which port it serves them on.

Settings come from, in order (later wins):

  1. defaults: port 8790, host 127.0.0.1, decks in ~/slide-decks
  2. config.json next to this file, or the file named by SB_CONFIG
  3. environment: SB_PORT, SB_HOST, SB_DECKS_DIR, SB_CHECK_UPDATES, SB_COUNT_VERSION

    { "port": 8790, "host": "127.0.0.1", "decks_dir": "~/slide-decks", "check_updates": true, "count_version": true }

check_updates: every six hours the server asks GitHub which release of Decks is newest (and
again within minutes if it couldn't reach GitHub), so the dashboard and the deck's ? can say
when there's a new version. Set it to false (or SB_CHECK_UPDATES=0) to
turn that off. The Check for updates button (dashboard footer, and ? in a deck) still asks
GitHub when you click it.

count_version: once a day, one of those checks goes to strategyu.co instead of GitHub and says
which version of Decks this is, so StrategyU can count how many copies run each version. Only
the version number is kept: no IP address, no ID, nothing about your decks. Set it to false
(or SB_COUNT_VERSION=0) and every check goes to GitHub. With check_updates off, nothing is sent.

The deck registry (decks.json) and settings.json live in the decks folder, next to
the decks themselves, so the app folder never holds your work. Command line tools
(sb, tools/browser.mjs) find the server at SB_URL, or at http://localhost:<port>.
"""
import json
import os
from pathlib import Path

APP = Path(__file__).resolve().parent
DEFAULTS = {'port': 8790, 'host': '127.0.0.1', 'decks_dir': '~/slide-decks', 'check_updates': True, 'count_version': True}
ENV = {'port': 'SB_PORT', 'host': 'SB_HOST', 'decks_dir': 'SB_DECKS_DIR', 'check_updates': 'SB_CHECK_UPDATES', 'count_version': 'SB_COUNT_VERSION'}


def load():
    cfg = dict(DEFAULTS)
    path = Path(os.environ.get('SB_CONFIG') or APP / 'config.json').expanduser()
    if path.is_file():
        with open(path, encoding='utf-8') as f:
            cfg.update({k: v for k, v in json.load(f).items() if k in DEFAULTS and v not in (None, '')})
    for key, var in ENV.items():
        if os.environ.get(var):
            cfg[key] = os.environ[var]
    cfg['port'] = int(cfg['port'])
    for key in ('check_updates', 'count_version'):
        cfg[key] = str(cfg[key]).strip().lower() not in ('0', 'false', 'no', 'off')
    cfg['decks_dir'] = Path(os.path.expanduser(str(cfg['decks_dir']))).resolve()
    return cfg


CONFIG = load()
PORT = CONFIG['port']          # the server sets this to the port it actually listens on
HOST = CONFIG['host']
DECKS = CONFIG['decks_dir']
REGISTRY = DECKS / 'decks.json'
SETTINGS = DECKS / 'settings.json'
CHECK_UPDATES = CONFIG['check_updates']
COUNT_VERSION = CONFIG['count_version']


def url():
    return (os.environ.get('SB_URL') or f'http://localhost:{PORT}').rstrip('/')


def tilde(path):
    """A path as written in decks.json: ~/... under the home folder, absolute otherwise."""
    path = Path(path).resolve()
    try:
        return '~/' + str(path.relative_to(Path.home()))
    except ValueError:
        return str(path)
