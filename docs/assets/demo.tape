# The README demo. Run it from the repo root: vhs docs/assets/demo.tape
# It needs vhs, a logged-in `claude` (2.1.290 or later) and costs a few cents of tokens: the session runs on
# `haiku`, the default watchdog reviews on `opus`. The note the watchdog sends differs from run to run.
# FontSize 14 keeps the band (its divider and count line, one row for each card, and the expanded note below its card)
# readable beside the transcript.
# The committed GIF is re-encoded at 8 frames a second and 40 colors to stay under 2 MB (about 29 s, 1.6 MB):
#   ffmpeg -i demo.gif -vf "fps=8,split[a][b];[a]palettegen=max_colors=40:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" out.gif

Output docs/assets/demo.gif
Require claude

Set Shell bash
Set Width 1200
Set Height 700
Set FontSize 14
Set Padding 16
Set Theme "GitHub Dark"
Set Framerate 15
Set TypingSpeed 30ms

# A throwaway project with a planted bug (apply_discount subtracts the percent as an amount), and a copy of the
# plugin, so the engine writes its generated types there and not in this repo.
Hide
Type@5ms `unset NO_COLOR CI CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT ANTHROPIC_BASE_URL CLAUDE_WATCHDOG; export TERM=xterm-256color CLAUDE_CODE_NO_FLICKER=1 DISABLE_AUTOUPDATER=1`
Enter
Type@5ms `DEMO="$(mktemp -d /tmp/watchdog-demo.XXXXXX)" && cp -R plugins/watchdog "$DEMO/watchdog" && mkdir "$DEMO/shop" && cd "$DEMO/shop"`
Enter
Type@5ms `printf 'def apply_discount(price, percent):\n    """Return the price after a percent discount."""\n    return price - percent\n\n\ndef line_total(price, quantity):\n    return price * quantity\n' > cart.py`
Enter
Type@5ms `clear && claude --plugin-dir ../watchdog --setting-sources project,local --model haiku --permission-mode acceptEdits --disallowedTools Bash`
Enter
# A new folder: answer the trust dialog with "Yes, I trust this folder".
Wait+Screen@60s /trust this folder/
Sleep 1s
Down
Sleep 500ms
Enter
Wait+Screen@60s /for agents|for shortcuts/
Sleep 1s
Show

Sleep 1s
Type "/watchdog on"
Sleep 800ms
Enter
Sleep 2s
Type@25ms "Add cart_total(items, percent) to cart.py: sum line_total over the (price, quantity) pairs, then take the percent off with apply_discount."
Sleep 500ms
Enter

# Skip the agent's thinking: show its edit.
Hide
Wait+Screen@90s /(Update|Write)\(cart\.py\)/
Sleep 500ms
Show
Sleep 3s

# Skip the wait for the review. The band's count line ends with the focus hint once a card shows.
Hide
Wait+Screen@240s /ctrl\+x tab/
Sleep 1s
Show
Sleep 3s

# Skip to the delivery: the nudge prompt that starts a turn, or the state a note keeps without one. Once Claude fixed
# the bug, a later review may retract the note, so the card opens while that turn runs: the band keeps the focus
# through a plugin prompt and a running turn (live check on 2.1.292).
Hide
Wait+Screen@120s /Prompt from the watchdog plugin|\((steered|held|aside on next prompt)\)/
Sleep 500ms
Show
Sleep 1s
# Focus the band, expand the top card with its letter, collapse it.
Ctrl+X
Tab
Sleep 800ms
Type "a"
Wait+Screen@10s /▾/
Sleep 4s
Type "a"
Wait+Screen@10s /▸/
Sleep 1s

# Skip to the end of the turn: while the agent works, "esc to interrupt" stands before "← for agents". At the idle
# prompt Esc gives the focus back to the prompt; an Esc that reaches the prompt does nothing.
Hide
Wait+Screen@180s /(cycle\)|subagents) · ←/
Sleep 500ms
Show
Sleep 1s
Escape
Sleep 800ms
Type "/watchdog status"
Sleep 800ms
Enter
Wait+Screen@20s / tok · /
Sleep 5s

Hide
Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 3s
Type@5ms `cd / && rm -rf "$DEMO"`
Enter
Sleep 500ms
